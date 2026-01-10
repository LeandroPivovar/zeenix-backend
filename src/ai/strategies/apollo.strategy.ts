import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';

/**
 * 🛡️ APOLLO v3 (AIGIS) - Strategy Logic
 * 
 * CORE: Híbrido (Attack/Defense)
 * - Attack (Normal): DIGITUNDER 6 (Payout ~23-25%)
 * - Defense (Recovery): DIGITEVEN / DIGITODD (Payout ~95%)
 * 
 * FEATURES:
 * - Soros Nível 1 (Only on Attack Wins)
 * - Auto-Defense (Switch to LENTO after 3 losses)
 * - Stop Loss Blindado (Catraca 50% of Peak)
 * - Smart Recovery (Invert Last Digit)
 */

export type ApolloMode = 'veloz' | 'normal' | 'lento';

export interface ApolloUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  capitalInicial: number;

  // Configuration
  mode: ApolloMode;
  originalMode: ApolloMode; // To restore after defense
  modoMartingale: ModoMartingale;
  apostaInicial: number;
  stopLoss: number;
  profitTarget: number;

  // State
  isOperationActive: boolean;
  consecutiveLosses: number;
  lastProfit: number;
  lastResultWin: boolean;

  // AIGIS Specifics
  sorosActive: boolean; // Indicates next trade is Soros L1
  defenseMode: boolean; // Active after 3 losses

  // Protection
  pisoBlindado: number;
  picoLucro: number;
  blindadoAtivo: boolean;

  // Logic state
  lastDigit: number | null; // Tracked for inversion logic
  ticksColetados: number; // For logging/analysis
}

