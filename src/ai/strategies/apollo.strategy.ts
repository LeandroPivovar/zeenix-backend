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
  sorosLevel: number; // 0 = Base, 1 = Soros Active
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
    // Apollo needs 5 ticks (SMA 5 / Lento Analysis) to start generally, 
    // BUT for VELOZ we only need 3 ticks.
    const requiredTicks = state.mode === 'veloz' ? 3 : 5;

    if (state.ticksColetados < requiredTicks) {
      // Only log if really early to avoid spam, but we need to wait.
      // Since processTick pushes to global marketTicks, checking state.ticksColetados is strictly user session time.
      return;
    }

    // 1. CHECK STOPS AND BLINDADO
    if (!this.checkStops(state)) return;

    // 2. DEFENSE MECHANISM (Auto-switch to LENTO after 3 losses)
    if (state.consecutiveLosses >= 3 && state.mode !== 'lento') {
      if (!state.defenseMode) {
        state.defenseMode = true;
        state.mode = 'lento';
        this.saveLog(state.userId, 'alerta', `🚨 [DEFESA] 3 Perdas Consecutivas. Ativando Modo LENTO (Sniper).`);
      }
    } else if (state.lastResultWin && state.mode === 'lento' && state.defenseMode) {
      // Return to NORMAL after 1 win in Lento (Recovery complete)
      state.defenseMode = false;
      state.mode = state.originalMode === 'lento' ? 'normal' : state.originalMode;
      this.saveLog(state.userId, 'info', `✅ [RECUPERAÇÃO] Vitória no modo LENTO. Voltando ao modo ${state.mode.toUpperCase()}.`);
    }

    // 3. ANALYZE SIGNAL
    const signal = this.analyzeSignal(state, ticks);

    if (signal) {
      await this.executeTrade(state, signal);
    }
  }

  private analyzeSignal(state: ApolloUserState, prices: number[]): 'CALL' | 'PUT' | null {
    // Need at least X ticks based on mode
    const requiredTicks = state.mode === 'veloz' ? 3 : 5;
    if (prices.length < requiredTicks) return null;

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
      // VELOZ: 3 Ticks (~3s), Delta >= 0.3
      const MIN_DELTA = 0.3;
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
      // LENTO: 5 Ticks (~5s), Delta >= 1.0 (Adjusted for R_25/R_100 Reality), SMA 5 Filter
      const MIN_DELTA = 1.0;

      // SMA 5 Filter (Only buy if price is on the correct side of SMA)
      const sma5 = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const isSmaTrend = direction === 'CALL' ? currentPrice > sma5 : currentPrice < sma5;

      // Analyze last 4 moves (5 prices)
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
          if (isSmaTrend) {
            validSignal = true;
            strength = 90;
            filters.push(`Força Alta (Delta ${absDelta.toFixed(2)} >= ${MIN_DELTA})`);
            filters.push(`Tendência Forte (${direction === 'CALL' ? upMoves : downMoves}/4 movs)`);
            filters.push(`Acima/Abaixo SMA 5`);
          } else {
            reasons.push(`Filtro SMA 5 (${currentPrice.toFixed(2)} ${direction === 'CALL' ? '<' : '>'} SMA ${sma5.toFixed(2)})`);
          }
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

    // Safety: Minimum Deriv Stake
    stake = Math.max(0.35, stake);

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
    // --- UPDATE STATE ---
    if (win) {
      if (state.consecutiveLosses > 0) {
        // ✅ RECUPERAÇÃO (MARTINGALE) BEM-SUCEDIDA
        // Reset absoluto. Não fazemos Soros com o lucro da recuperação (seria arriscado).
        state.consecutiveLosses = 0;
        state.totalLossAccumulated = 0;
        state.sorosLevel = 0;
        this.saveLog(state.userId, 'info', `✅ [RECUPERAÇÃO] Martingale finalizado com sucesso. Resetando para stake base.`);
      } else {
        // ✅ WIN NORMAL (Ciclo de Soros)
        if (state.sorosLevel === 0) {
          // Ativar Nível 1
          state.sorosLevel = 1;
          const nextStake = state.apostaInicial + profit;
          this.saveLog(state.userId, 'info', `🚀 [SOROS] Nível 1 Habilitado. Próxima Stake: $${nextStake.toFixed(2)}`);
        } else {
          // Completou Nível 1 -> Reset
          state.sorosLevel = 0;
          this.saveLog(state.userId, 'info', `✅ [SOROS] Nível 1 Concluído! Retornando à stake base.`);
        }
      }
      state.totalLossAccumulated = 0;
    } else {
      // LOSS
      state.consecutiveLosses++;
      state.totalLossAccumulated += stakeUsed;
      state.sorosLevel = 0; // ❌ Quebra o Soros se perder
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

    state.isOperationActive = false; // ✅ Moved to end to prevent race conditions
  }

  // --- LOGIC HELPERS ---

  private calculateStake(state: ApolloUserState): number {
    if (state.consecutiveLosses > 0) {
      // Martingale Inteligente
      // Conservador: 1.0 (Reset após 5) | Moderado: 1.15 | Agressivo: 1.30
      // --- MARTINGALE MULTIPLIERS ---
      let multiplier = 1.0;
      const profile = state.riskProfile;

      if (profile === 'agressivo') multiplier = 1.4;
      else if (profile === 'moderado') multiplier = 1.2;
      else multiplier = 1.0; // Conservador (Recuperação sem lucro extra)

      // Conservador Reset logic
      if (profile === 'conservador' && state.consecutiveLosses > 5) {
        this.saveLog(state.userId, 'alerta', `♻️ [CONSERVADOR] Limite de recuperação atingido. Resetando stake.`);
        state.consecutiveLosses = 0;
        state.totalLossAccumulated = 0;
        return state.apostaInicial;
      }

      // Exact Formula: Stake = (Perda Acumulada * Multiplier) / 0.92
      const PAYOUT_RATE = 0.92; // 92% Payout (Official Payout)

      // Calculate
      const lossToRecover = state.totalLossAccumulated || state.apostaInicial;

      const neededStake = (lossToRecover * multiplier) / PAYOUT_RATE;
      return Number(neededStake.toFixed(2));
    } else {
      // Soros Logic: Respect level
      // Critical Fix: Ensure last profit was positive and real to avoid negative stakes
      if (state.sorosLevel === 1 && state.lastResultWin && state.lastProfit > 0) {
        const nextStake = state.apostaInicial + state.lastProfit;
        return Number(nextStake.toFixed(2));
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
      totalLossAccumulated: 0,
      sorosLevel: 0
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

  private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<{ contractId: string, profit: number, exitSpot: any, entrySpot: any } | null> {
    const conn = await this.getOrCreateWebSocketConnection(token);
    if (!conn) {
      this.saveLog(userId, 'erro', `❌ Falha ao conectar na Deriv (Timeout ou Auth). Verifique logs do sistema.`);
      return null;
    }

    const symbol = this.users.get(userId)?.symbol || this.defaultSymbol;

    try {
      // ✅ PASSO 1: Solicitar Proposta
      const proposalStartTime = Date.now();
      this.logger.debug(`[APOLLO] 📤Usuario [${userId}] Solicitando proposta | Tipo: ${params.contract_type} | Valor: $${params.amount}`);

      const req: any = {
        proposal: 1,
        amount: params.amount,
        basis: 'stake',
        contract_type: params.contract_type,
        currency: params.currency,
        duration: 1,
        duration_unit: 't',
        symbol: symbol
      };

      const propPromise = await conn.sendRequest(req);

      // ✅ Validação de Erro na Proposta (Padrão Orion)
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
      const proposalPrice = Number(propPromise.proposal?.ask_price);

      if (!proposalId) throw new Error('Proposta inválida (sem ID)');

      const proposalDuration = Date.now() - proposalStartTime;
      this.logger.debug(`[APOLLO] 📊 Proposta recebida em ${proposalDuration}ms | ID=${proposalId}, Preço=${proposalPrice}`);

      // ✅ PASSO 2: Executar Compra
      const buyStartTime = Date.now();
      const buyReq = { buy: proposalId, price: proposalPrice };

      let buyResponse: any;
      try {
        buyResponse = await conn.sendRequest(buyReq, 60000);
      } catch (error: any) {
        const errorMessage = error?.message || JSON.stringify(error);
        this.saveLog(userId, 'erro', `❌ FALHA NA ENTRADA: ${errorMessage}`);
        return null;
      }

      if (buyResponse.error || buyResponse.buy?.error) {
        const buyError = buyResponse.error || buyResponse.buy?.error;
        this.saveLog(userId, 'erro', `Erro na Compra: ${buyError.message || JSON.stringify(buyError)}`);
        return null;
      }

      const contractId = buyResponse.buy.contract_id;
      const buyDuration = Date.now() - buyStartTime;

      this.saveLog(userId, 'info', `🚀 Ordem enviada! ID: ${contractId} | Prop: ${proposalDuration}ms | Compra: ${buyDuration}ms | Aguardando resultado...`);

      // ✅ PASSO 3: Monitorar Resultado (Timeout 90s) usando Subscription
      const monitorStartTime = Date.now();

      return new Promise((resolve) => {
        let hasResolved = false;
        let contractMonitorTimeout: any | null = null;

        // Timeout de segurança
        contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            conn.removeSubscription(contractId);
            this.saveLog(userId, 'erro', `⚠️ Timeout monitoramento (90s). Verifique conexão.`);
            resolve(null);
          }
        }, 90000);

        // Inscrever no contrato
        conn.subscribe(
          { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
          (msg: any) => {
            // Verificar erros
            if (msg.error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(contractMonitorTimeout!);
                conn.removeSubscription(contractId);
                this.saveLog(userId, 'erro', `❌ Erro no monitoramento: ${msg.error.message}`);
                resolve(null);
              }
              return;
            }

            const c = msg.proposal_open_contract;
            if (!c) return;

            if (c.is_sold) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(contractMonitorTimeout!);
                conn.removeSubscription(contractId);

                // Resultado Final
                const profit = Number(c.profit);
                const status = profit > 0 ? 'WIN' : 'LOSS';
                // O log de resultado é feito pelo chamador通常, mas podemos logar debug aqui
                this.logger.debug(`[APOLLO] Trade Finalizado: ${status} | Profit: ${profit}`);

                resolve({
                  profit: profit,
                  contractId: c.contract_id,
                  exitSpot: c.exit_tick,
                  entrySpot: c.entry_tick
                });
              }
            }
          },
          contractId
        ).catch(e => {
          if (!hasResolved) {
            hasResolved = true;
            clearTimeout(contractMonitorTimeout!);
            this.saveLog(userId, 'erro', `❌ Falha ao inscrever no monitoramento: ${e.message}`);
            resolve(null);
          }
        });
      });

    } catch (e: any) {
      this.saveLog(userId, 'erro', `Erro Crítico Deriv: ${e.message}`);
      return null;
    }
  }

  /**
   * ✅ APOLLO (Refatorado): Obtém ou cria conexão WebSocket reutilizável por token
   * Mantém uma conexão por token para evitar criar nova conexão a cada trade
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  } | null> {
    // ✅ Verificar se já existe conexão ativa para este token
    const existing = this.wsConnections.get(token);

    // ✅ Logs de diagnóstico
    this.logger.debug(`[APOLLO] 🔍 [${userId || 'SYSTEM'}] Verificando conexão existente para token ${token.substring(0, 8)}...`);

    if (existing) {
      const readyState = existing.ws.readyState;
      const readyStateText = readyState === WebSocket.OPEN ? 'OPEN' :
        readyState === WebSocket.CONNECTING ? 'CONNECTING' :
          readyState === WebSocket.CLOSING ? 'CLOSING' :
            readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN';

      this.logger.debug(`[APOLLO] � [${userId || 'SYSTEM'}] Conexão encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);

      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        this.logger.debug(`[APOLLO] ♻️ [${userId || 'SYSTEM'}] ✅ Reutilizando conexão WebSocket existente`);

        return {
          ws: existing.ws,
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
            this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      } else {
        this.logger.warn(`[APOLLO] ⚠️ [${userId || 'SYSTEM'}] Conexão existente não está pronta. Fechando e recriando.`);
        if (existing.keepAliveInterval) {
          clearInterval(existing.keepAliveInterval);
        }
        try { existing.ws.close(); } catch (e) { }
        this.wsConnections.delete(token);
      }
    }

    // ✅ Criar nova conexão
    this.logger.debug(`[APOLLO] 🔌 [${userId || 'SYSTEM'}] Criando nova conexão WebSocket para token`);
    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;

    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(endpoint, {
          headers: { Origin: 'https://app.deriv.com' },
        });

        let authResolved = false;
        const connectionTimeout = setTimeout(() => {
          if (!authResolved) {
            this.logger.error(`[APOLLO] ❌ [${userId || 'SYSTEM'}] Timeout na autorização após 20s. Estado: readyState=${socket.readyState}`);
            try { socket.close(); } catch (e) { }
            this.wsConnections.delete(token);
            reject(new Error('Timeout ao conectar e autorizar WebSocket (20s)'));
          }
        }, 20000);

        // ✅ Listener de mensagens para capturar autorização e outras respostas
        socket.on('message', (data: any) => {
          try {
            const msg = JSON.parse(data.toString());

            // ✅ Ignorar ping/pong
            if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
              return;
            }

            const conn = this.wsConnections.get(token);
            if (!conn) {
              // Se conexão não existe (ex: durante auth ainda não foi adicionada ou foi removida), não faz nada.
              // Mas durante o setup (dentro desta Promise), nós tratamos o auth especificamente aqui.
            }

            // ✅ Processar autorização (apenas durante inicialização)
            if (msg.msg_type === 'authorize' && !authResolved) {
              this.logger.debug(`[APOLLO] 🔐 [${userId || 'SYSTEM'}] Processando resposta de autorização...`);
              authResolved = true;
              clearTimeout(connectionTimeout);

              if (msg.error || (msg.authorize && msg.authorize.error)) {
                const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autorização';
                this.logger.error(`[APOLLO] ❌ [${userId || 'SYSTEM'}] Erro na autorização: ${errorMsg}`);
                this.wsConnections.delete(token); // Limpar token inválido
                reject(new Error(errorMsg));
              } else {
                this.logger.log(`[APOLLO] ✅ [${userId || 'SYSTEM'}] WebSocket Autorizado com Sucesso!`);
                // Configurar Keep-Alive
                const keepAlive = setInterval(() => {
                  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
                }, 30000);

                // Salvar conexão no pool
                this.wsConnections.set(token, {
                  ws: socket,
                  authorized: true,
                  pendingRequests: new Map(),
                  subscriptions: new Map(),
                  keepAliveInterval: keepAlive,
                  requestIdCounter: 0
                });

                resolve(socket);
              }
              return;
            }

            // ✅ Roteamento normal de mensagens para conexões ativas
            if (conn) {
              // 1. Tentar casar com req_id se existir (Prioridade Alta)
              if (msg.req_id || (msg.echo_req && msg.echo_req.req_id)) {
                const reqId = msg.req_id || msg.echo_req.req_id;
                for (const [key, val] of conn.pendingRequests.entries()) {
                  if (key.toString() === reqId.toString()) {
                    clearTimeout(val.timeout);
                    conn.pendingRequests.delete(key);
                    if (msg.error) val.reject(new Error(msg.error.message));
                    else val.resolve(msg);
                    return; // Handled
                  }
                }
              }

              // 2. Lógica Falback (FIFO) igual Orion para Proposal/Buy
              // Se não casou por ID (ou não tem ID), mas é uma resposta de trade esperada
              if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
                // Pega a primeira requisição pendente (FIFO)
                const firstKey = conn.pendingRequests.keys().next().value;
                if (firstKey) {
                  const pending = conn.pendingRequests.get(firstKey);
                  if (pending) {
                    clearTimeout(pending.timeout);
                    conn.pendingRequests.delete(firstKey);
                    if (msg.error) {
                      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    } else {
                      pending.resolve(msg);
                    }
                    return; // Handled
                  }
                }
              }

              // 3. Subscriptions (Proposal Open Contract, Ticks)
              if (msg.proposal_open_contract) {
                const id = msg.proposal_open_contract.contract_id;
                if (conn.subscriptions.has(id)) {
                  conn.subscriptions.get(id)(msg);
                  return;
                }
              }
              if (msg.tick) {
                const id = msg.tick.id;
                if (conn.subscriptions.has(id)) conn.subscriptions.get(id)(msg);
              }
            }

          } catch (e) {
            // JSON parse error or logic error
          }
        });

        socket.on('error', (err) => {
          if (!authResolved) {
            clearTimeout(connectionTimeout);
            reject(err);
          }
          this.logger.error(`[APOLLO] ❌ WS Error: ${err.message}`);
        });

        socket.on('close', () => {
          this.logger.warn(`[APOLLO] 🔌 WS Closed`);
          this.wsConnections.delete(token); // Limpar ao fechar
        });

        // Enviar Authorize logo após abrir
        socket.on('open', () => {
          this.logger.debug(`[APOLLO] 📤 [${userId || 'SYSTEM'}] Enviando solicitação de autorização...`);
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

    } catch (e) {
      this.logger.error(`[APOLLO] ❌ Falha fatal ao criar conexão: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * ✅ Envia requisição via conexão existente
   */
  /**
   * ✅ Envia requisição via conexão existente
   */
  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    return new Promise((resolve, reject) => {
      // ✅ ORION Logic: Use string ID for internal tracking, but DO NOT inject into payload unless needed
      // Deriv API does NOT require req_id in payload for most calls if we track via FIFO or other means.
      // If we injected a float before, it caused "Input validation failed".
      const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;

      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        conn.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timeout);
        conn.pendingRequests.delete(requestId);
        reject(e);
      }
    });
  }

  /**
   * ✅ Inscreve-se para atualizações via conexão existente
   */
  private async subscribeViaConnection(
    token: string,
    payload: any,
    callback: (msg: any) => void,
    subId: string,
    timeoutMs: number,
  ): Promise<void> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    // ✅ Aguardar primeira resposta para confirmar subscription
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.subscriptions.delete(subId);
        reject(new Error(`Timeout ao inscrever ${subId}`));
      }, timeoutMs);

      // ✅ Callback wrapper que confirma subscription na primeira mensagem
      const wrappedCallback = (msg: any) => {
        // ✅ Primeira mensagem confirma subscription
        if (msg.proposal_open_contract || msg.tick || msg.error) {
          clearTimeout(timeout);
          if (msg.error) {
            conn.subscriptions.delete(subId);
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
          // ✅ Subscription confirmada, substituir por callback original
          conn.subscriptions.set(subId, callback);
          resolve();
          // ✅ Chamar callback original com primeira mensagem
          callback(msg);
          return;
        }
        // ✅ Se não for primeira mensagem, já deve estar usando callback original (mas por segurança chamamos)
        try { callback(msg); } catch (e) { }
      };

      conn.subscriptions.set(subId, wrappedCallback);
      conn.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * ✅ Remove subscription da conexão
   */
  private removeSubscriptionFromConnection(token: string, subId: string): void {
    const conn = this.wsConnections.get(token);
    if (conn) {
      conn.subscriptions.delete(subId);
      // Optional: Send forget request? 
      // Deriv API 'forget' { forget: subId } if subId is stream ID. 
      // Not strictly necessary for client-side cleanup but good for server resources.
    }
  }
}
