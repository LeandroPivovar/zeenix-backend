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

@Injectable()
export class DerivWebSocketService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(DerivWebSocketService.name);
  private ws: WebSocket | null = null;
  private isAuthorized = false;
  private currentLoginid: string | null = null;
  private tickSubscriptionId: string | null = null;
  private proposalSubscriptionId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private appId: number;
  private token: string | null = null;
  private symbol: string = 'R_100';
  private ticks: TickData[] = [];
  private readonly maxTicks = 300; // 5 minutos de ticks
  private pendingBuyConfig: { durationUnit?: string; duration?: number; contractType?: string } | null = null; // Armazenar config da compra pendente

  constructor() {
    super();
    this.appId = Number(process.env.DERIV_APP_ID || 111346);
  }

  async connect(token: string, loginid?: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isAuthorized) {
      this.logger.log('Conexão WebSocket já está ativa');
      return;
    }

    this.token = token;
    if (loginid) {
      this.currentLoginid = loginid;
    }

    return this.establishConnection();
  }

  private establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.logger.log(`Conectando ao Deriv WebSocket: ${url}`);

      this.ws = new WebSocket(url, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      const timeout = setTimeout(() => {
        if (!this.isAuthorized) {
          this.ws?.close();
          reject(new Error('Timeout ao conectar com Deriv'));
        }
      }, 10000);

      this.ws.on('open', () => {
        this.logger.log('WebSocket aberto, enviando autorização');
        this.send({ authorize: this.token });
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
          
          if (msg.msg_type === 'authorize' && !msg.error) {
            clearTimeout(timeout);
            if (!this.isAuthorized) {
              this.isAuthorized = true;
              this.reconnectAttempts = 0;
              this.emit('authorized', msg.authorize);
              resolve();
            }
          }
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error('Erro no WebSocket:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.warn('WebSocket fechado');
        this.isAuthorized = false;
        this.attemptReconnect();
      });
    });
  }

  private handleMessage(msg: any): void {
    if (msg.error) {
      this.logger.error('Erro da API Deriv:', msg.error);
      this.emit('error', msg.error);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        if (!msg.error) {
          this.currentLoginid = msg.authorize?.loginid || null;
          this.emit('authorized', msg.authorize);
        }
        break;

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
        this.processContract(msg);
        break;

      case 'contracts_for':
        this.processContractsFor(msg);
        break;

      case 'trading_durations':
        this.processTradingDurations(msg);
        break;

      case 'active_symbols':
        this.processActiveSymbols(msg);
        break;
    }
  }

  private processHistory(msg: any): void {
    const history = msg.history;
    if (!history || !history.prices) return;

    const prices = history.prices || [];
    const times = history.times || [];
    const newTicks: TickData[] = [];

    const startIdx = Math.max(0, prices.length - this.maxTicks);

    for (let i = startIdx; i < prices.length; i++) {
      // Validação rigorosa: verificar null, undefined, strings vazias
      const rawPrice = prices[i];
      if (rawPrice == null || rawPrice === '' || rawPrice === undefined) {
        continue;
      }

      const value = Number(rawPrice);
      // Validação dupla: garantir que é um número válido e positivo
      if (!isFinite(value) || value <= 0 || isNaN(value)) {
        continue;
      }

      // Validação do epoch
      const rawTime = times[i];
      let epoch: number;
      if (rawTime != null && rawTime !== '' && rawTime !== undefined) {
        epoch = Math.floor(Number(rawTime));
        if (!isFinite(epoch) || epoch <= 0 || isNaN(epoch)) {
          epoch = Math.floor(Date.now() / 1000) - (prices.length - i);
        }
      } else {
        epoch = Math.floor(Date.now() / 1000) - (prices.length - i);
      }

      // Validação final: ambos devem ser válidos
      if (isFinite(value) && value > 0 && !isNaN(value) && isFinite(epoch) && epoch > 0 && !isNaN(epoch)) {
        newTicks.push({ value, epoch });
      }
    }

    this.ticks = newTicks;

    if (msg.subscription?.id) {
      this.tickSubscriptionId = msg.subscription.id;
    }

    this.emit('history', { ticks: this.ticks, subscriptionId: this.tickSubscriptionId });
  }

  private processTick(msg: any): void {
    const tick = msg.tick;
    if (!tick) return;

    // Validação rigorosa: verificar null, undefined, strings vazias
    const rawQuote = tick.quote;
    const rawEpoch = tick.epoch;

    if (rawQuote == null || rawQuote === '' || rawQuote === undefined) {
      this.logger.warn(`Tick ignorado: quote inválido (${rawQuote})`);
      return;
    }

    if (rawEpoch == null || rawEpoch === '' || rawEpoch === undefined) {
      this.logger.warn(`Tick ignorado: epoch inválido (${rawEpoch})`);
      return;
    }

    const value = Number(rawQuote);
    const epoch = Number(rawEpoch);

    // Validação dupla: garantir que são números válidos e positivos
    if (!isFinite(value) || value <= 0 || isNaN(value)) {
      this.logger.warn(`Tick ignorado: value inválido (${value})`);
      return;
    }

    if (!isFinite(epoch) || epoch <= 0 || isNaN(epoch)) {
      this.logger.warn(`Tick ignorado: epoch inválido (${epoch})`);
      return;
    }

    if (tick.id && !this.tickSubscriptionId) {
      this.tickSubscriptionId = tick.id;
    }

    this.ticks.push({ value, epoch });
    if (this.ticks.length > this.maxTicks) {
      this.ticks.shift();
    }

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
      this.proposalSubscriptionId = msg.subscription.id;
    }

    this.emit('proposal', proposalData);
  }

  private processBuy(msg: any): void {
    const buy = msg.buy;
    if (!buy || !buy.contract_id) return;

    // Usar durationUnit e contractType da configuração pendente se disponível, senão usar da resposta da API
    const durationUnit = this.pendingBuyConfig?.durationUnit || buy.duration_unit || 'm';
    const duration = this.pendingBuyConfig?.duration || Number(buy.duration) || 0;
    // IMPORTANTE: Usar contractType da configuração pendente (o que foi solicitado) em vez do retornado pela API
    // Isso garante que o tipo correto seja usado mesmo se a API retornar algo diferente
    const contractType = this.pendingBuyConfig?.contractType || buy.contract_type || 'CALL';
    
    this.logger.log(`[Buy] Processando compra: durationUnit=${durationUnit}, duration=${duration}, contractType=${contractType}, pendingConfig=${JSON.stringify(this.pendingBuyConfig)}`);
    this.logger.log(`[Buy] API retornou contract_type: ${buy.contract_type}, usando: ${contractType}`);
    
    // Log completo da resposta da API para debug
    this.logger.log(`[Buy] Resposta completa da API: ${JSON.stringify(buy)}`);
    
    // Limpar configuração pendente após usar
    this.pendingBuyConfig = null;

    // Tentar capturar entry_spot de diferentes campos possíveis
    let entrySpot = buy.entry_spot || buy.spot || buy.current_spot || buy.start_spot || null;
    
    // Se não encontrou entry_spot na resposta, usar o último tick disponível
    if (entrySpot === null || entrySpot === undefined) {
      if (this.ticks && this.ticks.length > 0) {
        const lastTick = this.ticks[this.ticks.length - 1];
        entrySpot = lastTick.value;
        this.logger.log(`[Buy] EntrySpot não encontrado na resposta, usando último tick: ${entrySpot}`);
      } else {
        this.logger.warn(`[Buy] EntrySpot não encontrado e nenhum tick disponível`);
      }
    }
    
    const entryTime = buy.purchase_time || buy.start_time || Date.now() / 1000;
    
    this.logger.log(`[Buy] EntrySpot final: ${entrySpot} (de entry_spot: ${buy.entry_spot}, spot: ${buy.spot}, current_spot: ${buy.current_spot}, start_spot: ${buy.start_spot}, último tick: ${this.ticks.length > 0 ? this.ticks[this.ticks.length - 1].value : 'N/A'})`);

    const tradeData: TradeData = {
      contractId: buy.contract_id,
      buyPrice: Number(buy.buy_price) || 0,
      payout: Number(buy.payout) || 0,
      symbol: buy.symbol || this.symbol,
      contractType: contractType, // Usar o tipo solicitado, não o retornado pela API
      duration: duration,
      durationUnit: durationUnit, // Preservar o valor original
      entrySpot: entrySpot !== null && entrySpot !== undefined ? Number(entrySpot) : null,
      entryTime: Number(entryTime) || null,
    };

    this.emit('buy', tradeData);
  }

  private processSell(msg: any): void {
    const sell = msg.sell;
    if (!sell || !sell.contract_id) return;

    // Log completo da resposta da API para debug
    this.logger.log(`[Sell] Resposta completa da API: ${JSON.stringify(sell)}`);

    // Tentar capturar exit_spot de diferentes campos possíveis
    let exitSpot = sell.exit_spot || sell.spot || sell.current_spot || sell.exit_spot_price || null;
    
    // Se não encontrou exit_spot na resposta, usar o último tick disponível
    if (exitSpot === null || exitSpot === undefined) {
      if (this.ticks && this.ticks.length > 0) {
        const lastTick = this.ticks[this.ticks.length - 1];
        exitSpot = lastTick.value;
        this.logger.log(`[Sell] ExitSpot não encontrado na resposta, usando último tick: ${exitSpot}`);
      } else {
        this.logger.warn(`[Sell] ExitSpot não encontrado e nenhum tick disponível`);
      }
    }
    
    this.logger.log(`[Sell] ExitSpot final: ${exitSpot} (de exit_spot: ${sell.exit_spot}, spot: ${sell.spot}, current_spot: ${sell.current_spot}, último tick: ${this.ticks.length > 0 ? this.ticks[this.ticks.length - 1].value : 'N/A'})`);

    const sellData = {
      contractId: sell.contract_id,
      sellPrice: Number(sell.sell_price) || 0,
      profit: Number(sell.profit) || 0,
      exitSpot: exitSpot !== null && exitSpot !== undefined ? Number(exitSpot) : null,
      symbol: sell.symbol || this.symbol,
    };

    this.emit('sell', sellData);
  }

  private processContract(msg: any): void {
    const contract = msg.contract;
    if (!contract) return;

    this.emit('contract_update', contract);
  }

  private processContractsFor(msg: any): void {
    const contractsFor = msg.contracts_for;
    if (!contractsFor) return;

    this.emit('contracts_for', contractsFor);
  }

  private processTradingDurations(msg: any): void {
    const durations = msg.trading_durations;
    if (!durations) return;

    this.emit('trading_durations', durations);
  }

  private processActiveSymbols(msg: any): void {
    const symbols = msg.active_symbols;
    if (!symbols) return;

    this.emit('active_symbols', symbols);
  }

  subscribeToSymbol(symbol: string): void {
    this.symbol = symbol;
    
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado. Aguardando...');
      return;
    }

    this.logger.log(`Inscrevendo-se no símbolo: ${symbol}`);
    
    this.send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 500,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    });
  }

  subscribeToProposal(config: {
    symbol: string;
    contractType: string;
    duration: number;
    durationUnit: string;
    amount: number;
    barrier?: number; // Para contratos DIGIT*
    multiplier?: number; // Para contratos MULTUP/MULTDOWN
  }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    // Validar contractType
    if (!config.contractType || config.contractType === 'undefined') {
      this.logger.error('contractType é obrigatório');
      return;
    }

    this.logger.log('Inscrevendo-se em proposta:', config);

    const proposalRequest: any = {
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
    
    // Adicionar barrier para contratos de dígitos
    if (config.barrier !== undefined && config.barrier !== null) {
      proposalRequest.barrier = String(config.barrier);
    }
    
    // Adicionar multiplier para contratos MULTUP/MULTDOWN
    if (config.multiplier !== undefined && config.multiplier !== null) {
      proposalRequest.multiplier = config.multiplier;
    }

    this.send(proposalRequest);
  }

  buyContract(proposalId: string, price: number, durationUnit?: string, duration?: number, contractType?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    // Armazenar configuração da compra para preservar durationUnit e contractType originais
    if (durationUnit !== undefined || contractType !== undefined) {
      this.pendingBuyConfig = { 
        durationUnit, 
        duration,
        contractType: contractType || undefined
      };
      this.logger.log(`[Buy] Armazenando config: durationUnit=${durationUnit}, duration=${duration}, contractType=${contractType}`);
    }

    this.logger.log(`Comprando contrato: ${proposalId} por ${price} (contractType esperado: ${contractType || 'N/A'})`);

    this.send({
      buy: proposalId,
      price: price,
    });
  }

  sellContract(contractId: string, price: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    this.logger.log(`Vendendo contrato: ${contractId} por ${price}`);

    this.send({
      sell: contractId,
      price: price,
    });
  }

  getContractsFor(symbol: string, currency: string = 'USD'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    this.send({
      contracts_for: symbol,
      currency: currency,
      landing_company: 'svg',
    });
  }

  getTradingDurations(landingCompany: string = 'svg'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    this.send({
      trading_durations: 1,
      landing_company_short: landingCompany,
    });
  }

  getActiveSymbols(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    this.send({
      active_symbols: 'brief',
    });
  }

  cancelSubscription(subscriptionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) {
      this.logger.warn('WebSocket não está conectado/autorizado');
      return;
    }

    this.logger.log(`Cancelando subscription: ${subscriptionId}`);
    this.send({ forget: subscriptionId });

    // Limpar IDs locais se corresponderem
    if (this.tickSubscriptionId === subscriptionId) {
      this.tickSubscriptionId = null;
    }
    if (this.proposalSubscriptionId === subscriptionId) {
      this.proposalSubscriptionId = null;
    }
  }

  cancelTickSubscription(): void {
    if (this.tickSubscriptionId) {
      this.cancelSubscription(this.tickSubscriptionId);
    }
  }

  cancelProposalSubscription(): void {
    if (this.proposalSubscriptionId) {
      this.cancelSubscription(this.proposalSubscriptionId);
    }
  }

  private send(payload: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('Tentativa de enviar mensagem com WebSocket fechado');
      return;
    }

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem:', error);
    }
  }

  private attemptReconnect(): void {
    if (this.isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.logger.log(`Tentando reconectar em ${delay}ms (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      if (this.token) {
        this.establishConnection()
          .then(() => {
            this.isReconnecting = false;
            this.emit('reconnected');
          })
          .catch((error) => {
            this.logger.error('Erro ao reconectar:', error);
            this.isReconnecting = false;
            this.attemptReconnect();
          });
      } else {
        this.isReconnecting = false;
      }
    }, delay);
  }

  getTicks(): TickData[] {
    return [...this.ticks];
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isAuthorized = false;
    this.currentLoginid = null;
    this.tickSubscriptionId = null;
    this.proposalSubscriptionId = null;
    this.ticks = [];
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }

  onModuleDestroy() {
    this.disconnect();
  }
}

