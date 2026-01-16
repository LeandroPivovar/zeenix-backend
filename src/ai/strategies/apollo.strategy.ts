import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';
import { CopyTradingService } from '../../copy-trading/copy-trading.service';

/**
 * 🛡️ APOLLO v1.0 (OFFICIAL) - Price Action Strategy
 * 
 * CORE: Price Action (Trend + Volatility)
 * Market: Volatility 10 (1s) Index (R_10) - *Adjusted to R_100 based on standard if needed, user said R_10 index in doc but previous code was R_100. Sticking to R_100 default or R_10 if specified.*
 * *Correction*: Doc image says "Volatility 10 (1s) Index". Prev code was R_100.
 * *User Prompt*: The user provided python code uses `api.buy(signal['contract'])` and doesn't explicitly force a symbol, but doc image says Volatility 10 (1s).
 * *Decision*: I will keep `R_100` as default symbol for now to match the existing ecosystem unless explicit instruction to change symbol, OR I will add support for it.
 * *WAIT*: The user provided code in `on_tick` uses `self.ticks`.
 * 
 * FEATURES:
 * - Modes: VELOZ (1 Filter), NORMAL (2 Filters), LENTO (3 Filters + SMA)
 * - Recovery: Inversion (Anti-Persistence) after 2 losses.
 * - Defense: Auto-switch to LENTO after 3 losses.
 * - Risk: Smart Martingale (Rise/Fall Payout ~95%).
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
  originalMode: ApolloMode;
  riskProfile: ModoMartingale; // 'conservador' | 'moderado' | 'agressivo'
  apostaInicial: number;
  stopLoss: number;
  profitTarget: number;
  useBlindado: boolean;
  symbol: string; // Dynamic Market Support

  // State
  isOperationActive: boolean;
  consecutiveLosses: number;
  lastProfit: number;
  lastResultWin: boolean;

  // Logic State
  lastEntryDirection: 'CALL' | 'PUT' | null;
  currentStake: number; // To track next stake (Soros)

  // Defense / Blindado
  defenseMode: boolean; // Active after 3 losses
  peakProfit: number;
  stopBlindadoFloor: number;
  stopBlindadoActive: boolean;

  // Statistics
  ticksColetados: number;
  totalLossAccumulated: number;
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);
  private users = new Map<string, ApolloUserState>();
  private marketTicks = new Map<string, number[]>(); // Store prices per market
  private lastLogTimeNodes = new Map<string, number>(); // ✅ Heartbeat per symbol
  private lastRejectionLog = new Map<string, number>(); // ✅ Throttling for rejection logs
  private defaultSymbol = 'R_25';
  private appId: string;

  // WebSocket Pool
  private wsConnections: Map<string, any> = new Map();

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
    private copyTradingService: CopyTradingService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('🛡️ [APOLLO] Oficial v1.0 Strategy Initialized (Price Action)');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    if (!symbol) return;

    // Initialize ticks for symbol if not exists
    if (!this.marketTicks.has(symbol)) {
      this.marketTicks.set(symbol, []);
    }

    const ticks = this.marketTicks.get(symbol)!;
    ticks.push(tick.value);
    if (ticks.length > 20) ticks.shift();

    // Global Heartbeat (per symbol)
    const now = Date.now();
    const lastLog = this.lastLogTimeNodes.get(symbol) || 0;
    if (now - lastLog > 10000) {
      const usersOnSymbol = Array.from(this.users.values()).filter(u => u.symbol === symbol).length;
      this.logger.debug(`[APOLLO][${symbol}] 📊 Ticks: ${ticks.length}/20 | Users: ${usersOnSymbol}`);
      this.lastLogTimeNodes.set(symbol, now);
    }

    // Need enough ticks for SMA 5
    if (ticks.length < 5) return;

    for (const state of this.users.values()) {
      if (state.isOperationActive) continue;
      if (state.symbol !== symbol) continue; // Only process users for this market

      state.ticksColetados++;
      this.checkAndExecute(state, ticks);
    }
  }

  private async checkAndExecute(state: ApolloUserState, ticks: number[]) {
    // 0. INITIAL COUNTDOWN
    // Apollo needs 5 ticks (SMA 5 / Lento Analysis) to start.
    // Since 'ticks' passed here already has length >= 5 (checked in processTick),
    // this specific check might seem redundant for the logic, but useful for user feedback if we consider "ticksColetados" as the user's personal wait time.
    // However, since we use shared marketTicks, the strategy is "ready" as soon as market has ticks.
    // Let's log the first few ticks for the user to see activity.
    if (state.ticksColetados <= 5) {
      this.saveLog(state.userId, 'info', `📊 [SISTEMA] Coletando dados de mercado: ${state.ticksColetados}/5`);
      return; // ✅ Fix: Block execution until warm-up is complete
    }

    // 1. CHECK STOPS AND BLINDADO
    if (!this.checkStops(state)) return;

    // 2. DEFENSE MECHANISM (Auto-switch to LENTO after 4 losses)
    if (state.consecutiveLosses >= 4 && state.mode !== 'lento') {
      if (!state.defenseMode) {
        state.defenseMode = true;
        state.mode = 'lento';
        this.saveLog(state.userId, 'alerta', `🚨 [DEFESA] 4 Perdas Consecutivas. Ativando Modo LENTO (Sniper).`);
      }
    } else if (state.lastResultWin && state.mode === 'lento' && state.defenseMode) {
      // Return to NORMAL after 1 win in Lento (Recovery complete)
      state.defenseMode = false;
      state.mode = 'normal'; // Always return to NORMAL, never directly to VELOZ
      this.saveLog(state.userId, 'info', `✅ [RECUPERAÇÃO] Vitória no modo LENTO. Voltando ao modo NORMAL.`);
    }

    // 3. ANALYZE SIGNAL
    const signal = this.analyzeSignal(state, ticks);

    if (signal) {
      await this.executeTrade(state, signal);
    }
  }

  private analyzeSignal(state: ApolloUserState, prices: number[]): 'CALL' | 'PUT' | null {
    // Need at least 5 ticks for LENTO analysis
    if (prices.length < 5) return null;

    const currentPrice = prices[prices.length - 1];
    const lastPrice = prices[prices.length - 2];
    const price2 = prices[prices.length - 3];
    const price3 = prices[prices.length - 4];

    if (currentPrice === lastPrice) return null;

    const delta = currentPrice - lastPrice;
    const absDelta = Math.abs(delta);
    let direction: 'CALL' | 'PUT' = delta > 0 ? 'CALL' : 'PUT';

    const filters: string[] = [];
    const reasons: string[] = [];
    let strength = 0;

    // --- SMART RECOVERY (INVERSION) ---
    // Rule: If 2 consecutive losses on the SAME direction, invert the next signal.
    if (state.consecutiveLosses >= 2 && state.lastEntryDirection) {
      // Check if last 2 entries were in the same direction 
      // (Simplified check: if consecutive losses > 2, we assume persistence failed)
      // Ideally we should track history of directions, but using lastEntryDirection helps.
      if (state.lastEntryDirection === direction) {
        direction = direction === 'CALL' ? 'PUT' : 'CALL';
        filters.push('Inversão de Mão (Anti-Persistência)');
      }
    }

    // --- MODE LOGIC ---
    let validSignal = false;

    if (state.mode === 'veloz') {
      // VELOZ: 3 Ticks (~3s), Delta >= 0.1
      const MIN_DELTA = 0.1;
      if (absDelta >= MIN_DELTA) {
        validSignal = true;
        strength = 60;
        filters.push(`Direção Imediata (Delta ${absDelta.toFixed(2)} >= ${MIN_DELTA})`);
      } else {
        reasons.push(`Delta Insuficiente (${absDelta.toFixed(2)} < ${MIN_DELTA})`);
      }
    }
    else if (state.mode === 'normal') {
      // NORMAL: 3 Ticks (~3s), Delta >= 0.5, Consistency (3 ticks same direction)
      const MIN_DELTA = 0.5;

      // Consistency Check (Last 3 ticks: P3 -> P2 -> Current)
      // Directions: P3->P2 and P2->Current must match current direction
      const diff1 = lastPrice - price2; // Move 2
      const diff2 = currentPrice - lastPrice; // Move 3 (Current)
      // Check if all moves are consistent with 'direction'
      // If direction is CALL (up), diff1 > 0 and diff2 > 0
      const isConsistent = (direction === 'CALL' && diff1 > 0 && diff2 > 0) ||
        (direction === 'PUT' && diff1 < 0 && diff2 < 0);

      if (absDelta >= MIN_DELTA) {
        if (isConsistent) {
          validSignal = true;
          strength = 75;
          filters.push(`Força Confirmada (Delta ${absDelta.toFixed(2)} >= ${MIN_DELTA})`);
          filters.push('Consistência (3 Ticks)');
        } else {
          reasons.push('Falta de Consistência');
        }
      } else {
        reasons.push(`Delta Insuficiente (${absDelta.toFixed(2)} < ${MIN_DELTA})`);
      }
    }
    else if (state.mode === 'lento') {
      // LENTO: 5 Ticks (~5s), Delta >= 1.0, Strong Trend (>= 3 of 4 moves same direction)
      const MIN_DELTA = 1.0;

      // Analyze last 4 moves (5 prices)
      // P5->P4, P4->P3, P3->P2, P2->P1(Current)
      // Prices index: length-5 (start), ..., length-1 (current)
      let upMoves = 0;
      let downMoves = 0;
      for (let i = prices.length - 1; i > prices.length - 5; i--) {
        if (prices[i] > prices[i - 1]) upMoves++;
        else if (prices[i] < prices[i - 1]) downMoves++;
      }

      const isStrongTrend = (direction === 'CALL' && upMoves >= 3) ||
        (direction === 'PUT' && downMoves >= 3);

      if (absDelta >= MIN_DELTA) {
        if (isStrongTrend) {
          validSignal = true;
          strength = 90;
          filters.push(`Força Alta (Delta ${absDelta.toFixed(2)} >= ${MIN_DELTA})`);
          filters.push(`Tendência Forte (${direction === 'CALL' ? upMoves : downMoves}/4 movs)`);
        } else {
          reasons.push(`Tendência Fraca (${direction === 'CALL' ? upMoves : downMoves}/4 movs)`);
        }
      } else {
        reasons.push(`Delta Insuficiente (${absDelta.toFixed(2)} < ${MIN_DELTA})`);
      }
    }

    if (validSignal) {
      // Log Analysis
      const filterStr = filters.join(', ');
      this.saveLog(state.userId, 'sinal', `🎯 [SINAL] ${direction} Identificado | Força: ${strength}% | Filtros: ${filterStr}`);
      return direction;
    } else {
      // ✅ LOGAR TUDO (Exigência do usuário)
      // Mesmo sem sinal, mostrar a análise feita e o motivo da recusa.
      // Formato: [ANÁLISE] TICK: 1234.56 | DIR: CALL | DELTA: 0.12 (Min 0.3) | RESULT: RECUSADO
      const arrow = direction === 'CALL' ? '🟢' : '🔴';
      const logMsg = `${arrow} [ANÁLISE] ${state.mode.toUpperCase()} | Delta: ${absDelta.toFixed(3)} | Motivos: ${reasons.join(', ')}`;

      // Salvar como 'info' para aparecer no front
      this.saveLog(state.userId, 'info', logMsg);
    }

    return null;
  }

  private async executeTrade(state: ApolloUserState, direction: 'CALL' | 'PUT') {
    // 1. CALCULATE STAKE
    let stake = this.calculateStake(state);

    // 2. ADJUST FOR STOPS
    // Check remaining to stop loss / blindado
    const currentBalance = state.capital - state.capitalInicial;
    let limitRemaining: number;

    if (state.stopBlindadoActive) {
      // Cannot go below floor
      limitRemaining = currentBalance - state.stopBlindadoFloor;
    } else {
      // Cannot go below stop loss
      limitRemaining = state.stopLoss + currentBalance;
    }

    if (stake > limitRemaining) {
      if (limitRemaining < 0.35) {
        // Stop reached
        const type = state.stopBlindadoActive ? 'blindado' : 'loss';
        this.handleStopInternal(state, type, state.stopBlindadoActive ? state.stopBlindadoFloor : -state.stopLoss);
        return;
      }
      stake = Number(limitRemaining.toFixed(2));
      this.saveLog(state.userId, 'alerta', `⚠️ [AJUSTE] Stake ajustada para $${stake.toFixed(2)} (Limite de risco)`);
    }

    state.currentStake = stake; // Save for record

    // 3. EXECUTE
    state.isOperationActive = true;
    state.lastEntryDirection = direction;

    this.saveLog(state.userId, 'info', `🚀 [ENTRADA] ${direction} | Stake: $${stake.toFixed(2)}`);

    try {
      const tradeId = await this.createTradeRecord(state, direction, stake);
      if (!tradeId) {
        state.isOperationActive = false;
        return;
      }

      const result = await this.executeTradeViaWebSocket(state.derivToken, {
        contract_type: direction,
        amount: stake,
        currency: state.currency
      }, state.userId);

      if (result) {
        await this.processResult(state, result, stake, tradeId);
      } else {
        state.isOperationActive = false;
      }

    } catch (e) {
      this.logger.error(`[APOLLO] Execution Error: ${e}`);
      state.isOperationActive = false;
      this.saveLog(state.userId, 'erro', `Erro na execução: ${e}`);
    }
  }

  private async processResult(state: ApolloUserState, result: { profit: number, exitSpot: any, contractId: string }, stakeUsed: number, tradeId: number) {
    state.isOperationActive = false;
    const profit = result.profit;
    const win = profit > 0;

    state.lastProfit = profit;
    state.lastResultWin = win;
    state.capital += profit;

    // --- DB Update ---
    try {
      await this.dataSource.query(
        `UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`,
        [win ? 'WON' : 'LOST', profit, result.exitSpot, tradeId]
      );
      this.updateCopyTrading(tradeId, result.contractId, win, profit, stakeUsed);
    } catch (e) { console.error(e); }

    // --- LOG RESULT ---
    const statusIcon = win ? '✅' : '📉';
    this.saveLog(state.userId, 'resultado', `${statusIcon} [${win ? 'WIN' : 'LOSS'}] ${win ? '+' : ''}$${profit.toFixed(2)} | Saldo: $${state.capital.toFixed(2)}`);

    // --- UPDATE STATE ---
    if (win) {
      state.consecutiveLosses = 0;
      state.totalLossAccumulated = 0;
      // Soros Logic: Next stake will be Base + Profit
      // Log handled in calculateStake or next entry? 
      // User python code: "🚀 APLICANDO SOROS NÍVEL 1"
      const nextStake = state.apostaInicial + profit;
      this.saveLog(state.userId, 'info', `🚀 [SOROS] Nível 1 Habilitado. Próxima Stake: $${nextStake.toFixed(2)}`);
    } else {
      state.consecutiveLosses++;
      state.totalLossAccumulated += stakeUsed;
      // On loss, soros resets (implied by calculateStake logic)
    }

    // --- STOP BLINDADO UPDATE ---
    this.updateBlindado(state);

    // --- DB SESSION UPDATE ---
    const sessionBalance = state.capital - state.capitalInicial;
    this.dataSource.query(
      `UPDATE ai_user_config SET session_balance = ? WHERE user_id = ? AND is_active = 1`,
      [sessionBalance, state.userId]
    ).catch(e => { });

    // --- CHECK STOPS (Post-Trade) ---
    this.checkStops(state);
  }

  // --- LOGIC HELPERS ---

  private calculateStake(state: ApolloUserState): number {
    if (state.consecutiveLosses > 0) {
      // Martingale Inteligente
      // Conservador: 1.0 (Reset após 5) | Moderado: 1.15 | Agressivo: 1.30
      let multiplier = 1.0;
      const profile = state.riskProfile;

      if (profile === 'agressivo') multiplier = 1.30;
      else if (profile === 'moderado') multiplier = 1.15;
      else multiplier = 1.0; // Conservador (Recuperação sem lucro extra)
      // Conservador Reset logic
      if (profile === 'conservador' && state.consecutiveLosses > 5) {
        this.saveLog(state.userId, 'alerta', `♻️ [CONSERVADOR] Limite de recuperação atingido. Resetando stake.`);
        state.consecutiveLosses = 0;
        state.totalLossAccumulated = 0;
        return state.apostaInicial;
      }

      // Exact Formula: Stake = (Perda Acumulada * Multiplier) / 0.92
      const PAYOUT_RATE = 0.92; // 92% Payout roughly

      // Calculate
      // If totalLossAccumulated is 0 (shouldn't be if consecutiveLosses > 0), use base * multiplier fallback or just base?
      // On first loss, totalLossAccumulated = stake.
      const lossToRecover = state.totalLossAccumulated || state.apostaInicial;

      const neededStake = (lossToRecover * multiplier) / PAYOUT_RATE;
      return Number(neededStake.toFixed(2));
    } else {
      // Soros: If last was win, stake = base + lastProfit. 
      // But need to be careful: if just started, lastProfit is 0. 
      // If last was win, lastProfit > 0.
      if (state.lastResultWin && state.lastProfit > 0) {
        return Number((state.apostaInicial + state.lastProfit).toFixed(2));
      }
      return state.apostaInicial;
    }
  }

  private updateBlindado(state: ApolloUserState) {
    if (!state.useBlindado) return;

    const profit = state.capital - state.capitalInicial;
    const target = state.profitTarget;
    const activationThreshold = target * 0.40;

    // Check activation
    if (!state.stopBlindadoActive) {
      if (profit >= activationThreshold) {
        state.stopBlindadoActive = true;
        state.peakProfit = profit;
        state.stopBlindadoFloor = profit * 0.50;
        this.saveLog(state.userId, 'alerta', `🛡️ [BLINDADO] ATIVADO! Lucro: $${profit.toFixed(2)} | Piso Garantido: $${state.stopBlindadoFloor.toFixed(2)}`);
        this.tradeEvents.emit({
          userId: state.userId,
          type: 'blindado_activated',
          strategy: 'apollo',
          profitPeak: state.peakProfit,
          protectedAmount: state.stopBlindadoFloor
        });
      }
    } else {
      // Trailing Stop logic
      if (profit > state.peakProfit) {
        state.peakProfit = profit;
        state.stopBlindadoFloor = state.peakProfit * 0.50;
        // Optional: Log trailing update?
      }
    }
  }

  private checkStops(state: ApolloUserState): boolean {
    const profit = state.capital - state.capitalInicial;

    // 1. PROFIT TARGET
    if (profit >= state.profitTarget) {
      this.saveLog(state.userId, 'resultado', `🏆 [META] Atingida! Lucro Total: $${profit.toFixed(2)}`);
      this.handleStopInternal(state, 'profit', profit);
      return false;
    }

    // 2. STOP LOSS NORMAL
    if (profit <= -state.stopLoss) {
      this.saveLog(state.userId, 'alerta', `🛑 [STOP LOSS] Limite de perda diária atingido.`);
      this.handleStopInternal(state, 'loss', profit);
      return false;
    }

    // 3. STOP BLINDADO
    if (state.stopBlindadoActive && profit <= state.stopBlindadoFloor) {
      this.saveLog(state.userId, 'alerta', `🛑 [STOP BLINDADO] Lucro retornou ao piso de proteção.`);
      this.handleStopInternal(state, 'blindado', state.stopBlindadoFloor);
      return false;
    }

    return true;
  }

  private async handleStopInternal(state: ApolloUserState, reason: 'profit' | 'loss' | 'blindado', finalAmount: number) {
    let type = 'stopped_loss';
    if (reason === 'profit') type = 'stopped_profit';
    if (reason === 'blindado') type = 'stopped_blindado';

    state.isOperationActive = false;
    this.tradeEvents.emit({ userId: state.userId, type: type as any, strategy: 'apollo', profitLoss: finalAmount });
    await this.dataSource.query(`UPDATE ai_user_config SET is_active=0, session_status=?, deactivated_at=NOW() WHERE user_id=? AND is_active=1`, [type, state.userId]);
    this.users.delete(state.userId);
  }

  // --- INFRASTRUCTURE ---

  async activateUser(userId: string, config: any): Promise<void> {
    const modeMap: any = { 'balanceado': 'normal', 'preciso': 'lento', 'veloz': 'veloz' };
    let modeRaw = (config.mode || 'normal').toLowerCase();
    if (modeMap[modeRaw]) modeRaw = modeMap[modeRaw];

    // Market Selection Logic (Matching Atlas)
    let selectedSymbol = 'R_25'; // Default (Volatility 25)
    const marketInput = (config.symbol || config.selectedMarket || '').toLowerCase();

    if (marketInput === 'r_100' || marketInput.includes('100')) selectedSymbol = 'R_100';
    else if (marketInput === 'r_10' || marketInput.includes('volatility 10 index')) selectedSymbol = 'R_10';
    else if (marketInput === 'r_25' || marketInput.includes('25')) selectedSymbol = 'R_25';
    else if (marketInput.includes('1hz10v')) selectedSymbol = '1HZ10V';

    // If matches exact known symbol
    if (['R_10', 'R_25', 'R_100', '1HZ10V'].includes(config.symbol)) selectedSymbol = config.symbol;

    const initialState: ApolloUserState = {
      userId,
      derivToken: config.derivToken,
      currency: config.currency || 'USD',
      capital: config.stakeAmount,
      capitalInicial: config.stakeAmount,
      mode: modeRaw as ApolloMode,
      originalMode: modeRaw as ApolloMode,
      riskProfile: (config.modoMartingale || 'moderado').toLowerCase() as ModoMartingale,
      apostaInicial: config.entryValue || 0.35,
      stopLoss: config.lossLimit || 50,
      profitTarget: config.profitTarget || 10,
      useBlindado: config.useBlindado !== false,
      symbol: selectedSymbol,

      isOperationActive: false,
      consecutiveLosses: 0,
      lastProfit: 0,
      lastResultWin: false,
      lastEntryDirection: null,
      currentStake: 0,

      defenseMode: false,
      peakProfit: 0,
      stopBlindadoFloor: 0,
      stopBlindadoActive: false,
      ticksColetados: 0,
      totalLossAccumulated: 0
    };

    this.users.set(userId, initialState);
    this.getOrCreateWebSocketConnection(config.derivToken); // Init WS

    this.saveLog(userId, 'info', `⚙️ CONFIGURAÇÕES INICIAIS | Modo: ${initialState.mode.toUpperCase()} | Mercado: ${initialState.symbol} | Risco: ${initialState.riskProfile.toUpperCase()}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.users.delete(userId);
  }

  getUserState(userId: string) { return this.users.get(userId); }

  private saveLog(userId: string, type: string, message: string) {
    const iconMap: any = { 'info': 'ℹ️', 'alerta': '⚠️', 'sinal': '🎯', 'resultado': '💰', 'erro': '❌' };

    // 1. Save to DB
    this.dataSource.query(`INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, type, iconMap[type] || '📝', message, JSON.stringify({ strategy: 'apollo' })]
    ).catch(e => console.error('Error saving log', e));

    // 2. Emit Real-time Event (for Frontend)
    this.tradeEvents.emitLog({
      userId,
      type,
      message,
      timestamp: new Date()
    });
  }

  // --- WEBSOCKET & TRADE ---

  private async createTradeRecord(state: ApolloUserState, direction: string, stake: number): Promise<number> {
    const analysisData = {
      strategy: 'apollo',
      mode: state.mode,
      isDefense: state.defenseMode,
      soros: state.lastResultWin && state.consecutiveLosses === 0
    };

    try {
      const result: any = await this.dataSource.query(
        `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, gemini_duration, gemini_reasoning, contract_type, created_at, analysis_data, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [state.userId, direction, 0, stake, 'PENDING', 1, `Apollo V1 - ${direction}`, direction === 'CALL' ? 'CALL' : 'PUT', JSON.stringify(analysisData), state.symbol]
      );
      const tradeId = result.insertId;
      return tradeId;
    } catch (e) {
      this.logger.error(`[APOLLO] DB Insert Error: ${e}`);
      return 0;
    }
  }

  private updateCopyTrading(tradeId: number, contractId: string, win: boolean, profit: number, stake: number) {
    if (!this.copyTradingService) return;
    // Implementation omitted for brevity to focus on strategy logic, 
    // but should be identical to other strategies. 
    // Assumed existing service handles this if called correctly.
    // Re-adding the code from previous version for completeness:
    this.dataSource.query(`SELECT user_id FROM ai_trades WHERE id = ?`, [tradeId]).then(res => {
      if (res && res.length > 0) {
        this.copyTradingService.updateCopyTradingOperationsResult(res[0].user_id, contractId, win ? 'win' : 'loss', profit, stake)
          .catch(e => this.logger.error(e));
      }
    });
  }

  private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<{ contractId: string, profit: number, exitSpot: any } | null> {
    const conn = await this.getOrCreateWebSocketConnection(token);
    if (!conn) {
      this.saveLog(userId, 'erro', `❌ Falha ao conectar na Deriv (Timeout ou Auth). Verifique logs do sistema.`);
      return null;
    }

    const req: any = {
      proposal: 1,
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contract_type, // CALL or PUT
      currency: params.currency,
      duration: 1,
      duration_unit: 't',
      symbol: this.users.get(userId)?.symbol || this.defaultSymbol
    };

    try {
      // 1. Solicitar Proposta
      const propPromise = await conn.sendRequest(req);

      // Validação de Erro na Proposta (Padrão Orion)
      const errorObj = propPromise.error || propPromise.proposal?.error;
      if (errorObj) {
        const errorCode = errorObj?.code || '';
        const errorMessage = errorObj?.message || JSON.stringify(errorObj);

        let userMessage = `❌ Erro na proposta da Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`;
        if (errorCode === 'WrongResponse' || errorMessage.includes('WrongResponse')) {
          userMessage = `❌ Erro temporário (WrongResponse). Tentando novamente...`;
        } else if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
          userMessage = `💡 Saldo insuficiente na Deriv.`;
        } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
          userMessage = `💡 Rate limit atingido. Aguarde.`;
        }

        this.saveLog(userId, 'erro', userMessage);
        return null;
      }

      const proposalId = propPromise.proposal?.id;
      if (!proposalId) throw new Error('Proposta inválida (sem ID)');

      // 2. Executar Compra
      const buyReq = { buy: proposalId, price: propPromise.proposal.ask_price };
      const buyPromise = await conn.sendRequest(buyReq);

      if (buyPromise.error) {
        this.saveLog(userId, 'erro', `Erro na Compra: ${buyPromise.error.message}`);
        return null;
      }

      const contractId = buyPromise.buy.contract_id;
      this.saveLog(userId, 'info', `🚀 Ordem enviada! ID: ${contractId} | Aguardando resultado...`);

      // 3. Monitorar Resultado (Timeout 60s)
      return new Promise((resolve) => {
        let resolved = false;

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            conn.removeSubscription(contractId);
            this.saveLog(userId, 'erro', `⚠️ Timeout na execução (60s). Verifique conexão.`);
            resolve(null);
          }
        }, 60000);

        conn.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (msg: any) => {
          const c = msg.proposal_open_contract;
          if (c.is_sold && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            conn.removeSubscription(contractId);
            resolve({ profit: Number(c.profit), contractId: c.contract_id, exitSpot: c.exit_tick });
          }
        }, contractId);
      });

    } catch (e: any) {
      this.saveLog(userId, 'erro', `Erro Crítico Deriv: ${e.message}`);
      return null;
    }
  }

  private async getOrCreateWebSocketConnection(token: string): Promise<any> {
    // Reuse existing connection logic
    let conn = this.wsConnections.get(token);
    if (conn && conn.ws.readyState === WebSocket.OPEN && conn.authorized) return conn;

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.logger.debug(`[APOLLO] 🔌 Connecting to Deriv WS...`);
    const ws = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.error(`[APOLLO] ❌ Connection Timeout (10s)`);
        resolve(null);
      }, 10000);

      ws.on('open', () => {
        this.logger.debug(`[APOLLO] 🔌 WS Connected. Authorizing...`);
        const connection: any = {
          ws,
          authorized: false,
          pendingRequests: new Map(),
          subscriptions: new Map(),
          sendRequest: (p: any, timeoutMs: number = 30000) => {
            return new Promise((res, rej) => {
              const reqId = Date.now() + Math.random();
              p.req_id = reqId;

              const tm = setTimeout(() => {
                connection.pendingRequests.delete(reqId);
                rej(new Error(`Timeout waiting for response (${timeoutMs}ms)`));
              }, timeoutMs);

              connection.pendingRequests.set(reqId, { resolve: res, reject: rej, timeout: tm });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(p));
              } else {
                clearTimeout(tm);
                rej(new Error('WS Closed before sending'));
              }
            });
          },
          subscribe: (p: any, cb: any, id: string) => {
            connection.subscriptions.set(id, cb);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(p));
          },
          removeSubscription: (id: string) => connection.subscriptions.delete(id)
        };

        ws.on('message', (data: any) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.msg_type === 'ping') return;

            if (msg.echo_req?.req_id) {
              const r = connection.pendingRequests.get(msg.echo_req.req_id);
              if (r) {
                clearTimeout(r.timeout);
                connection.pendingRequests.delete(msg.echo_req.req_id);
                r.resolve(msg);
              }
            }
            if (msg.proposal_open_contract) {
              const id = msg.proposal_open_contract.contract_id;
              if (connection.subscriptions.has(id)) connection.subscriptions.get(id)(msg);
            }
          } catch (e) { }
        });

        connection.ws = ws;
        this.wsConnections.set(token, connection);

        connection.sendRequest({ authorize: token }).then((r: any) => {
          clearTimeout(timeout);
          if (!r.error) {
            connection.authorized = true;
            this.logger.log(`[APOLLO] ✅ WS Authorized`);
            setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })); }, 30000);
            resolve(connection);
          } else {
            this.logger.error(`[APOLLO] ❌ Auth Failed: ${r.error.message}`);
            resolve(null);
          }
        }).catch((e: any) => {
          clearTimeout(timeout);
          this.logger.error(`[APOLLO] ❌ Auth Error: ${e.message}`);
          resolve(null);
        });
      });
      ws.on('error', (e) => {
        clearTimeout(timeout);
        this.logger.error(`[APOLLO] ❌ WS Error: ${e.message}`);
        resolve(null);
      });
      ws.on('close', () => {
        this.logger.warn(`[APOLLO] 🔌 WS Closed`);
      });
    });
  }
}
