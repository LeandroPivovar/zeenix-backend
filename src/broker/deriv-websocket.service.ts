import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface TickData {
  value: number;
  epoch: number;
}

interface ProposalData {
  id: string;
  askPrice: number;
  payout: number;
  spot: number;
  dateStart: number;
}

interface TradeData {
  contractId: string;
  buyPrice: number;
  payout: number;
  symbol: string;
  contractType: string;
  duration: number;
  durationUnit: string;
  entrySpot?: number | null;
  entryTime?: number | null;
  barrier?: number | null;
}

/**
 * Interface para estado de conexão único
 */
interface ConnectionState {
  ws: WebSocket | null;
  isAuthorized: boolean;
  token: string;
  loginid: string | null;
  reconnectAttempts: number;
  isReconnecting: boolean;
  reconnectTimeout: NodeJS.Timeout | null;
  pendingRequests: Map<string, any>;
  // Subscriptions do usuário
  tickSubscriptionId: string | null;
  proposalSubscriptionId: string | null;
  openContractSubscriptionId: string | null;
  pendingBuyConfig: { durationUnit?: string; duration?: number; contractType?: string; barrier?: number } | null;
}

@Injectable()
export class DerivWebSocketService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(DerivWebSocketService.name);

  // ✅ Estado único por serviço (Uma conexão por usuário)
  private state: ConnectionState = {
    ws: null,
    isAuthorized: false,
    token: '',
    loginid: null,
    reconnectAttempts: 0,
    isReconnecting: false,
    reconnectTimeout: null,
    pendingRequests: new Map(),
    tickSubscriptionId: null,
    proposalSubscriptionId: null,
    openContractSubscriptionId: null,
    pendingBuyConfig: null
  };

  private appId: number;
  private symbol: string = 'R_100';
  private ticks: TickData[] = [];
  private readonly maxTicks = 300; // 5 minutos de ticks
  private maxReconnectAttempts = 10;

  constructor() {
    super();
    this.appId = Number(process.env.DERIV_APP_ID || 1089);
  }

  /**
   * Conecta ou reutiliza uma conexão existente
   */
  async connect(token: string, loginid?: string): Promise<boolean> {
    if (!token) {
      throw new Error('Token é obrigatório para conexão.');
    }

    // Se já estiver conectado com o mesmo token e loginid, reutilizar
    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN && this.state.isAuthorized) {
      if (this.state.token === token && (!loginid || this.state.loginid === loginid)) {
        this.logger.log(`[DerivWS] ✅ Reutilizando conexão existente (Login: ${this.state.loginid})`);
        return true;
      }

      // Se mudou o token ou loginid, ou houver conflito, desconectar e reconectar
      this.logger.warn(`[DerivWS] 🔄 Mudança de contexto ou reforço solicitado. Login original: ${this.state.loginid}, Novo: ${loginid}`);
      this.disconnect();
    }

    // Criar nova conexão
    this.state.token = token;
    this.state.loginid = loginid || null;
    return this.establishConnection();
  }

  private establishConnection(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.logger.log(`[DerivWS] Conectando WebSocket: ${url}`);

      const ws = new WebSocket(url, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      this.state.ws = ws;

      let authResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          authResolved = true;
          try {
            this.state.ws?.close();
          } catch (e) { }
          reject(new Error('Timeout ao conectar/autorizar com Deriv'));
        }
      }, 15000); // 15s timeout

      ws.on('open', () => {
        this.logger.log(`[DerivWS] WebSocket aberto. Aguardando estabilização...`);
        // Pequeno atraso para garantir que o readyState esteja sincronizado
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            this.logger.log(`[DerivWS] Enviando Authorize...`);
            try {
              ws.send(JSON.stringify({ authorize: this.state.token }));
            } catch (error) {
              this.logger.error(`[DerivWS] ❌ Erro ao enviar Authorize: ${error.message}`);
              if (connectionTimeout) clearTimeout(connectionTimeout);
              reject(new Error(`Falha ao enviar autorização: ${error.message}`));
            }
          } else {
            this.logger.error(`[DerivWS] ❌ WS fechou prematuramente após open. Estado: ${ws.readyState}`);
            if (connectionTimeout) clearTimeout(connectionTimeout);
            reject(new Error('WebSocket fechou prematuramente após abertura'));
          }
        }, 100);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            if (msg.error.code !== 'AlreadySubscribed') {
              this.logger.error(`[DerivWS] Erro API Deriv:`, msg.error);
              this.emit('error', msg.error);
            }
          }

          if (msg.msg_type === 'authorize') {
            if (!msg.error) {
              if (connectionTimeout) clearTimeout(connectionTimeout);
              authResolved = true;
              this.state.isAuthorized = true;
              this.state.reconnectAttempts = 0;
              this.state.loginid = msg.authorize.loginid;
              this.logger.log(`[DerivWS] ✅ Autorizado! Conta: ${this.state.loginid} (${msg.authorize.currency})`);
              this.emit('authorized', msg.authorize);
              resolve(true);
            } else {
              if (connectionTimeout) clearTimeout(connectionTimeout);
              authResolved = true;
              const errorMsg = msg.error.message || 'Erro de autorização';

              // Se for erro de App ID, logar com destaque
              if (errorMsg.includes('app ID') || msg.error.code === 'AppIdInvalid') {
                this.logger.error(`[DerivWS] ❌ O Token fornecido não é válido para o APP_ID atual (${this.appId}). É necessário re-autenticar a conta.`);
              } else {
                this.logger.error(`[DerivWS] ❌ Falha na autorização: ${errorMsg}`);
              }

              reject(new Error(errorMsg));
              this.disconnect();
            }
          }

          this.handleMessage(msg);
        } catch (error) {
          this.logger.error(`[DerivWS] Erro ao processar mensagem:`, error);
        }
      });

      ws.on('error', (error) => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        this.logger.error(`[DerivWS] ❌ Erro WebSocket:`, error);
        reject(error);
      });

      ws.on('close', () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        this.logger.warn(`[DerivWS] 🔌 WebSocket fechado.`);
        this.state.isAuthorized = false;
        this.state.ws = null;

        // Se ainda estiver na fase de conexão inicial, rejeitar a promise
        if (!authResolved) {
          authResolved = true;
          reject(new Error('Conexão fechada antes da autorização'));
        } else {
          this.attemptReconnect();
        }
      });
    });
  }

  private handleMessage(msg: any): void {
    switch (msg.msg_type) {
      case 'history':
        this.processHistory(msg);
        break;
      case 'tick':
        this.processTick(msg);
        break;
      case 'proposal':
        this.processProposal(msg);
        break;
      case 'buy':
        this.processBuy(msg);
        break;
      case 'sell':
        this.processSell(msg);
        break;
      case 'contract':
      case 'proposal_open_contract':
        this.processProposalOpenContract(msg);
        break;
      case 'contracts_for':
        this.emit('contracts_for', msg.contracts_for);
        break;
      case 'trading_durations':
        this.emit('trading_durations', msg.trading_durations);
        break;
      case 'active_symbols':
        this.emit('active_symbols', msg.active_symbols);
        break;
    }
  }

  private processHistory(msg: any): void {
    const history = msg.history;
    if (!history || !history.prices) return;

    const prices = history.prices;
    const times = history.times;
    const newTicks: TickData[] = [];
    const startIdx = Math.max(0, prices.length - this.maxTicks);

    for (let i = startIdx; i < prices.length; i++) {
      newTicks.push({ value: Number(prices[i]), epoch: Number(times[i]) });
    }

    this.ticks = newTicks;
    if (msg.subscription?.id) {
      this.state.tickSubscriptionId = msg.subscription.id;
    }
    this.emit('history', { ticks: this.ticks, subscriptionId: this.state.tickSubscriptionId });
  }

  private processTick(msg: any): void {
    const tick = msg.tick;
    if (!tick) return;

    const value = Number(tick.quote);
    const epoch = Number(tick.epoch);

    if (tick.id && !this.state.tickSubscriptionId) {
      this.state.tickSubscriptionId = tick.id;
    }

    this.ticks.push({ value, epoch });
    if (this.ticks.length > this.maxTicks) this.ticks.shift();

    this.emit('tick', { value, epoch });
  }

  private processProposal(msg: any): void {
    const proposal = msg.proposal;
    if (!proposal || !proposal.id) return;

    const proposalData: ProposalData = {
      id: proposal.id,
      askPrice: Number(proposal.ask_price) || 0,
      payout: Number(proposal.payout) || 0,
      spot: Number(proposal.spot) || 0,
      dateStart: Number(proposal.date_start) || 0,
    };

    if (msg.subscription?.id) {
      this.state.proposalSubscriptionId = msg.subscription.id;
    }

    this.emit('proposal', proposalData);
  }

  private processBuy(msg: any): void {
    const buy = msg.buy;
    if (!buy || !buy.contract_id) return;

    const config = this.state.pendingBuyConfig;
    const tradeData: TradeData = {
      contractId: buy.contract_id,
      buyPrice: Number(buy.buy_price) || 0,
      payout: Number(buy.payout) || 0,
      symbol: buy.symbol || this.symbol,
      contractType: config?.contractType || buy.contract_type || 'CALL',
      duration: config?.duration || Number(buy.duration) || 0,
      durationUnit: config?.durationUnit || buy.duration_unit || 'm',
      entrySpot: Number(buy.entry_spot || buy.current_spot || 0),
      entryTime: Number(buy.purchase_time || buy.start_time) || Date.now() / 1000,
      barrier: config?.barrier || Number(buy.barrier) || null,
    };

    this.state.pendingBuyConfig = null;
    this.subscribeToOpenContract(buy.contract_id);
    this.emit('buy', tradeData);
  }

  private processSell(msg: any): void {
    const sell = msg.sell;
    this.emit('sell', {
      contractId: sell.contract_id,
      sellPrice: Number(sell.sell_price),
      profit: Number(sell.profit),
      symbol: this.symbol
    });
  }

  private processProposalOpenContract(msg: any): void {
    const contract = msg.proposal_open_contract || msg.contract;
    if (!contract) return;

    if (msg.subscription?.id) {
      this.state.openContractSubscriptionId = msg.subscription.id;
    }

    this.emit('contract_update', contract);
  }

  private send(payload: any): void {
    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
      try {
        this.state.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.logger.error(`[DerivWS] Erro envio:`, e);
      }
    } else {
      this.logger.warn(`[DerivWS] WS não está aberto para envio.`);
    }
  }

  subscribeToSymbol(symbol: string): void {
    this.symbol = symbol;
    const now = Math.floor(Date.now() / 1000);
    this.send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1000,
      start: now - 600,
      end: 'latest',
      subscribe: 1,
      style: 'ticks'
    });
  }

  buyContract(buyConfig: any): void {
    const { proposalId, price, duration, durationUnit, contractType, barrier } = buyConfig;

    this.state.pendingBuyConfig = { durationUnit, duration, contractType, barrier };

    if (proposalId) {
      this.send({ buy: proposalId, price: Number(price) });
    }
  }

  subscribeToProposal(config: any): void {
    const req: any = {
      proposal: 1,
      amount: config.amount,
      basis: 'stake',
      contract_type: config.contractType,
      currency: 'USD',
      duration: config.duration,
      duration_unit: config.durationUnit,
      symbol: config.symbol,
      subscribe: 1,
    };
    if (config.barrier) req.barrier = String(config.barrier);
    if (config.multiplier) req.multiplier = config.multiplier;

    if (this.state.proposalSubscriptionId) {
      this.send({ forget: this.state.proposalSubscriptionId });
    }

    this.send(req);
  }

  subscribeToOpenContract(contractId: string): void {
    this.send({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1
    });
  }

  getTicks(): TickData[] {
    return [...this.ticks];
  }

  private attemptReconnect(): void {
    if (this.state.isReconnecting || this.state.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.state.isReconnecting = true;
    this.state.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, this.state.reconnectAttempts), 30000);
    this.logger.log(`[DerivWS] Tentando reconectar em ${delay}ms...`);

    this.state.reconnectTimeout = setTimeout(() => {
      this.establishConnection()
        .then(() => { this.state.isReconnecting = false; })
        .catch(() => { this.state.isReconnecting = false; this.attemptReconnect(); });
    }, delay);
  }

  disconnect(): void {
    if (this.state.reconnectTimeout) clearTimeout(this.state.reconnectTimeout);
    if (this.state.ws) {
      this.state.ws.close();
      this.state.ws = null;
    }
    this.state.isAuthorized = false;
    this.ticks = [];
  }

  onModuleDestroy() {
    this.disconnect();
  }

  getActiveSymbols(): void { this.send({ active_symbols: 'brief' }); }
  getTradingDurations(landingCompany: string = 'svg'): void { this.send({ trading_durations: 1, landing_company_short: landingCompany }); }
  getContractsFor(symbol: string, currency: string = 'USD'): void { this.send({ contracts_for: symbol, currency, landing_company: 'svg' }); }
  sellContract(contractId: string, price: number): void { this.send({ sell: contractId, price: price }); }
  cancelSubscription(subscriptionId: string): void { this.send({ forget: subscriptionId }); }
  cancelTickSubscription(): void {
    this.send({ forget_all: 'ticks' });
    this.state.tickSubscriptionId = null;
  }
  cancelProposalSubscription(): void {
    this.send({ forget_all: 'proposal' });
    this.state.proposalSubscriptionId = null;
  }
}
