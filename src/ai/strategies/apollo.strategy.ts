import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';

// Tipos específicos da Apollo v3
export type ApolloMode = 'veloz' | 'balanceado' | 'preciso';

// Estado do usuário Apollo
export interface ApolloUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  capitalInicial: number;

  // Modo e configurações
  mode: ApolloMode;
  modoMartingale: ModoMartingale;
  riskProfile: 'conservador' | 'moderado' | 'agressivo';

  // Martingale Inteligente
  martingaleLevel: number; // 0, 1, 2, 3+
  lossAccumulated: number;

  // Controle de estado
  isOperationActive: boolean;
  virtualLoss: number; // Contagem de dígitos <= 3

  // Stop Loss e Proteções
  stopLoss: number; // Valor positivo (ex: 50.0)
  profitTarget: number;
  maxProfitReached: number; // Maior lucro já alcançado (para trailing stop)
  trailingStopActive: boolean; // Se trailing stop está ativo

  // Timestamps
  creationCooldownUntil?: number;

  // Controle de Aposta e Barreira
  currentStake: number;
  currentBarrier: number;
  apostaInicial: number;
  symbol: string;
}

// Configuração Padrão do Usuário (fallback)
const DEFAULT_CONFIG = {
  INITIAL_STAKE: 0.35,
  TARGET_PROFIT: 10.0,
  STOP_LOSS: 50.0,
  SYMBOL: "R_100",
  CONTRACT_TYPE: "DIGITOVER",
  DURATION: 1,
  DURATION_UNIT: "t"
};

/**
 * ☀️ APOLLO v3: RiskManager
 * Gerencia dinheiro com Modos de Risco Personalizados e Stop Blindado
 */
class RiskManager {
  private config: any;
  private payouts: Record<number, number> = {
    0: 0.63, // Normal (Over 3)
    1: 0.96, // M1 (Over 4)
    2: 1.44, // M2 (Over 5)
    3: 2.23, // M3+ (Over 6)
  };

  constructor(config: any) {
    this.config = config;
  }

  updateProfit(state: ApolloUserState, profit: number) {
    const currentProfit = state.capital - state.capitalInicial;

    // Trailing Stop (Blindagem)
    if (currentProfit > state.maxProfitReached) {
      state.maxProfitReached = currentProfit;
    }

    if (state.maxProfitReached >= (state.profitTarget * 0.5)) {
      state.trailingStopActive = true;
    }
  }

  adjustStakeForStopLoss(state: ApolloUserState, intendedStake: number): { adjustedStake: number, reason: string | null } {
    /** Lógica de Pouso Suave (Soft Landing) */
    const currentProfit = state.capital - state.capitalInicial;

    // O limite efetivo muda se o Trailing Stop estiver ativo
    let stopLimit = -state.stopLoss;

    if (state.trailingStopActive) {
      // Garante 50% do lucro máximo
      stopLimit = state.maxProfitReached * 0.5;
    }

    // Margem restante até o stop
    // Se trailing ativo: currentProfit - (maxProfit * 0.5)
    // Se normal: currentProfit - (-stopLoss) = currentProfit + stopLoss
    const remainingMargin = currentProfit - stopLimit;

    if (remainingMargin < intendedStake) {
      if (remainingMargin < 0.35) {
        return { adjustedStake: 0.0, reason: "Margem Esgotada" };
      }
      return { adjustedStake: Number(remainingMargin.toFixed(2)), reason: "Pouso Suave Ativo" };
    }

    return { adjustedStake: intendedStake, reason: null };
  }

  getNextTradeParams(state: ApolloUserState, lastWin: boolean): { stake: number, barrier: number } {
    if (lastWin) {
      state.martingaleLevel = 0;
      state.lossAccumulated = 0.0;
      return { stake: this.config.INITIAL_STAKE, barrier: 3 };
    }

    state.martingaleLevel += 1;

    // Progressão de Barreiras (Martingale Inteligente)
    let barrier = 6;
    if (state.martingaleLevel === 1) barrier = 4;
    else if (state.martingaleLevel === 2) barrier = 5;
    else barrier = 6;

    const payoutRate = this.payouts[Math.min(state.martingaleLevel, 3)] || 2.23;

    // Fatores de Recuperação
    let factor = 1.0;
    if (state.riskProfile === 'moderado') factor = 1.25;
    else if (state.riskProfile === 'agressivo') factor = 1.50;

    // Limite Conservador
    if (state.riskProfile === 'conservador' && state.martingaleLevel > 5) {
      // Reseta se passar do nível 5 no modo conservador
      state.martingaleLevel = 0;
      state.lossAccumulated = 0.0;
      return { stake: this.config.INITIAL_STAKE, barrier: 3 };
    }

    let nextStake = (state.lossAccumulated * factor) / payoutRate;
    nextStake = Math.max(nextStake, 0.35);

    return { stake: Number(nextStake.toFixed(2)), barrier };
  }