// Internal augmented state for logic
interface ApolloInternalState extends ApolloUserState {
  lossAccumulated: number;
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);
  private users = new Map<string, ApolloInternalState>();
  private ticks: Tick[] = [];
  private lastLogTime = 0; // Control global log frequency
  private symbol = 'R_100';
  private appId: string;

  // WebSocket Pool
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

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('🛡️ [APOLLO] AIGIS v3 Strategy Initialized (Hybrid Digits)');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    if (symbol && symbol !== this.symbol) return;
    this.ticks.push(tick);
    if (this.ticks.length > 50) this.ticks.shift();

    // 1. Global Heartbeat (Time-based ~10s)
    const now = Date.now();
    if (now - this.lastLogTime > 10000) {
      this.logger.debug(`[APOLLO] 📊 Ticks: ${this.ticks.length}/50 (Buffer) | Users: ${this.users.size}`);
      this.lastLogTime = now;
    }

    for (const state of this.users.values()) {
      state.ticksColetados++;

      // Track last digit for Even/Odd inversion logic
      state.lastDigit = tick.digit;

      // Process Trade Signal
      if (!state.isOperationActive) {
        await this.checkAndExecute(state);
      }
    }
  }

  private async checkAndExecute(state: ApolloInternalState) {
    // 1. DEFENSE MODE CHECK
    // If 3+ losses, force mode to LENTO if not already
    let effectiveMode = state.mode;
    if (state.consecutiveLosses >= 3) {
      effectiveMode = 'lento';
      if (!state.defenseMode) {
        state.defenseMode = true;
        this.saveLog(state.userId, 'alerta', `🛡️ [DEFESA] 3 Losses Seguidos. Ativando Modo LENTO (Sniper).`);
      }
    } else {
      if (state.defenseMode) {
        state.defenseMode = false;
        this.saveLog(state.userId, 'info', `✅ [RECUPERAÇÃO] Ciclo normalizado. Voltando ao modo ${state.originalMode}.`);
      }
      effectiveMode = state.originalMode;
    }

    // 2. SIGNAL LOGIC (AIGIS v3)
    // High Digits (6,7,8,9) Analysis
    const windowSize = effectiveMode === 'veloz' ? 1 : effectiveMode === 'normal' ? 2 : 3;
    if (this.ticks.length < windowSize) return;

    const window = this.ticks.slice(-windowSize).map(t => t.digit);
    const isHigh = (d: number) => d >= 6;

    let signal = false;
    let analysisMsg = '';

    if (effectiveMode === 'veloz') {
      // 1 High Digit
      if (isHigh(window[0])) {
        signal = true;
        analysisMsg = `Digit ${window[0]} >= 6`;
      } else {
        analysisMsg = `Digit ${window[0]} < 6`;
      }
    } else if (effectiveMode === 'normal') {
      // 2 High Digits, 2nd <= 1st (Loss of strength)
      const [prev, last] = window;
      if (isHigh(prev) && isHigh(last) && last <= prev) {
        signal = true;
        analysisMsg = `Sequence ${window.join(', ')} (Decay Detected)`;
      } else {
        analysisMsg = `Sequence ${window.join(', ')} (No Pattern)`;
      }
    } else { // lento
      // 3 High Digits
      if (window.every(isHigh)) {
        signal = true;
        analysisMsg = `Sequence ${window.join(', ')} (All High)`;
      } else {
        analysisMsg = `Sequence ${window.join(', ')} (Mixed)`;
      }
    }

    // Log Analysis (Periodic or on Signal)
    if (signal) {
      this.logger.debug(`[APOLLO][${state.userId}] 🎯 SIGNAL: ${analysisMsg}`);
    } else if (state.ticksColetados <= 5 || state.ticksColetados % 20 === 0) {
      // Log early ticks and then every 20 ticks to show it's alive
      const logMsg = `🔍 [ANÁLISE] ${analysisMsg} | Aguardando gatilho...`;
      this.logger.debug(`[APOLLO][${state.userId}] ${logMsg}`);

      // Save to DB so user sees it in the dashboard
      this.saveLog(state.userId, 'info', logMsg);
    }

    if (signal) {
      await this.executeTrade(state);
    }
  }

  private async executeTrade(state: ApolloInternalState) {
    // 1. DETERMINE CONTRACT & STAKE
    let contractType: 'DIGITUNDER' | 'DIGITODD' | 'DIGITEVEN';
    let prediction: number | undefined;
    let stake: number;

    // A. ATTACK MODE (Under 6)
    if (state.consecutiveLosses === 0) {
      contractType = 'DIGITUNDER';
      prediction = 6;

      // Soros Logic
      if (state.sorosActive) {
        stake = state.apostaInicial + state.lastProfit;
        this.saveLog(state.userId, 'sinal', `🚀 [SOROS] Ativo! Entrada Potencializada: $${stake.toFixed(2)} (Under 6)`);
      } else {
        stake = state.apostaInicial;
        this.saveLog(state.userId, 'sinal', `⚔️ [ATAQUE] Sinal Under 6 detectado. Stake Base: $${stake.toFixed(2)}`);
      }
    }
    // B. DEFENSE MODE (Even/Odd Recovery)
    else {
      // Invert logic: If last digit was Even, go Odd. If Odd, go Even.
      // We need the last digit from the *market*, which is stored in state.lastDigit
      const lastDigit = state.lastDigit ?? 0;
      const lastIsEven = lastDigit % 2 === 0;

      contractType = lastIsEven ? 'DIGITODD' : 'DIGITEVEN';

      // Calculate Martingale Stake
      stake = this.calculateMartingaleStake(state.modoMartingale, state.lossAccumulated, state.consecutiveLosses);

      // Reset if stake is 0 (Conservador Limit limit reached)
      if (stake === 0) {
        this.saveLog(state.userId, 'alerta', `🛑 [CONSERVADOR] Limite de 5 níveis atingido. Resetando ciclo.`);
        state.consecutiveLosses = 0;
        state.lossAccumulated = 0;
        stake = state.apostaInicial;
        // Treat as new attack start
        contractType = 'DIGITUNDER';
        prediction = 6;
      } else {
        this.saveLog(state.userId, 'sinal', `🚑 [RECUPERAÇÃO] ${state.consecutiveLosses}x Loss. Invertendo: ${lastIsEven ? 'PAR -> ÍMPAR' : 'ÍMPAR -> PAR'} | Stake: $${stake.toFixed(2)}`);
      }
    }

    // 2. STOP LOSS / BLINDADO ADJUSTMENT
    const currentProfit = state.capital - state.capitalInicial;
    const profitTarget = state.profitTarget;

    // Check Profit Target logic first
    if (currentProfit >= profitTarget) {
      this.handleStop(state, 'profit', currentProfit);
      return;
    }

    // Check Blindado Activation (40%)
    if (!state.blindadoAtivo && currentProfit >= (profitTarget * 0.40)) {
      state.blindadoAtivo = true;
      state.picoLucro = currentProfit;
      state.pisoBlindado = currentProfit * 0.50; // Protect 50%
      this.saveLog(state.userId, 'alerta', `🛡️ [BLINDADO] Meta 40% atingida! Proteção de $${state.pisoBlindado.toFixed(2)} ativada.`);

      // Emit event
      this.tradeEvents.emit({
        userId: state.userId,
        type: 'blindado_activated',
        strategy: 'apollo',
        profitPeak: state.picoLucro,
        protectedAmount: state.pisoBlindado
      });
    }

    // Trailing Stop Blindado updates
    if (state.blindadoAtivo && currentProfit > state.picoLucro) {
      state.picoLucro = currentProfit;
      state.pisoBlindado = state.picoLucro * 0.50;
    }

    // Calculate Remaining Limit
    let limitRemaining: number;
    if (state.blindadoAtivo) {
      limitRemaining = currentProfit - state.pisoBlindado;
    } else {
      limitRemaining = state.stopLoss + currentProfit;
    }

    // Adjust Stake
    if (stake > limitRemaining) {
      if (limitRemaining < 0.35) {
        const reason = state.blindadoAtivo ? 'blindado' : 'loss';
        const secureAmount = state.blindadoAtivo ? state.pisoBlindado : -(state.stopLoss);
        this.handleStop(state, reason, secureAmount);
        return;
      }
      this.saveLog(state.userId, 'alerta', `⚠️ [AJUSTE] Stake $${stake.toFixed(2)} excede limite. Ajustando para $${limitRemaining.toFixed(2)}.`);
      stake = Number(limitRemaining.toFixed(2));
    }

    // 3. EXECUTE
    state.isOperationActive = true;
    try {
      const tradeId = await this.createTradeRecord(state, contractType, stake, prediction);

      if (tradeId === 0) {
        // DB Insert failed (likely caught error), abort trade to be safe or retry?
        // For now, abort to prevent 'ghost trades'
        this.logger.error('[APOLLO] Trade Aborted: DB Insert Failed');
        state.isOperationActive = false;
        return;
      }

      const result = await this.executeTradeViaWebSocket(state.derivToken, {
        contract_type: contractType,
        amount: stake,
        currency: state.currency,
        barrier: prediction // For DIGITUNDER
      }, state.userId);

      if (result) {
        await this.processResult(state, result, stake, tradeId);
      } else {
        state.isOperationActive = false; // Error / Timeout
        // Optional: Update trade as ERROR in DB
      }
    } catch (error) {
      this.logger.error(`[APOLLO] Execution Error: ${error}`);
      state.isOperationActive = false;
    }
  }

  private async processResult(state: ApolloInternalState, result: { profit: number, exitSpot: any, contractId: string }, stakeUsed: number, tradeId: number) {
    state.isOperationActive = false;
    const profit = result.profit;
    const win = profit > 0;

    state.lastProfit = profit;
    state.lastResultWin = win;
    state.capital += profit;

    // Update Trade Record
    try {
      await this.dataSource.query(
        `UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`,
        [win ? 'WON' : 'LOST', profit, result.exitSpot, tradeId]
      );
    } catch (e) {
      this.logger.error(`[APOLLO] Failed to update trade ${tradeId}: ${e}`);
    }

    const logResult = win ? `✅ [WIN] +$${profit.toFixed(2)}` : `📉 [LOSS] -$${Math.abs(profit).toFixed(2)}`;
    this.saveLog(state.userId, 'resultado', `${logResult} | Saldo: $${state.capital.toFixed(2)}`);

    if (win) {
      // WIN LOGIC
      if (state.consecutiveLosses > 0) {
        // Recovered! Reset cycles.
        state.consecutiveLosses = 0;
        state.lossAccumulated = 0;
        this.saveLog(state.userId, 'info', `✅ [RECUPERAÇÃO] Perdas recuperadas. Reiniciando ciclo.`);
      } else {
        // Attack Win
        if (state.sorosActive) {
          // Won Soros Level 1 -> Reset to Base
          state.sorosActive = false;
          this.saveLog(state.userId, 'info', `🔁 [SOROS] Ciclo completo. Retornando à stake base.`);
        } else {
          // Won Base -> Activate Soros
          state.sorosActive = true;
          this.saveLog(state.userId, 'info', `🚀 [SOROS] Ativando Soros para próxima entrada.`);
        }
      }
    } else {
      // LOSS LOGIC
      state.consecutiveLosses++;
      state.lossAccumulated += stakeUsed;
      state.sorosActive = false; // Reset Soros on any loss
    }

    // Update DB session balance
    const sessionBalance = state.capital - state.capitalInicial;
    this.dataSource.query(
      `UPDATE ai_user_config SET session_balance = ? WHERE user_id = ? AND is_active = 1`,
      [sessionBalance, state.userId]
    ).catch(e => { });
  }

  // --- Helper Methods ---

  private calculateMartingaleStake(riskMode: ModoMartingale, lossAccumulated: number, consecutiveLosses: number): number {
    const PAYOUT_RATE = 0.95;

    if (riskMode === 'conservador') {
      if (consecutiveLosses > 5) return 0;
      return lossAccumulated / PAYOUT_RATE;
    } else if (riskMode === 'moderado') {
      return (lossAccumulated * 1.25) / PAYOUT_RATE;
    } else { // agressivo
      return (lossAccumulated * 1.50) / PAYOUT_RATE;
    }
  }

  async activateUser(userId: string, config: any): Promise<void> {
    let mode = (config.mode || 'normal').toLowerCase();
    // Map frontend modes to Apollo modes if needed
    const modeMap: any = { 'balanceado': 'normal', 'preciso': 'lento' };
    if (modeMap[mode]) mode = modeMap[mode];

    const initialState: ApolloInternalState = {
      userId,
      derivToken: config.derivToken,
      currency: config.currency || 'USD',
      capital: config.stakeAmount,
      capitalInicial: config.stakeAmount,
      mode: mode as ApolloMode,
      originalMode: mode as ApolloMode,
      modoMartingale: (config.modoMartingale || 'moderado').toLowerCase() as ModoMartingale,
      apostaInicial: config.entryValue || 0.35,
      stopLoss: config.lossLimit || 50,
      profitTarget: config.profitTarget || 10,

      isOperationActive: false,
      consecutiveLosses: 0,
      lastProfit: 0,
      lastResultWin: false,

      sorosActive: false,
      defenseMode: false,

      pisoBlindado: 0,
      picoLucro: 0,
      blindadoAtivo: false,

      lastDigit: null,
      ticksColetados: 0,

      lossAccumulated: 0
    };

    this.users.set(userId, initialState);

    // Initialize WS connection for this user
    this.getOrCreateWebSocketConnection(config.derivToken);

    this.saveLog(userId, 'info', `🛡️ [APOLLO] AIGIS v3 Ativado | Modo: ${initialState.mode} | Híbrido (Under 6 + Recovery)`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.users.delete(userId);
  }

  getUserState(userId: string) { return this.users.get(userId); }

  private saveLog(userId: string, type: string, message: string) {
    const iconMap: any = { 'info': 'ℹ️', 'alerta': '⚠️', 'sinal': '🎯', 'resultado': '💰', 'erro': '❌' };
    this.dataSource.query(`INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, type, iconMap[type] || '📝', message, JSON.stringify({ strategy: 'apollo' })]
    ).catch(e => console.error('Error saving log', e));
  }

  private async handleStop(state: ApolloInternalState, reason: 'profit' | 'loss' | 'blindado', secureAmount: number) {
    let msg = '';
    let type = '';
    if (reason === 'profit') {
      msg = `🏆 [META] Atingida: $${secureAmount.toFixed(2)}`;
      type = 'stopped_profit';
    } else if (reason === 'blindado') {
      msg = `🛡️ [BLINDADO] Lucro garantido de $${secureAmount.toFixed(2)} preservado.`;
      type = 'stopped_blindado';
    } else {
      msg = `🛑 [STOP LOSS] Limite de perda atingido.`;
      type = 'stopped_loss';
    }

    this.saveLog(state.userId, 'alerta', msg);
    this.tradeEvents.emit({ userId: state.userId, type: type as any, strategy: 'apollo', profitLoss: secureAmount });
    await this.dataSource.query(`UPDATE ai_user_config SET is_active=0, session_status=?, deactivated_at=NOW() WHERE user_id=? AND is_active=1`, [type, state.userId]);
    this.deactivateUser(state.userId);
  }

  // --- WebSocket Logic ---

  private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<{ contractId: string, profit: number, exitSpot: any } | null> {
    const conn = await this.getOrCreateWebSocketConnection(token);
    if (!conn) return null;

    const req: any = {
      proposal: 1,
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contract_type,
      currency: params.currency,
      duration: 1,
      duration_unit: 't',
      symbol: this.symbol
    };
    if (params.contract_type === 'DIGITUNDER') req.barrier = 6;
    if (params.contract_type === 'DIGITOVER') req.barrier = params.barrier;

    this.logger.log(`[APOLLO] Requesting Proposal: ${params.contract_type} ($${params.amount})`);

    const prop = await conn.sendRequest(req);
    if (prop.error) {
      this.logger.error(`Proposal Error: ${JSON.stringify(prop.error)}`);
      this.saveLog(userId, 'erro', `Erro na Proposta: ${prop.error.message}`);
      return null;
    }

    const buy = await conn.sendRequest({ buy: prop.proposal.id, price: prop.proposal.ask_price });
    if (buy.error) {
      this.logger.error(`Buy Error: ${JSON.stringify(buy.error)}`);
      this.saveLog(userId, 'erro', `Erro na Compra: ${buy.error.message}`);
      return null;
    }

    const contractId = buy.buy.contract_id;

    return new Promise((resolve) => {
      let resolved = false;
      conn.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (msg: any) => {
        const c = msg.proposal_open_contract;
        if (c.is_sold && !resolved) {
          resolved = true;
          conn.removeSubscription(contractId);
          resolve({ profit: Number(c.profit), contractId: c.contract_id, exitSpot: c.exit_tick });
        }
      }, contractId);
    });
  }

  private async getOrCreateWebSocketConnection(token: string): Promise<any> {
    let conn = this.wsConnections.get(token);
    if (conn && conn.ws.readyState === WebSocket.OPEN && conn.authorized) return conn;

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    const ws = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.error('[APOLLO] WS Connection Timeout');
        resolve(null);
      }, 10000); // 10s Timeout

      ws.on('open', () => {
        clearTimeout(timeout);
        const connection: any = {
          ws,
          authorized: false,
          pendingRequests: new Map(),
          subscriptions: new Map(),
          requestIdCounter: 0,
          sendRequest: (p: any) => this.sendRequest(connection, p),
          subscribe: (p: any, cb: any, id: string) => this.subscribe(connection, p, cb, id),
          removeSubscription: (id: string) => connection.subscriptions.delete(id)
        };

        this.wsConnections.set(token, connection);

        ws.on('message', (data: any) => this.handleMessage(connection, data));

        connection.sendRequest({ authorize: token }).then((res: any) => {
          if (!res.error) {
            connection.authorized = true;
            // Keep Alive
            setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })); }, 30000);
            resolve(connection);
          } else {
            resolve(null);
          }
        });
      });
      ws.on('error', (e) => {
        clearTimeout(timeout);
        this.logger.error('WS Error', e);
        resolve(null);
      });
      ws.on('close', () => {
        clearTimeout(timeout);
        this.wsConnections.delete(token);
      });
    });
  }

  private handleMessage(conn: any, data: any) {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.msg_type === 'ping') return;

      // Handle Requests
      if (msg.req_id) { // Assuming we tag req_id or similar logic. 
        // Simplified matching for this snippet:
        // In robust impl we map req_id. Here we iterate pending.
      }
      // For authorize/buy/proposal, we try to match by type if req_id not explicitly managed in this simplified block
      // But we used sendRequest wrapper.

      // Let's rely on the pendingRequests map which `sendRequest` populates.
      // We need to inject req_id in sendRequest.

      if (msg.echo_req?.req_id) {
        const reqId = msg.echo_req.req_id;
        const p = conn.pendingRequests.get(reqId);
        if (p) {
          conn.pendingRequests.delete(reqId);
          p.resolve(msg);
        }
      }

      // Handle Subscriptions
      if (msg.proposal_open_contract) {
        const id = msg.proposal_open_contract.contract_id;
        // Find subscription by id (we used contract_id as key)
        if (conn.subscriptions.has(id)) {
          conn.subscriptions.get(id)(msg);
        }
      }

    } catch (e) { }
  }

  private sendRequest(conn: any, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = Date.now() + Math.random(); // Simple ID
      payload.req_id = reqId;
      conn.pendingRequests.set(reqId, { resolve, reject });
      conn.ws.send(JSON.stringify(payload));
    });
  }

  private subscribe(conn: any, payload: any, callback: any, subId: string) {
    conn.subscriptions.set(subId, callback);
    conn.ws.send(JSON.stringify(payload));
  }

  private async createTradeRecord(state: ApolloInternalState, type: string, stake: number, prediction?: number): Promise<number> {
    const analysisData = {
      strategy: 'apollo',
      mode: state.mode,
      isDefense: state.consecutiveLosses > 0,
      soros: state.sorosActive
    };

    // Fix: Shorten signal string to avoid DB 'Data too long' error
    // "DIGITUNDER 6" -> "UNDER 6"
    // "DIGITEVEN" -> "EVEN"
    // "DIGITODD" -> "ODD"
    let shortSignal = type.replace('DIGIT', '');
    if (prediction !== undefined) shortSignal += ` ${prediction}`;

    try {
      const result: any = await this.dataSource.query(
        `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, gemini_duration, gemini_reasoning, contract_type, created_at, analysis_data, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [state.userId, shortSignal, 0, stake, 'PENDING', 1, `Apollo V3 - ${shortSignal}`, type, JSON.stringify(analysisData), this.symbol]
      );
      return result.insertId;
    } catch (e) {
      this.logger.error(`[APOLLO] DB Insert Error: ${e}`);
      return 0;
    }
  }
}
