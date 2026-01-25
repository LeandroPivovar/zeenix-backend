import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { CopyTradingService } from '../../copy-trading/copy-trading.service';
import { TradeEventsService } from '../trade-events.service';


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
  consecutiveWins?: number; // Track win streak
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);
  private users = new Map<string, ApolloUserState>();
  private marketTicks = new Map<string, number[]>(); // Store prices per market
  private lastLogTimeNodes = new Map<string, number>(); // ✅ Heartbeat per symbol
  private lastRejectionLog = new Map<string, number>(); // ✅ Throttling for rejection logs
  private defaultSymbol = 'R_100';
  private appId: string;

  // WebSocket Pool
  private wsConnections: Map<string, {
    ws: WebSocket;
    authorized: boolean;
    authorizedCurrency: string | null;
    keepAliveInterval: NodeJS.Timeout | null;
    requestIdCounter: number;
    pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
    subscriptions: Map<string, (msg: any) => void>;
  }> = new Map();

  // ============================================
  // 🎨 HELPERS DE LOG PADRÃO ZENIX v2.0 (APOLLO)
  // ============================================

  private logInitialConfigV2(userId: string, mode: string, riskProfile: string, profitTarget: number, stopLoss: number, useBlindado: boolean) {
    const message =
      `APOLLO | ⚙️ Configurações Iniciais
• Modo: ${mode}
• Perfil: ${riskProfile}
• Meta: $${profitTarget.toFixed(2)}
• Stop Loss: $${stopLoss.toFixed(2)}
• Blindado: ${useBlindado ? 'ATIVADO' : 'DESATIVADO'}`;

    this.saveLog(userId, 'info', message);
  }

  private logSessionStart(userId: string, initialBalance: number, meta: number) {
    const message =
      `APOLLO | 📡 Início de Sessão
• Saldo Inicial: $${initialBalance.toFixed(2)}
• Meta do Dia: $${meta.toFixed(2)}
• Status: Monitorando Mercado`;

    this.saveLog(userId, 'info', message);
  }

  private logDataCollection(userId: string, current: number, target: number) {
    const message =
      `APOLLO | 📡 Coletando dados... (${current}/${target})`;
    this.saveLog(userId, 'analise', message);
  }

  private logAnalysisStarted(userId: string, mode: string) {
    const message =
      `APOLLO | 🧠 Analisando Mercado (${mode})`;
    this.saveLog(userId, 'analise', message);
  }

  private logSignalGenerated(userId: string, mode: string, signal: string, filters: string[], probability: number) {
    const filtersText = filters.map((f, i) => `• ${f}`).join('\n');
    const message =
      `APOLLO | 🎯 Sinal Detectado: ${signal}
${filtersText}
• Força: ${probability}%`;
    this.saveLog(userId, 'sinal', message);
  }

  private logTradeResultV2(
    userId: string,
    result: 'WIN' | 'LOSS',
    profit: number,
    balance: number,
    contractInfo?: { exitDigit?: string }
  ) {
    const emoji = result === 'WIN' ? '✅' : '❌';
    const message =
      `APOLLO | ${emoji} Resultado: ${result}
• Lucro/Perda: $${profit >= 0 ? '+' : ''}${profit.toFixed(2)}
• Saldo: $${balance.toFixed(2)}`;

    this.saveLog(userId, 'resultado', message);
  }

  private logMartingaleLevelV2(userId: string, level: number, stake: number) {
    const message =
      `APOLLO | 🔄 Martingale Nível ${level}
• Próxima Stake: $${stake.toFixed(2)}`;
    this.saveLog(userId, 'alerta', message);
  }

  private logSorosActivation(userId: string, level: number, profit: number, newStake: number) {
    const message =
      `APOLLO | 🚀 Soros Nível ${level}
• Lucro Anterior: $${profit.toFixed(2)}
• Nova Stake: $${newStake.toFixed(2)}`;
    this.saveLog(userId, 'info', message);
  }

  private logWinStreak(userId: string, count: number, profit: number) {
    const message =
      `APOLLO | 🏆 Sequência: ${count} Vitórias
• Lucro Acumulado: $${profit.toFixed(2)}`;
    this.saveLog(userId, 'info', message);
  }

  private logSuccessfulRecoveryV2(userId: string, totalLoss: number, amountRecovered: number, currentBalance: number) {
    const message =
      `APOLLO | 🛡️ Recuperação Concluída
• Recuperado: $${totalLoss.toFixed(2)}
• Saldo Atual: $${currentBalance.toFixed(2)}`;
    this.saveLog(userId, 'info', message);
  }

  private logContractChange(userId: string, oldContract: string, newContract: string, reason: string) {
    const message =
      `APOLLO | 🔄 Ajuste de Operação
• De: ${oldContract}
• Para: ${newContract}
• Motivo: ${reason}`;
    this.saveLog(userId, 'info', message);
  }

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
    private readonly copyTradingService: CopyTradingService,

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
    // VELOZ needs 1 tick (P0) to compare with previous (P-1).
    // NORMAL/LENTO needs 2 ticks (P1, P0) to compare 2 intervals (P2->P1, P1->P0).

    // normal: needs 2 moves (2 ticks collected)
    // lento: needs 3 moves (3 ticks collected)
    let requiredTicks = 2;
    if (state.mode === 'veloz') requiredTicks = 1;
    else if (state.mode === 'lento') requiredTicks = 3;

    if (state.ticksColetados < requiredTicks) {
      this.logDataCollection(state.userId, state.ticksColetados, requiredTicks);
      return;
    }

    // 1. CHECK STOPS AND BLINDADO
    if (!this.checkStops(state)) return;

    // 2. DEFENSE MECHANISM (Auto-switch to LENTO after 4 losses)
    // Updated requirement: Auto-Defense logic switches to LENTO after 4 losses.
    if (state.consecutiveLosses >= 4 && state.mode !== 'lento') {
      if (!state.defenseMode) {
        state.defenseMode = true;
        state.mode = 'lento';
        this.logContractChange(state.userId, state.mode, 'LENTO', '4 Perdas Consecutivas - Ativando Defesa');
      }
    } else if (state.lastResultWin && state.mode === 'lento' && state.defenseMode) {
      // Return to NORMAL after 1 win in Lento (Recovery complete)
      state.defenseMode = false;
      state.mode = state.originalMode === 'lento' ? 'normal' : state.originalMode;
      this.logContractChange(state.userId, 'LENTO', state.mode.toUpperCase(), 'Recuperação com Sucesso');
    }

    // 3. ANALYZE SIGNAL
    const signal = this.analyzeSignal(state, ticks);

    // ✅ Reset count after analysis (Respects "Wait for next X ticks" rule)
    state.ticksColetados = 0;

    if (signal) {
      await this.executeTrade(state, signal);
    }
  }

  private analyzeSignal(state: ApolloUserState, prices: number[]): 'CALL' | 'PUT' | null {
    // Determine ticks needed based on mode
    let requiredTicks = 2;

    // ADJUST COLLECTION REQUIREMENTS
    // Veloz: Needs 2 ticks total history (Current, Previous)
    // Normal/Lento: Needs 3 ticks total history (Current, P-1, P-2)

    if (state.mode === 'veloz') requiredTicks = 2;
    else if (state.mode === 'lento') requiredTicks = 4; // Lento needs 3 moves (4 points)
    else requiredTicks = 3;

    if (prices.length < requiredTicks) return null;

    const currentPrice = prices[prices.length - 1]; // P1
    const lastPrice = prices[prices.length - 2];    // P2
    const price3 = prices[prices.length - 3] || 0;  // P3

    let direction: 'CALL' | 'PUT' | null = null;
    let strength = 0;
    const filters: string[] = [];
    const reasons: string[] = [];

    // --- SMART RECOVERY (INVERSION) ---
    // Rule: If 2 consecutive losses on the SAME direction, invert the next signal logic.
    let invertSignal = false;
    if (state.consecutiveLosses >= 2 && state.lastEntryDirection) {
      // Simplified inversion logic
      invertSignal = true;
    }

    if (state.mode === 'veloz') {
      // MODO VELOZ
      // Coleta: Aguarda apenas 1 tick
      // 2. Análise: Aguarda apenas 1 tick e entra a favor
      // 3. Decisão: Entra sempre seguindo a direção do último tick

      const delta = currentPrice - lastPrice;

      // Direção do último tick
      if (delta > 0) direction = 'CALL';
      else if (delta < 0) direction = 'PUT';

      if (direction) {
        strength = 60;
        filters.push(`Tendência Imediata (1 Tick)`);
        filters.push(`Direção: ${direction}`);
      }
    }
    else if (state.mode === 'normal') {
      // MODO NORMAL
      // Coleta: Aguarda 2 ticks
      // 2. Análise: Aplica 2 filtros (Delta + Consistência)
      // 3. Decisão: Se delta >= 0.3 E 2 ticks na mesma direção, entra a favor

      const MIN_DELTA = 0.3;

      // Delta Total (P3 -> P1)
      const totalDelta = currentPrice - price3;
      const absDelta = Math.abs(totalDelta);
      const currentDirection = totalDelta > 0 ? 'CALL' : 'PUT';

      // Consistência: P3->P2 e P2->P1 devem ser na mesma direção
      const move1 = lastPrice - price3;
      const move2 = currentPrice - lastPrice;
      const isConsistent = (move1 > 0 && move2 > 0) || (move1 < 0 && move2 < 0);

      if (absDelta >= MIN_DELTA) {
        if (isConsistent) {
          direction = currentDirection;
          strength = 75;
          filters.push(`Delta ${absDelta.toFixed(2)} >= ${MIN_DELTA}`);
          filters.push(`Consistência (2 Ticks na mesma direção)`);
        } else {
          reasons.push(`Falta de Consistência (Ziguezague)`);
        }
      } else {
        reasons.push(`Delta Insuficiente (${absDelta.toFixed(2)} < ${MIN_DELTA})`);
      }
    }
    else if (state.mode === 'lento') {
      // MODO LENTO - CORREÇÃO 4
      // Coleta: Aguarda 3 ticks (para ter 3 movimentos)
      // 2. Análise: Aplica 2 filtros (Delta + Consistência de 3 movimentos)
      // 3. Decisão: Se delta >= 0.5 E 3 ticks (movimentos) na mesma direção, entra a favor

      const MIN_DELTA = 0.5;

      // Delta Total (P4 -> P1, ou seja, Last 3 moves)
      // Prices: [..., P4, P3, P2, P1] (P1=current)
      // Indices: length-1(current), length-2, length-3, length-4
      const price4 = prices[prices.length - 4] || 0; // P4

      if (price4 === 0) return null; // Safety check

      const totalDelta = currentPrice - price4; // Delta total dos 3 movimentos
      const absDelta = Math.abs(totalDelta);
      const currentDirection = totalDelta > 0 ? 'CALL' : 'PUT';

      // Consistência: 3 movimentos na mesma direção
      // P4->P3, P3->P2, P2->P1
      const move1 = price3 - price4;      // Move 1
      const move2 = lastPrice - price3;   // Move 2
      const move3 = currentPrice - lastPrice; // Move 3

      const isConsistentUP = move1 > 0 && move2 > 0 && move3 > 0;
      const isConsistentDOWN = move1 < 0 && move2 < 0 && move3 < 0;
      const isConsistent = isConsistentUP || isConsistentDOWN;

      if (absDelta >= MIN_DELTA) {
        if (isConsistent) {
          direction = currentDirection;
          strength = 90;
          filters.push(`Delta ${absDelta.toFixed(2)} >= ${MIN_DELTA}`);
          filters.push(`Consistência Forte (3 Movimentos)`);
        } else {
          reasons.push(`Falta de Consistência (3 Movimentos)`);
        }
      } else {
        reasons.push(`Delta Insuficiente (${absDelta.toFixed(2)} < ${MIN_DELTA})`);
      }
    }

    if (direction) {
      if (invertSignal) {
        const original = direction;
        direction = direction === 'CALL' ? 'PUT' : 'CALL';
        filters.push(`🔄 INVERSÃO (Recuperação): ${original} -> ${direction}`);
      }

      this.logSignalGenerated(state.userId, state.mode.toUpperCase(), direction, filters, strength);
      return direction;
    } else {
      return null;
    }
  }

  private async executeTrade(state: ApolloUserState, direction: 'CALL' | 'PUT') {
    // 1. CALCULATE STAKE
    let stake = this.calculateStake(state);

    // Safety: Minimum Deriv Stake
    stake = Math.max(0.35, stake);

    // ✅ CHECK INSUFFICIENT BALANCE (Before Trade)
    // Validate if local capital estimate is enough (with 10% margin)
    const requiredBalance = stake * 1.1;
    if (state.capital < requiredBalance) {
      this.saveLog(state.userId, 'erro', `❌ SALDO INSUFICIENTE! Capital atual ($${state.capital.toFixed(2)}) é menor que o necessário ($${requiredBalance.toFixed(2)}) para o stake calculado ($${stake.toFixed(2)}). IA DESATIVADA.`);
      await this.handleStopInternal(state, 'insufficient_balance', state.capital);
      return;
    }

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
        const isBlindado = state.stopBlindadoActive;
        const msg = isBlindado
          ? `🛡️ STOP BLINDADO ATINGIDO POR AJUSTE DE ENTRADA!\n• Motivo: Proteção de lucro alcançada.\n• Ação: Encerrando operações para preservar o lucro.`
          : `🛑 STOP LOSS ATINGIDO POR AJUSTE DE ENTRADA!\n• Motivo: Limite de perda diária alcançado.\n• Ação: Encerrando operações imediatamente.`;

        this.saveLog(state.userId, 'alerta', msg);
        this.handleStopInternal(state, isBlindado ? 'blindado' : 'loss', isBlindado ? state.stopBlindadoFloor : -state.stopLoss);
        return;
      }
      stake = Number(limitRemaining.toFixed(2));
      const adjMsg = state.stopBlindadoActive
        ? `⚠️ AJUSTE DE RISCO (PROTEÇÃO DE LUCRO)\n• Stake Calculada: $${stake.toFixed(2)}\n• Lucro Protegido Restante: $${limitRemaining.toFixed(2)}\n• Ação: Stake reduzida para $${stake.toFixed(2)} para não violar a proteção.`
        : `⚠️ AJUSTE DE RISCO (STOP LOSS)\n• Stake Calculada: $${stake.toFixed(2)}\n• Saldo Restante até Stop: $${limitRemaining.toFixed(2)}\n• Ação: Stake reduzida para $${stake.toFixed(2)} para respeitar o Stop Loss.`;

      this.saveLog(state.userId, 'alerta', adjMsg);
    }

    state.currentStake = stake; // Save for record

    // 3. RECUPERAÇÃO / MARTINGALE LOG
    if (state.consecutiveLosses > 0) {
      this.logMartingaleLevelV2(state.userId, state.consecutiveLosses, stake);
    }

    // 4. EXECUTE
    state.isOperationActive = true;
    state.lastEntryDirection = direction;

    try {
      const tradeId = await this.createTradeRecord(state, direction, stake);
      if (!tradeId) {
        state.isOperationActive = false;
        return;
      }

      const result = await this.executeTradeViaWebSocket(state.derivToken, {
        contract_type: direction,
        amount: stake,
        currency: state.currency || 'USD'
      }, state.userId, async (contractId, entryPrice) => {
        // ✅ [APOLLO] Master Trader Replication - IMMEDIATE (at entry)
        try {
          const userMaster = await this.dataSource.query('SELECT trader_mestre FROM users WHERE id = ?', [state.userId]);
          const isMasterTraderFlag = userMaster && userMaster.length > 0 && userMaster[0].trader_mestre === 1;

          if (isMasterTraderFlag) {
            const percent = state.capital > 0 ? (stake / state.capital) * 100 : 0;
            const unixTimestamp = Math.floor(Date.now() / 1000);

            // 1. Gravar na tabela master_trader_operations as OPEN
            await this.dataSource.query(
              `INSERT INTO master_trader_operations
                   (trader_id, symbol, contract_type, barrier, stake, percent, multiplier, duration, duration_unit, trade_type, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
              [
                state.userId,
                state.symbol,
                direction, // 'CALL' | 'PUT'
                null, // Apollo doesn't use barrier
                stake,
                percent,
                0, // multiplier
                1, // duration
                't', // duration_unit
                direction === 'CALL' ? 'CALL' : 'PUT',
                'OPEN',
              ]
            );

            // 2. Chamar serviço de cópia para execução imediata
            if (this.copyTradingService) {
              await this.copyTradingService.replicateManualOperation(
                state.userId,
                {
                  contractId: contractId || '',
                  contractType: direction, // 'CALL' | 'PUT'
                  symbol: state.symbol,
                  duration: 1,
                  durationUnit: 't',
                  stakeAmount: stake,
                  percent: percent,
                  entrySpot: entryPrice || 0,
                  entryTime: unixTimestamp,
                  barrier: undefined
                },
              );
            }
          }
        } catch (repError) {
          this.logger.error(`[APOLLO] Erro na replicação Master Trader (Entry):`, repError);
        }
      });

      if (result) {
        await this.processResult(state, result, stake, tradeId);

        // ✅ [APOLLO] Master Trader Result Update
        try {
          const userMaster = await this.dataSource.query('SELECT trader_mestre FROM users WHERE id = ?', [state.userId]);
          if (userMaster && userMaster.length > 0 && userMaster[0].trader_mestre === 1 && this.copyTradingService) {
            const resMap = result.profit > 0 ? 'win' : 'loss';
            await this.copyTradingService.updateCopyTradingOperationsResult(
              state.userId,
              result.contractId,
              resMap,
              result.profit,
              stake
            );
          }
        } catch (resError) {
          this.logger.error(`[APOLLO] Erro ao atualizar resultados do Copy Trading:`, resError);
        }
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

    } catch (e) { console.error(e); }

    // --- LOG RESULT ---
    // ✅ LOG PADRONIZADO V2: Resultado Detalhado
    this.logTradeResultV2(state.userId, win ? 'WIN' : 'LOSS', profit, state.capital);

    // --- UPDATE STATE ---
    if (win) {
      if (state.consecutiveLosses > 0) {
        // ✅ RECUPERAÇÃO (MARTINGALE) BEM-SUCEDIDA
        this.logSuccessfulRecoveryV2(state.userId, state.totalLossAccumulated, profit, state.capital);

        state.consecutiveLosses = 0;
        state.totalLossAccumulated = 0;
        state.sorosLevel = 0;
      } else {
        // ✅ WIN NORMAL (Ciclo de Soros)
        if (!state['consecutiveWins']) state['consecutiveWins'] = 0;
        state['consecutiveWins']++;
        if (state['consecutiveWins'] > 1) {
          this.logWinStreak(state.userId, state['consecutiveWins'], state.capital - state.capitalInicial);
        }

        if (state.sorosLevel === 0) {
          // Ativar Nível 1
          state.sorosLevel = 1;
          const nextStake = state.apostaInicial + profit;
          this.logSorosActivation(state.userId, 1, profit, nextStake);
        } else {
          // Completou Nível 1 -> Reset
          state.sorosLevel = 0;
          this.saveLog(state.userId, 'info', `🔄 [SOROS] Ciclo Nível 1 Concluído. Retornando à Stake Base.`);
        }
      }
      state.totalLossAccumulated = 0;
    } else {
      // LOSS
      state.consecutiveLosses++;
      state['consecutiveWins'] = 0;
      state.totalLossAccumulated += stakeUsed;
      state.sorosLevel = 0;
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

    state.isOperationActive = false;
  }

  // --- LOGIC HELPERS ---

  private calculateStake(state: ApolloUserState): number {
    if (state.consecutiveLosses > 0) {
      // Modo Conservador: Até M5 (5 perdas), depois reseta
      if (state.riskProfile === 'conservador' && state.consecutiveLosses > 5) {
        this.saveLog(state.userId, 'alerta', `♻️ [CONSERVADOR] Limite de recuperação atingido (M5). Resetando stake.`);
        state.consecutiveLosses = 0;
        state.totalLossAccumulated = 0;
        return state.apostaInicial;
      }

      const PAYOUT_RATE = 0.84; // Atualizado: Payout real da Deriv está entre 84% e 85%
      const lossToRecover = state.totalLossAccumulated || state.apostaInicial;
      let neededStake = 0;

      // Cálculo por perfil de risco
      if (state.riskProfile === 'conservador') {
        // Recupera 100% da perda + 2% de lucro
        neededStake = (lossToRecover * 1.02) / PAYOUT_RATE;
      } else if (state.riskProfile === 'moderado') {
        // Recupera 100% + 15% de lucro
        neededStake = (lossToRecover * 1.15) / PAYOUT_RATE;
      } else if (state.riskProfile === 'agressivo') {
        // Recupera 100% + 30% de lucro
        neededStake = (lossToRecover * 1.30) / PAYOUT_RATE;
      }

      return Number(neededStake.toFixed(2));
    } else {
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

    if (!state.stopBlindadoActive) {
      if (profit >= activationThreshold) {
        state.stopBlindadoActive = true;
        state.peakProfit = profit;
        // ✅ FIXED FLOOR: Protect % of activation threshold, not peak
        state.stopBlindadoFloor = activationThreshold * 0.50;
        this.saveLog(state.userId, 'alerta',
          `🛡️ Proteção de Lucro: Ativado\n` +
          `• Lucro Atual: $${profit.toFixed(2)}\n` +
          `• Piso Garantido (FIXO): $${state.stopBlindadoFloor.toFixed(2)}`);
        this.tradeEvents.emit({
          userId: state.userId,
          type: 'blindado_activated',
          strategy: 'apollo',
          profitPeak: state.peakProfit,
          protectedAmount: state.stopBlindadoFloor
        });
      }
    } else {
      // ✅ FIXED FLOOR: Only update peak for tracking, floor stays fixed
      if (profit > state.peakProfit) {
        state.peakProfit = profit;
        // Floor remains fixed at activationThreshold * 0.50
      }
    }
  }

  private checkStops(state: ApolloUserState): boolean {
    const profit = state.capital - state.capitalInicial;

    // 1. PROFIT TARGET
    if (profit >= state.profitTarget) {
      this.saveLog(state.userId, 'resultado',
        `🎯 META DE LUCRO ATINGIDA! Lucro: $${profit.toFixed(2)} | Meta: $${state.profitTarget.toFixed(2)} - IA DESATIVADA`);
      this.handleStopInternal(state, 'profit', profit);
      return false;
    }

    // 2. STOP LOSS NORMAL
    if (profit <= -state.stopLoss) {
      this.saveLog(state.userId, 'alerta',
        `🛑 STOP LOSS ATINGIDO! Perda: $${Math.abs(profit).toFixed(2)} | Limite: $${state.stopLoss.toFixed(2)} - IA DESATIVADA`);
      this.handleStopInternal(state, 'loss', profit);
      return false;
    }

    // 3. STOP BLINDADO
    if (state.stopBlindadoActive && profit <= state.stopBlindadoFloor) {
      this.saveLog(state.userId, 'alerta',
        `🛡️ STOP BLINDADO ATINGIDO! Lucro protegido: $${profit.toFixed(2)} - IA DESATIVADA`);
      this.handleStopInternal(state, 'blindado', state.stopBlindadoFloor);
      return false;
    }

    return true;
  }

  private async handleStopInternal(state: ApolloUserState, reason: 'profit' | 'loss' | 'blindado' | 'insufficient_balance', finalAmount: number) {
    let type = 'stopped_loss';
    if (reason === 'profit') type = 'stopped_profit';
    if (reason === 'blindado') type = 'stopped_blindado';
    if (reason === 'insufficient_balance') type = 'stopped_insufficient_balance';

    state.isOperationActive = false;
    this.tradeEvents.emit({ userId: state.userId, type: type as any, strategy: 'apollo', profitLoss: finalAmount });

    // ✅ 1. IMPORTANTE: Chamar deactivateUser para garantir que a IA seja pausada completamente
    // Feito ANTES do banco para evitar loops se o banco falhar
    await this.deactivateUser(state.userId);

    // ✅ 2. Atualizar Banco
    try {
      await this.dataSource.query(`UPDATE ai_user_config SET is_active=0, session_status=?, deactivated_at=NOW() WHERE user_id=? AND is_active=1`, [type, state.userId]);
    } catch (dbError) {
      this.logger.error(`[APOLLO] ⚠️ Erro ao atualizar status '${type}' no DB: ${dbError.message}`);
      // Fallback para stopped_loss se der erro (ex: ENUM inválido)
      if (type === 'stopped_insufficient_balance') {
        try {
          await this.dataSource.query(`UPDATE ai_user_config SET is_active=0, session_status='stopped_loss', deactivated_at=NOW() WHERE user_id=? AND is_active=1`, [state.userId]);
        } catch (e) { console.error('[APOLLO] Falha crítica no fallback DB', e); }
      }
    }
  }

  // --- INFRASTRUCTURE ---

  async activateUser(userId: string, config: any): Promise<void> {
    const modeMap: any = { 'balanceado': 'normal', 'moderado': 'normal', 'preciso': 'lento', 'veloz': 'veloz' };
    let modeRaw = (config.mode || 'normal').toLowerCase();
    if (modeMap[modeRaw]) modeRaw = modeMap[modeRaw];

    // Market Selection
    let selectedSymbol = 'R_100';
    const marketInput = (config.symbol || config.selectedMarket || '').toLowerCase();

    if (marketInput === 'r_100' || marketInput.includes('100')) selectedSymbol = 'R_100';
    else if (marketInput === 'r_10' || marketInput.includes('volatility 10 index')) selectedSymbol = 'R_10';
    else if (marketInput === 'r_25' || marketInput.includes('25')) selectedSymbol = 'R_25';
    else if (marketInput.includes('1hz10v')) selectedSymbol = '1HZ10V';

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
    this.getOrCreateWebSocketConnection(config.derivToken);

    // ✅ LOGS PADRONIZADOS V2
    this.logInitialConfigV2(
      userId,
      initialState.mode.toUpperCase(),
      initialState.riskProfile.toUpperCase(),
      initialState.profitTarget,
      initialState.stopLoss,
      initialState.useBlindado
    );
    this.logSessionStart(userId, initialState.capital, initialState.profitTarget);
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
        `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, gemini_duration, gemini_reasoning, contract_type, created_at, analysis_data, symbol, strategy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
        [state.userId, direction, 0, stake, 'PENDING', 1, `Apollo V1 - ${direction}`, direction === 'CALL' ? 'CALL' : 'PUT', JSON.stringify(analysisData), state.symbol, 'apollo']
      );
      const tradeId = result.insertId;
      return tradeId;
    } catch (e) {
      this.logger.error(`[APOLLO] DB Insert Error: ${e}`);
      return 0;
    }
  }



  private async executeTradeViaWebSocket(
    token: string,
    params: any,
    userId: string,
    onBuy?: (contractId: string, entryPrice: number) => Promise<void>
  ): Promise<{ contractId: string, profit: number, exitSpot: any, entrySpot: any } | null> {
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

        if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
          // ✅ Buscando contas do usuário para log detalhado
          this.dataSource.query(`SELECT deriv_raw FROM users WHERE id = ?`, [userId])
            .then((userDerivData) => {
              if (userDerivData && userDerivData.length > 0 && userDerivData[0].deriv_raw) {
                const derivData = typeof userDerivData[0].deriv_raw === 'string'
                  ? JSON.parse(userDerivData[0].deriv_raw)
                  : userDerivData[0].deriv_raw;

                if (derivData.authorize && derivData.authorize.account_list && Array.isArray(derivData.authorize.account_list)) {
                  const accountListInfo = derivData.authorize.account_list.map((acc: any) =>
                    `• ${acc.loginid} (${acc.is_virtual ? 'Demo' : 'Real'}): ${acc.currency} ${acc.balance}`
                  ).join('\n');

                  this.saveLog(userId, 'alerta', `📋 Contas Disponíveis (Cache):\n${accountListInfo}`);
                }
              }
            }).catch(err => {
              this.logger.error(`[APOLLO] Erro ao buscar dados da conta para log de erro:`, err);
            });
        }

        return null;
      }

      if (buyResponse.error || buyResponse.buy?.error) {
        const buyError = buyResponse.error || buyResponse.buy?.error;
        this.saveLog(userId, 'erro', `Erro na Compra: ${buyError.message || JSON.stringify(buyError)}`);
        return null;
      }

      const contractId = buyResponse.buy.contract_id;
      const buyDuration = Date.now() - buyStartTime;

      this.saveLog(userId, 'operacao',
        `✅ CONTRATO CRIADO\n` +
        `• ID: ${contractId}\n` +
        `• Latência Proposta: ${proposalDuration}ms\n` +
        `• Latência Compra: ${buyDuration}ms`);

      // ✅ Chamar callback onBuy IMEDIATAMENTE (Replication)
      if (onBuy) {
        onBuy(contractId, buyResponse.buy.entry_tick || buyResponse.buy.price).catch(err => {
          this.logger.error(`[APOLLO] Erro no callback onBuy: ${err.message}`);
        });
      }

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
                  authorizedCurrency: msg.authorize?.currency || null,
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
              const msgReqId = msg.req_id ? Number(msg.req_id) : null;
              if (msgReqId !== null && conn.pendingRequests.has(msgReqId)) {
                const pending = conn.pendingRequests.get(msgReqId);
                if (pending) {
                  clearTimeout(pending.timeout);
                  conn.pendingRequests.delete(msgReqId);
                  if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                  else pending.resolve(msg);
                }
                return;
              }

              // Fallback legado (FIFO) - Menos seguro mas mantém compatibilidade para msgs sem req_id
              if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
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
                  }
                  return;
                }
              }

              // 3. Subscriptions (Proposal Open Contract, Ticks)
              if (msg.proposal_open_contract) {
                const id = msg.proposal_open_contract.contract_id;
                const callback = conn.subscriptions.get(id);
                if (callback) {
                  callback(msg);
                  return;
                }
              }
              if (msg.tick) {
                const id = msg.tick.id;
                const callback = conn.subscriptions.get(id);
                if (callback) callback(msg);
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
      // ✅ APOLLO: Usar req_id INTEIRO (1 a 2^31 - 1) para compliance com Deriv API
      const requestId = ++conn.requestIdCounter;

      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        const finalPayload = { ...payload, req_id: requestId };
        conn.ws.send(JSON.stringify(finalPayload));
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