  registerLoss(state: ApolloUserState, stake: number) {
    state.lossAccumulated += stake;
  }
}

/**
 * ☀️ APOLLO v3: Strategy Logic
 * Decide quando entrar no mercado
 */
class ApolloLogic {
  static processTick(state: ApolloUserState, digit: number): boolean {
    if (state.isOperationActive) return false;

    // Lógica de Loss Virtual da v3:
    // "Loss Virtual" acontece se digit <= 3
    if (digit <= 3) {
      state.virtualLoss += 1;
    } else {
      state.virtualLoss = 0;
    }

    if (state.mode === 'veloz') return true;
    else if (state.mode === 'balanceado' && state.virtualLoss >= 3) return true;
    else if (state.mode === 'preciso' && state.virtualLoss >= 5) return true;

    return false;
  }
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);

  private ticks: Tick[] = [];
  private apolloUsers = new Map<string, ApolloUserState>();

  // Pool de conexões WebSocket por token (reutilização)
  private wsConnections: Map<
    string,
    {
      ws: WebSocket;
      authorized: boolean;
      keepAliveInterval: NodeJS.Timeout | null;
      requestIdCounter: number;
      pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
      subscriptions: Map<string, (msg: any) => void>;
    }
  > = new Map();

  private appId: string;
  private symbol = 'R_100'; // Apollo opera em R_100 (Dígitos)

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[APOLLO] ☀️ Estratégia APOLLO v3 inicializada (Barriers 3-6)');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    this.ticks.push(tick);
    if (this.ticks.length > 100) this.ticks.shift();

    const digit = tick.digit;

    for (const [userId, state] of this.apolloUsers.entries()) {
      const shouldTrade = ApolloLogic.processTick(state, digit);

      // Log de TICK somente com debounce ou se houver mudança relevante no loss virtual para não spammar
      // Mas o requisito pede "📉 TICK: {digit} | Loss Virtual: {vl}"
      // Para não inundar o banco/front, vamos logar apenas quando loss virtual mudar ou for > 0
      // Ou melhor, logar somente para usuário ativo na sessão e talvez filtrar no front
      // Mas aqui vou logar sempre que o Loss Virtual > 0 ou quando zera, para ter rastro

      if (state.virtualLoss > 0 || shouldTrade) {
        // Opcional: Logar no console apenas
      }

      if (shouldTrade && !state.isOperationActive) {
        await this.executeTradeCycle(state);
      }
    }
  }

  async activateUser(userId: string, config: any): Promise<void> {
    const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, stopLoss, profitTarget } = config;
    let modeLower = (mode || 'balanceado').toLowerCase();

    // Mapear modos do frontend para modos da Apollo
    const modeMap: Record<string, ApolloMode> = {
      'veloz': 'veloz',
      'moderado': 'balanceado',
      'lento': 'preciso',
      'balanceado': 'balanceado',
      'preciso': 'preciso',
    };

    const apolloMode = modeMap[modeLower] || 'balanceado';
    const apostaInicial = entryValue || DEFAULT_CONFIG.INITIAL_STAKE;

    const riskProfile = (modoMartingale || 'moderado').toLowerCase() as 'conservador' | 'moderado' | 'agressivo';

    this.upsertApolloUserState({
      userId,
      stakeAmount: stakeAmount || 0,
      apostaInicial,
      derivToken,
      currency,
      modoMartingale: riskProfile,
      mode: apolloMode,
      stopLoss: stopLoss ? Math.abs(stopLoss) : DEFAULT_CONFIG.STOP_LOSS,
      profitTarget: profitTarget || DEFAULT_CONFIG.TARGET_PROFIT,
      riskProfile: riskProfile,
    });

    this.saveApolloLog(userId, 'info',
      `☀️ Usuário ATIVADO | Modo: ${apolloMode} | Capital: $${stakeAmount?.toFixed(2)} | Risk: ${riskProfile}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.apolloUsers.delete(userId);
    this.saveApolloLog(userId, 'info', '☀️ Usuário DESATIVADO');
  }

  getUserState(userId: string): any {
    return this.apolloUsers.get(userId) || null;
  }

  private async executeTradeCycle(state: ApolloUserState): Promise<void> {
    // Instanciar RiskManager apenas para lógica
    const riskManager = new RiskManager({ INITIAL_STAKE: state.apostaInicial });

    const { adjustedStake, reason } = riskManager.adjustStakeForStopLoss(state, state.currentStake);

    if (adjustedStake === 0.0) {
      this.saveApolloLog(state.userId, 'alerta', `🛑 [STOP] Limite Atingido: ${reason}`);
      await this.deactivateApolloUser(state.userId, 'stopped_loss');
      return;
    }

    if (reason) {
      this.saveApolloLog(state.userId, 'alerta', `⚠️ [POUSO SUAVE] Stake ajustado: $${state.currentStake.toFixed(2)} -> $${adjustedStake.toFixed(2)}`);
    }

    const stakeToUse = adjustedStake;
    state.isOperationActive = true;

    // LOG DE ENTRADA
    this.saveApolloLog(state.userId, 'operacao', `🚀 [TRADE] Comprando Over ${state.currentBarrier} | Stake: $${stakeToUse.toFixed(2)}`);
    this.logger.log(`[APOLLO][${state.userId}] 🚀 [TRADE] Comprando Over ${state.currentBarrier} | Stake: $${stakeToUse.toFixed(2)}`);

    try {
      const result = await this.executeTradeViaWebSocket(state.derivToken, {
        contract_type: "DIGITOVER",
        barrier: state.currentBarrier,
        amount: stakeToUse,
        currency: state.currency || 'USD'
      }, state.userId);

      if (result) {
        await this.processResult(state, result, stakeToUse, riskManager);
      } else {
        state.isOperationActive = false;
      }

    } catch (e) {
      this.logger.error(`[APOLLO][${state.userId}] Erro na execução: ${e.message}`);
      state.isOperationActive = false;
    }
  }

  private async processResult(state: ApolloUserState, result: { profit: number, exitSpot: any, contractId: string }, stakeUsed: number, riskManager: RiskManager) {
    const profit = result.profit;
    const isWin = profit > 0;

    riskManager.updateProfit(state, profit);

    const statusIcon = isWin ? "✅ WIN " : "❌ LOSS";
    const currentProfit = state.capital - state.capitalInicial + profit;

    this.saveApolloLog(state.userId, 'resultado', `${statusIcon} | Lucro: ${profit > 0 ? '+' : ''}${profit.toFixed(2)} | Saldo Sessão: ${currentProfit > 0 ? '+' : ''}${currentProfit.toFixed(2)}`);

    state.capital += profit;

    if (currentProfit >= state.profitTarget) {
      this.saveApolloLog(state.userId, 'info', "🏆 [META] Objetivo Diário Conquistado!");
      await this.deactivateApolloUser(state.userId, 'target_reached');
      return;
    }

    if (isWin) {
      state.isOperationActive = false;
      state.virtualLoss = 0;
      const params = riskManager.getNextTradeParams(state, true);
      state.currentStake = params.stake;
      state.currentBarrier = params.barrier;
    } else {
      riskManager.registerLoss(state, stakeUsed);
      const params = riskManager.getNextTradeParams(state, false);
      state.currentStake = params.stake;
      state.currentBarrier = params.barrier;

      this.saveApolloLog(state.userId, 'info', `🚀 [TRADE] Comprando Over ${params.barrier} | Stake: $${params.stake.toFixed(2)} <-- Barreira subiu/ajuste`);

      setTimeout(() => {
        this.executeTradeCycle(state);
      }, 1000);
    }

    await this.saveTradeToDb(state.userId, result, isWin, stakeUsed, state.mode, state.currentBarrier, state.symbol);
  }

  /**
   * ☀️ APOLLO: Executa trade via WebSocket
   */
  private async executeTradeViaWebSocket(
    token: string,
    contractParams: {
      contract_type: 'DIGITOVER';
      barrier: number;
      amount: number;
      currency: string;
    },
    userId?: string,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    try {
      this.logger.log(`[APOLLO] 🔌 Iniciando conexão WebSocket para trade...`);
      const connection = await this.getOrCreateWebSocketConnection(token, userId);

      // Solicitar proposta
      this.logger.log(`[APOLLO] 📝 Solicitando proposta para Over ${contractParams.barrier} | Stake: ${contractParams.amount}`);
      const proposalResponse: any = await connection.sendRequest({
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: this.symbol,
        barrier: String(contractParams.barrier),
      }, 60000);

      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        this.logger.error(`[APOLLO] ❌ Erro na proposta: ${JSON.stringify(errorObj)}`);
        return null;
      }

      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);

      this.logger.log(`[APOLLO] ✅ Proposta recebida: ID=${proposalId} | Preço=${proposalPrice}`);

      // Comprar contrato
      this.logger.log(`[APOLLO] 🛒 Efetuando compra...`);
      const buyResponse: any = await connection.sendRequest({
        buy: proposalId,
        price: proposalPrice,
      }, 60000);

      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        this.logger.error(`[APOLLO] ❌ Erro ao comprar: ${JSON.stringify(buyErrorObj)}`);
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      this.logger.log(`[APOLLO] ✅ Compra efetuada! Contrato ID: ${contractId}. Monitorando...`);

      // Monitorar contrato
      return await new Promise((resolve) => {
        let hasResolved = false;
        const contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[APOLLO] ⚠️ Timeout monitorando contrato ${contractId}`);
            connection.removeSubscription(contractId);
            resolve(null);
          }
        }, 90000);

        connection.subscribe(
          { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
          (msg: any) => {
            const contract = msg.proposal_open_contract;

            // Debug esporádico ou log de progresso
            if (contract.status === 'open' || contract.status === 'running') {
              this.logger.debug(`[APOLLO] 🔍 Contrato ${contractId} em andamento...`);
            }

            if (!contract) return;

            if (contract.is_sold || contract.status === 'sold') {
              if (!hasResolved) {
                hasResolved = true;
                const profit = Number(contract.profit || 0);
                this.logger.log(`[APOLLO] ✅ Contrato ${contractId} finalizado. Status: ${contract.status}, Lucro: ${profit}`);
                clearTimeout(contractMonitorTimeout);
                connection.removeSubscription(contractId);

                const exitSpot = contract.exit_tick || contract.current_spot || 0;

                resolve({
                  contractId,
                  profit,
                  exitSpot,
                });
              }
            }
          },
          contractId,
          90000,
        );
      });
    } catch (error: any) {
      this.logger.error(`[APOLLO] Erro ao executar trade:`, error);
      return null;
    }
  }

  private upsertApolloUserState(config: {
    userId: string;
    stakeAmount: number;
    apostaInicial: number;
    derivToken: string;
    currency: string;
    modoMartingale: 'conservador' | 'moderado' | 'agressivo';
    mode: ApolloMode;
    stopLoss: number;
    profitTarget: number;
    riskProfile: 'conservador' | 'moderado' | 'agressivo';
  }): void {
    const existing = this.apolloUsers.get(config.userId);

    if (existing) {
      existing.derivToken = config.derivToken;
      existing.currency = config.currency;
      existing.modoMartingale = config.modoMartingale;
      existing.mode = config.mode;
      existing.stopLoss = config.stopLoss;
      existing.profitTarget = config.profitTarget;
      existing.capital = config.stakeAmount;
      existing.riskProfile = config.riskProfile;
    } else {
      this.apolloUsers.set(config.userId, {
        userId: config.userId,
        derivToken: config.derivToken,
        currency: config.currency || 'USD',
        capital: config.stakeAmount,
        capitalInicial: config.stakeAmount,
        mode: config.mode,
        modoMartingale: config.modoMartingale,
        riskProfile: config.riskProfile,
        martingaleLevel: 0,
        lossAccumulated: 0,
        isOperationActive: false,
        virtualLoss: 0,
        stopLoss: config.stopLoss,
        profitTarget: config.profitTarget,
        maxProfitReached: 0.0,
        trailingStopActive: false,
        currentStake: config.apostaInicial,
        currentBarrier: 3,
        apostaInicial: config.apostaInicial,
        symbol: this.symbol
      });
    }
  }

  private async deactivateApolloUser(userId: string, reason: string = 'stopped'): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_user_config SET is_active = 0, session_status = ?, deactivated_at = NOW() WHERE user_id = ? AND is_active = 1`,
      [reason, userId],
    );
    this.apolloUsers.delete(userId);
  }

  private async saveTradeToDb(userId: string, result: any, isWin: boolean, stake: number, mode: string, barrier: number, symbol: string) {
    const analysisData = {
      strategy: 'apollo',
      mode,
      barrier,
      result_digit: result.exitSpot
    };

    await this.dataSource.query(
      `INSERT INTO ai_trades 
           (user_id, gemini_signal, entry_price, stake_amount, status, profit_loss, exit_price, contract_type, created_at, closed_at, analysis_data, symbol)
           VALUES (?, ?, 0, ?, ?, ?, ?, 'DIGITOVER', NOW(), NOW(), ?, ?)`,
      [userId, `OVER_${barrier}`, stake, isWin ? 'WON' : 'LOST', result.profit, result.exitSpot, JSON.stringify(analysisData), symbol]
    );

    this.tradeEvents.emit({
      userId,
      type: 'updated',
      tradeId: 0,
      status: isWin ? 'WON' : 'LOST',
      strategy: 'apollo',
      profitLoss: result.profit
    });
  }

  private saveApolloLog(userId: string, type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro', message: string) {
    const icons: Record<string, string> = {
      'info': 'ℹ️',
      'tick': '📊',
      'analise': '🔍',
      'sinal': '🎯',
      'operacao': '⚡',
      'resultado': '💰',
      'alerta': '⚠️',
      'erro': '❌',
    };

    const icon = icons[type] || 'ℹ️';
    const details = JSON.stringify({ strategy: 'apollo', symbol: this.symbol });

    this.dataSource.query(
      `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, type, icon, message, details]
    ).catch(e => console.error('Error saving log', e));

    this.tradeEvents.emit({
      userId,
      type: 'updated',
      strategy: 'apollo',
      symbol: this.symbol,
      status: 'LOG',
    });
  }

  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    const existing = this.wsConnections.get(token);

    if (existing) {
      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        return {
          ws: existing.ws,
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
            this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      } else {
        if (existing.keepAliveInterval) clearInterval(existing.keepAliveInterval);
        existing.ws.close();
        this.wsConnections.delete(token);
      }
    }

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });
      let authResolved = false;

      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          socket.close();
          this.wsConnections.delete(token);
          reject(new Error('Timeout ao conectar (20s)'));
        }
      }, 20000);

      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) return;

          const conn = this.wsConnections.get(token);
          if (!conn) return;

          if (msg.msg_type === 'authorize' && !authResolved) {
            authResolved = true;
            clearTimeout(connectionTimeout);
            if (msg.error) {
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(msg.error.message));
              return;
            }
            conn.authorized = true;
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
            }, 30000);
            resolve(socket);
            return;
          }

          if (msg.proposal_open_contract) {
            const cid = msg.proposal_open_contract.contract_id;
            if (cid && conn.subscriptions.has(cid)) {
              conn.subscriptions.get(cid)!(msg);
              return;
            }
          }

          for (const [key, pending] of conn.pendingRequests.entries()) {
            if (msg.msg_type && key.includes(msg.msg_type)) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(key);
              if (msg.error) pending.reject(new Error(msg.error.message));
              else pending.resolve(msg);
              return;
            }
            if (msg.proposal && key.includes('proposal')) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(key);
              pending.resolve(msg);
              return;
            }
            if (msg.buy && key.includes('buy')) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(key);
              pending.resolve(msg);
              return;
            }
          }
        } catch (e) { }
      });

      socket.on('open', () => {
        const conn = {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        };
        this.wsConnections.set(token, conn);
        socket.send(JSON.stringify({ authorize: token }));
      });
    });

    return {
      ws,
      sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
      subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
      removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
    };
  }

  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn) throw new Error("Connection not found");

    return new Promise((resolve, reject) => {
      const reqKey = `${Object.keys(payload)[0]}_${conn.requestIdCounter++}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(reqKey);
        reject(new Error("Request timeout"));
      }, timeoutMs);

      conn.pendingRequests.set(reqKey, { resolve, reject, timeout });
      conn.ws.send(JSON.stringify(payload));
    });
  }

  private async subscribeViaConnection(token: string, payload: any, callback: (msg: any) => void, subId: string, timeoutMs: number): Promise<void> {
    const conn = this.wsConnections.get(token);
    if (!conn) throw new Error("Connection not found");

    conn.subscriptions.set(subId, callback);
    conn.ws.send(JSON.stringify(payload));
  }

  private removeSubscriptionFromConnection(token: string, subId: string) {
    const conn = this.wsConnections.get(token);
    if (conn) conn.subscriptions.delete(subId);
  }
}
