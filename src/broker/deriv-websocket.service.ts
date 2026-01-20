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
}

/**
 * Interface para estado de conexão isolado
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
  // Subscriptions isoladas por conexão
  tickSubscriptionId: string | null;
  proposalSubscriptionId: string | null;
  openContractSubscriptionId: string | null;
  pendingBuyConfig: { durationUnit?: string; duration?: number; contractType?: string } | null;
}

@Injectable()
export class DerivWebSocketService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(DerivWebSocketService.name);

  // ✅ Pool de conexões: Token -> ConnectionState
  private connections = new Map<string, ConnectionState>();

  // Estado global ou padrão (usado para ticks se não especificado)
  private appId: number;
  private symbol: string = 'R_100';
  private ticks: TickData[] = [];
  private readonly maxTicks = 300; // 5 minutos de ticks
  private maxReconnectAttempts = 10;

  constructor() {
    super();
    this.appId = Number(process.env.DERIV_APP_ID || 111346);
  }

  /**
   * Conecta ou reutiliza uma conexão existente para o token fornecido
   */
  async connect(token: string, loginid?: string): Promise<void> {
    if (!token) {
      throw new Error('Token é obrigatório para conexão.');
    }

    // ✅ 1. Verificar se já existe conexão para este token
    const existingConnection = this.connections.get(token);

    if (existingConnection) {
      if (existingConnection.ws && existingConnection.ws.readyState === WebSocket.OPEN && existingConnection.isAuthorized) {
        this.logger.log(`[DerivWebSocketService] ✅ Reutilizando conexão existente para token ...${token.substring(0, 5)} (Login: ${existingConnection.loginid})`);

        // Validar loginid se fornecido
        if (loginid && existingConnection.loginid && loginid !== existingConnection.loginid) {
          this.logger.warn(`[DerivWebSocketService] ⚠️ ALERTA: Token ...${token.substring(0, 5)} está conectado em ${existingConnection.loginid}, mas foi solicitado para ${loginid}. Possível token duplicado.`);
          // Não lançamos erro aqui para manter compatibilidade, mas logamos forte.
          // A responsabilidade de usar o token certo é do frontend agora.
        }
        return;
      } else {
        // Conexão existe mas caiu/fechou? Reconectar.
        this.logger.log(`[DerivWebSocketService] 🔄 Conexão existente inativa. Reconectando...`);
        return this.establishConnection(token, loginid);
      }
    }

    // ✅ 2. Criar nova conexão isolada
    this.logger.log(`[DerivWebSocketService] 🔌 Criando nova conexão isolada para token ...${token.substring(0, 5)}`);
    return this.establishConnection(token, loginid);
  }

  private establishConnection(token: string, loginid?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Inicializar estado da conexão se não existir
      let connection = this.connections.get(token);
      if (!connection) {
        connection = {
          ws: null,
          isAuthorized: false,
          token: token,
          loginid: loginid || null,
          reconnectAttempts: 0,
          isReconnecting: false,
          reconnectTimeout: null,
          pendingRequests: new Map(),
          tickSubscriptionId: null,
          proposalSubscriptionId: null,
          openContractSubscriptionId: null,
          pendingBuyConfig: null
        };
        this.connections.set(token, connection);
      }

      const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.logger.log(`[${token.substring(0, 5)}] Conectando WebSocket: ${url}`);

      const ws = new WebSocket(url, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      connection.ws = ws;

      const timeout = setTimeout(() => {
        if (connection && !connection.isAuthorized) {
          try {
            connection.ws?.close();
          } catch (e) { }
          reject(new Error('Timeout ao conectar/autorizar com Deriv'));
        }
      }, 15000); // 15s timeout

      ws.on('open', () => {
        this.logger.log(`[${token.substring(0, 5)}] WebSocket aberto. Enviando Authorize...`);
        this.send({ authorize: token }, token);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          // Se for authorize, processar especificamente para resolver a promise de conexão
          if (msg.msg_type === 'authorize') {
            if (!msg.error) {
              clearTimeout(timeout);
              if (connection) {
                connection.isAuthorized = true;
                connection.reconnectAttempts = 0;
                connection.loginid = msg.authorize.loginid;

                this.logger.log(`[${token.substring(0, 5)}] ✅ Autorizado! Conta: ${msg.authorize.loginid} (${msg.authorize.currency})`);

                // Se o loginid foi especificado mas veio diferente, alertar
                if (loginid && msg.authorize.loginid !== loginid) {
                  this.logger.warn(`[${token.substring(0, 5)}] ⚠️ CONFLITO: Solicitado ${loginid}, mas Token pertence a ${msg.authorize.loginid}`);
                }

                this.emit('authorized', msg.authorize);
                resolve();
              }
            } else {
              clearTimeout(timeout);
              this.logger.error(`[${token.substring(0, 5)}] ❌ Erro de Autorização:`, msg.error);
              reject(new Error(msg.error.message));
              this.disconnect(token);
            }
          }

          // Processar mensagem genérica (passando o contexto da conexão)
          this.handleMessage(msg, token);

        } catch (error) {
          this.logger.error(`[${token.substring(0, 5)}] Erro ao processar mensagem:`, error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error(`[${token.substring(0, 5)}] ❌ Erro WebSocket:`, error);
        reject(error);
      });

      ws.on('close', () => {
        this.logger.warn(`[${token.substring(0, 5)}] 🔌 WebSocket fechado.`);
        if (connection) {
          connection.isAuthorized = false;
          connection.ws = null;
          // Tentar reconectar?
          this.attemptReconnect(token);
        }
      });
    });
  }

  private handleMessage(msg: any, token: string): void {
    const connection = this.connections.get(token);
    if (!connection) return;

    if (msg.error) {
      // Ignorar erros de já inscrito
      if (msg.error.code !== 'AlreadySubscribed') {
        this.logger.error(`[${token.substring(0, 5)}] Erro API Deriv:`, msg.error);
        this.emit('error', msg.error); // Cuidado: isso emite globalmente. O ideal seria ter contexto.
      }
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        // Já tratado no on('message')
        break;

      case 'history':
        this.processHistory(msg, connection);
        break;

      case 'tick':
        this.processTick(msg, connection);
        break;

      case 'proposal':
        this.processProposal(msg, connection);
        break;

      case 'buy':
        this.processBuy(msg, connection);
        break;

      case 'sell':
        this.processSell(msg, connection);
        break;

      case 'contract':
        this.emit('contract_update', msg.contract);
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

      case 'proposal_open_contract':
        this.processProposalOpenContract(msg, connection);
        break;
    }
  }

  // ✅ Métodos de Processamento Atualizados para usar ConnectionState

  private processHistory(msg: any, connection: ConnectionState): void {
    const history = msg.history;
    if (!history || !history.prices) return;

    // Lógica original de processamento de ticks
    const prices = history.prices || [];
    const times = history.times || [];
    const newTicks: TickData[] = [];
    const startIdx = Math.max(0, prices.length - this.maxTicks);

    for (let i = startIdx; i < prices.length; i++) {
      const rawPrice = prices[i];
      if (rawPrice == null || rawPrice === '') continue;
      const value = Number(rawPrice);
      if (!isFinite(value) || value <= 0 || isNaN(value)) continue;

      const rawTime = times[i];
      let epoch = Math.floor(Number(rawTime));
      if (!isFinite(epoch) || epoch <= 0) {
        epoch = Math.floor(Date.now() / 1000) - (prices.length - i);
      }
      newTicks.push({ value, epoch });
    }

    // Salvar ticks "globais" (apenas do último que atualizou, ou deveria ser por símbolo?)
    // Para simplificar e manter compatibilidade com frontend que espera um array único:
    // Vamos atualizar o array global `this.ticks` com os dados mais recentes de QUALQUER conexão
    // Isso pode misturar se tiver 2 gráficos, mas o frontend manual geralmente foca em 1.
    this.ticks = newTicks;

    if (msg.subscription?.id) {
      connection.tickSubscriptionId = msg.subscription.id;
    }

    this.emit('history', { ticks: this.ticks, subscriptionId: connection.tickSubscriptionId });
  }

  private processTick(msg: any, connection: ConnectionState): void {
    const tick = msg.tick;
    if (!tick) return;

    // Validação
    if (!tick.quote || !tick.epoch) return;

    const value = Number(tick.quote);
    const epoch = Number(tick.epoch);

    if (tick.id && !connection.tickSubscriptionId) {
      connection.tickSubscriptionId = tick.id;
    }

    // Atualizar array global
    this.ticks.push({ value, epoch });
    if (this.ticks.length > this.maxTicks) this.ticks.shift();

    this.emit('tick', { value, epoch });
  }

  private processProposal(msg: any, connection: ConnectionState): void {
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
      connection.proposalSubscriptionId = msg.subscription.id;
    }

    this.emit('proposal', proposalData);
  }

  private processBuy(msg: any, connection: ConnectionState): void {
    const buy = msg.buy;
    if (!buy || !buy.contract_id) return;

    const config = connection.pendingBuyConfig;
    const durationUnit = config?.durationUnit || buy.duration_unit || 'm';
    const duration = config?.duration || Number(buy.duration) || 0;
    const contractType = config?.contractType || buy.contract_type || 'CALL';

    // Limpar pendente
    connection.pendingBuyConfig = null;

    let entrySpot = buy.entry_spot || buy.spot || buy.current_spot || null;
    if (!entrySpot && this.ticks.length > 0) {
      entrySpot = this.ticks[this.ticks.length - 1].value;
    }

    const tradeData: TradeData = {
      contractId: buy.contract_id,
      buyPrice: Number(buy.buy_price) || 0,
      payout: Number(buy.payout) || 0,
      symbol: buy.symbol || this.symbol,
      contractType,
      duration,
      durationUnit,
      entrySpot: entrySpot ? Number(entrySpot) : null,
      entryTime: Number(buy.purchase_time || buy.start_time) || Date.now() / 1000,
    };

    // Inscrever no contrato usando a MESMA conexão e token
    this.subscribeToOpenContract(buy.contract_id, connection.token);

    this.emit('buy', tradeData);
  }

  private processSell(msg: any, connection: ConnectionState): void {
    const sell = msg.sell;
    this.emit('sell', {
      contractId: sell.contract_id,
      sellPrice: Number(sell.sell_price),
      profit: Number(sell.profit),
      symbol: this.symbol // Pode ser impreciso se tiver múltiplos, mas ok por enquanto
    });
  }

  private processProposalOpenContract(msg: any, connection: ConnectionState): void {
    const contract = msg.proposal_open_contract;
    if (!contract) return;

    if (msg.subscription?.id) {
      connection.openContractSubscriptionId = msg.subscription.id;
    }

    this.emit('contract_update', contract);
  }

  // ✅ Métodos Públicos Atualizados (Agora exigem ou tentam inferir Token)

  /**
   * Envia uma mensagem para a conexão associada ao token.
   * Se token não for passado, tenta usar o primeiro disponível (single user mode)
   */
  private send(payload: any, token?: string): void {
    let connection: ConnectionState | undefined;

    if (token) {
      connection = this.connections.get(token);
    } else if (this.connections.size > 0) {
      // Fallback: Pega a primeira conexão disponível (para compatibilidade)
      connection = this.connections.values().next().value;
    }

    if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
      try {
        connection.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.logger.error(`Erro envio WS [${token || 'default'}]:`, e);
      }
    } else {
      this.logger.warn(`Não foi possível enviar mensagem. Token: ${token || 'Nenhum'}, Conexão Ativa: ${!!connection}`);
    }
  }

  subscribeToSymbol(symbol: string, token?: string): void {
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
    }, token); // Envia para o token específico se fornecido
  }

  /**
   * Compra contrato. OBRIGATÓRIO informar token para garantir contexto isolado.
   */
  buyContract(buyConfig: any): void {
    const {
      proposalId, price, duration, durationUnit, contractType,
      token, loginid // ✅ Parâmetros essenciais
    } = buyConfig;

    if (!token) {
      this.logger.error('buyContract chamado sem token! Impossível determinar contexto.');
      return;
    }

    // Obter conexão específica
    const connection = this.connections.get(token);
    if (!connection || !connection.isAuthorized) {
      // Tentar conectar se não estiver (auto-heal)
      this.logger.warn(`Conexão para compra (token ${token.substring(0, 5)}) não encontrada ou não autorizada. Tentando reconectar...`);
      this.connect(token, loginid).then(() => {
        this.buyContract(buyConfig); // Retry recursivo uma vez
      }).catch(err => {
        this.logger.error('Falha ao conectar para compra:', err);
      });
      return;
    }

    // Salvar config pendente na conexão específica
    connection.pendingBuyConfig = {
      durationUnit,
      duration,
      contractType
    };

    // Se temos proposalId, é compra direta. (Cenário Digit)
    if (proposalId) {
      this.send({ buy: proposalId, price: Number(price) }, token);
    } else {
      // Se for Buy Parameters (Cenário direto sem proposal prévia, ex: alguns bots)
      // Por simplificação assumimos proposalId flow.
      this.logger.warn('Fluxo de compra sem Proposal ID ainda não refatorado totalmente.');
    }
  }

  // Sobrecarga para compatibilidade com assinatura antiga (proposalId, price, ...)
  // Mas idealmente o controller deve chamar passando objeto
  async buyContractLegacy(proposalId: string, price: number, opts: any, token: string): Promise<void> {
    this.buyContract({
      proposalId, price, ...opts, token
    });
  }

  subscribeToProposal(config: any, token?: string): void {
    // Configurar proposal
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

    // Se token fornecido, cancela anterior DESTA conexão
    if (token) {
      const conn = this.connections.get(token);
      if (conn && conn.proposalSubscriptionId) {
        this.send({ forget: conn.proposalSubscriptionId }, token);
        conn.proposalSubscriptionId = null;
      }
    }

    this.send(req, token);
  }

  subscribeToOpenContract(contractId: string, token?: string): void {
    this.send({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1
    }, token);
  }

  getTicks(): TickData[] {
    return [...this.ticks];
  }

  private attemptReconnect(token: string): void {
    const conn = this.connections.get(token);
    if (!conn) return;

    if (conn.isReconnecting || conn.reconnectAttempts >= this.maxReconnectAttempts) return;

    conn.isReconnecting = true;
    conn.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
    this.logger.log(`[${token.substring(0, 5)}] Tentando reconectar em ${delay}ms...`);

    conn.reconnectTimeout = setTimeout(() => {
      this.establishConnection(token, conn.loginid || undefined)
        .then(() => { if (conn) conn.isReconnecting = false; })
        .catch(() => { if (conn) { conn.isReconnecting = false; this.attemptReconnect(token); } });
    }, delay);
  }

  disconnect(token?: string): void {
    if (token) {
      // Desconectar um específico
      const conn = this.connections.get(token);
      if (conn) {
        if (conn.reconnectTimeout) clearTimeout(conn.reconnectTimeout);
        conn.ws?.close();
        this.connections.delete(token);
        this.logger.log(`[${token.substring(0, 5)}] Desconectado e removido do pool.`);
      }
    } else {
      // Desconectar todos
      this.logger.log(`[DerivWebSocketService] Desconectando TODO o pool (${this.connections.size} conexões)...`);
      for (const [t, conn] of this.connections) {
        if (conn.reconnectTimeout) clearTimeout(conn.reconnectTimeout);
        conn.ws?.close();
      }
      this.connections.clear();
      this.ticks = [];
    }
  }

  onModuleDestroy() {
    this.disconnect();
  }

  // Métodos auxiliares para manter compatibilidade com controller que pode chamar sem token (fallback)
  getActiveSymbols(token?: string): void { this.send({ active_symbols: 'brief' }, token); }
  getTradingDurations(landingCompany: string = 'svg', token?: string): void { this.send({ trading_durations: 1, landing_company_short: landingCompany }, token); }
  getContractsFor(symbol: string, currency: string = 'USD', token?: string): void { this.send({ contracts_for: symbol, currency, landing_company: 'svg' }, token); }

  sellContract(contractId: string, price: number, token?: string): void {
    // Se não tiver token, teria que varrer as conexões ou assumir uma default?
    // O controller passa 0 como preço (venda a mercado)
    this.send({ sell: contractId, price: price }, token);
  }

  cancelSubscription(subscriptionId: string, token?: string): void {
    this.send({ forget: subscriptionId }, token);
    // Opcional: limpar subscriptionId do estado se encontrar em alguma conexão
    // Mas teria que varrer connection.tickSubscriptionId === subscriptionId etc.
  }

  cancelTickSubscription(token?: string): void {
    this.send({ forget_all: 'ticks' }, token);
    if (token) {
      const conn = this.connections.get(token);
      if (conn) conn.tickSubscriptionId = null;
    }
  }

  cancelProposalSubscription(token?: string): void {
    this.send({ forget_all: 'proposal' }, token);
    if (token) {
      const conn = this.connections.get(token);
      if (conn) conn.proposalSubscriptionId = null;
    }
  }
}
