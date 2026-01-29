import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { CopyTradingService } from '../../copy-trading/copy-trading.service';
import { TradeEventsService } from '../trade-events.service';
import { formatCurrency } from '../../utils/currency.utils';


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

export type ApolloMode = 'veloz' | 'normal' | 'lento' | 'preciso';

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
  currentStake: number;

  // New Strategy State (Digit Refactor)
  analysisType: 'PRINCIPAL' | 'RECUPERACAO';
  lossStreak: number;
  recoveryTarget: number;
  recoveredAmount: number;
  lossStreakRecovery: number;
  skipSorosNext: boolean;
  consecutiveWins: number;

  // Defense / Blindado
  defenseMode: boolean; // Active after 3 losses
  peakProfit: number;
  stopBlindadoFloor: number;
  stopBlindadoActive: boolean;

  // Statistics
  ticksColetados: number;
  totalLossAccumulated: number;
  lastLogTimePerType: Map<string, number>;
  isStopped: boolean;
  lastDirection?: string;
  lastContractType?: string;
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);
  private users = new Map<string, ApolloUserState>();
  private marketTicks = new Map<string, number[]>(); // Store prices per market
  private marketDigits = new Map<string, number[]>(); // Store last digits per market (max 200)
  private lastLogTimeNodes = new Map<string, number>(); // ✅ Heartbeat per symbol
  private lastRejectionLog = new Map<string, number>(); // ✅ Throttling for rejection logs
  private defaultSymbol = 'R_10';
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
  // 🎨 HELPERS DE LOG PADRÃO ZENIX v3.0 (APOLLO REFINED)
  // ============================================

  private logInitialConfigV2(userId: string, mode: string, riskProfile: string, profitTarget: number, stopLoss: number, useBlindado: boolean) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `INÍCIO DE SESSÃO DIÁRIA
Título: Início de Sessão
Estratégia: APOLLO (Price Action)
Saldo Inicial: ${formatCurrency(state?.capital || 0, currency)}
Meta de Lucro: ${profitTarget > 0 ? formatCurrency(profitTarget, currency) : 'N/A'}
Stop Loss: ${stopLoss > 0 ? formatCurrency(stopLoss, currency) : 'N/A'}
Símbolo: ${state?.symbol || 'N/A'}
Modo Inicial: ${mode.toUpperCase()}
Ação: iniciar coleta de dados`;

    this.saveLog(userId, 'analise', message);
  }

  private logSessionStart(userId: string, initialBalance: number, meta: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `INÍCIO DE SESSÃO
Título: Início de Sessão
Saldo Inicial: ${formatCurrency(initialBalance, currency)}
Meta de Lucro: ${formatCurrency(meta, currency)}
Stop Loss: ${formatCurrency(state?.stopLoss || 0, currency)}
Estratégia: APOLLO
Símbolo: ${state?.symbol || 'R_100'}
Modo Inicial: ${state?.mode.toUpperCase() || 'VELOZ'}
Ação: iniciar coleta de dados`;

    this.saveLog(userId, 'analise', message);
  }

  private logDataCollection(userId: string, current: number, target: number) {
    const message = `COLETA DE DADOS
Título: Coleta de Dados em Andamento
Meta de Coleta: ${target} ticks
Progresso: ${current} / ${target}
Status: aguardando ticks suficientes
Ação: aguardar coleta mínima`;

    this.saveLog(userId, 'analise', message);
  }

  private logAnalysisStarted(userId: string, mode: string) {
    const message = `ANÁLISE INICIADA
Título: Análise de Mercado
Tipo de Análise: PRINCIPAL (Price Action)
Modo Ativo: ${mode.toUpperCase()}
Contrato Avaliado: Under 8 / Under 4
Objetivo: identificar sinal válido`;

    this.saveLog(userId, 'analise', message);
  }

  private logSignalGenerated(userId: string, mode: string, signal: string, filters: string[], probability: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `SINAL GERADO
Título: Sinal de Entrada
Análise: ${state?.defenseMode ? 'RECUPERAÇÃO' : 'PRINCIPAL'}
Modo: ${mode.toUpperCase()}
Direção: ${signal}
Força do Sinal: ${probability}%
Contrato: Digits ${signal.replace('DIGIT', '')}
Stake Calculada: ${formatCurrency(state?.apostaInicial || 0, currency)}`;

    this.saveLog(userId, 'sinal', message);
  }

  private logTradeResultV2(
    userId: string,
    result: 'WIN' | 'LOSS',
    profit: number,
    balance: number,
    contractInfo?: { exitDigit?: string }
  ) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';

    if (result === 'WIN') {
      const message = `RESULTADO — WIN
Título: Resultado da Operação
Status: WIN
Direção: ${state?.lastDirection?.toUpperCase() || 'UNDER'}
Contrato: Digits ${state?.lastContractType?.replace('DIGIT', '') || 'Under'} (1 tick)
Resultado Financeiro: +${formatCurrency(profit, currency)}
Saldo Atual: ${formatCurrency(balance, currency)}`;
      this.saveLog(userId, 'vitoria', message);
    } else {
      const message = `RESULTADO — LOSS
Título: Resultado da Operação
Status: LOSS
Direção: ${state?.lastDirection?.toUpperCase() || 'UNDER'}
Contrato: Digits ${state?.lastContractType?.replace('DIGIT', '') || 'Under'} (1 tick)
Resultado Financeiro: -${formatCurrency(Math.abs(profit), currency)}
Saldo Atual: ${formatCurrency(balance, currency)}`;
      this.saveLog(userId, 'derrota', message);
    }
  }

  private logStopActivated(userId: string, type: 'PROFIT' | 'LOSS' | 'BLINDADO', value: number, limit: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';

    if (type === 'PROFIT') {
      const message = `META DE LUCRO ATINGIDA
Status: Meta Alcançada
Lucro: ${formatCurrency(value, currency)}
Meta: ${formatCurrency(limit, currency)}
Ação: IA DESATIVADA`;
      this.saveLog(userId, 'resultado', message);
    } else if (type === 'LOSS') {
      const message = `STOP LOSS ATINGIDO
Status: Limite de Perda
Perda: ${formatCurrency(value, currency)}
Limite: ${formatCurrency(limit, currency)}
Ação: IA DESATIVADA`;
      this.saveLog(userId, 'alerta', message);
    } else if (type === 'BLINDADO') {
      const message = `STOP BLINDADO ATINGIDO
Status: Lucro Protegido
Lucro Protegido: ${formatCurrency(value, currency)}
Ação: IA DESATIVADA`;
      this.saveLog(userId, 'info', message);
    }
  }

  private logBlindadoActivation(userId: string, currentProfit: number, protectedFloor: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `🛡️ STOP BLINDADO ATIVADO
Status: Proteção de Lucro Ativa
Lucro Atual: ${formatCurrency(currentProfit, currency)}
Piso Protegido: ${formatCurrency(protectedFloor, currency)}
Percentual: 40%
Ação: monitorando para proteger ganhos`;

    this.saveLog(userId, 'info', message);
  }

  private logMartingaleLevelV2(userId: string, level: number | string, stake: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `NÍVEL DE MARTINGALE
Título: Recuperação Ativa
Nível Atual: M${level}
Multiplicador: ${(stake / (state?.apostaInicial || 1)).toFixed(1)}x
Próxima Stake: ${formatCurrency(stake, currency)}
Limite Máximo: M12`;

    this.saveLog(userId, 'alerta', message);
  }


  private logSuccessfulRecoveryV2(userId: string, totalLoss: number, amountRecovered: number, currentBalance: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `RECUPERAÇÃO CONCLUÍDA
Título: Recuperação Finalizada
Alvo Atingido: ${formatCurrency(amountRecovered, currency)}
Saldo Atual: ${formatCurrency(currentBalance, currency)}
Ação: reset para análise principal`;

    this.saveLog(userId, 'resultado', message);
  }

  private logContractChange(userId: string, oldContract: string, newContract: string, reason: string) {
    const message = `AJUSTE DE OPERAÇÃO
Título: Adaptação Apollo
De: ${oldContract}
Para: ${newContract}
Motivo: ${reason}`;

    this.saveLog(userId, 'info', message);
  }

  private logBlockedEntry(userId: string, reason: string, type: 'FILTRO' | 'ESTADO') {
    const message = `ENTRADA BLOQUEADA — ${type}
Título: Entrada Bloqueada
Motivo: ${reason}
${type === 'FILTRO' ? 'Critério Avaliado: filtros' : 'Estado Atual: bloqueado'}
Ação: aguardar próximo ciclo`;

    this.saveLog(userId, 'alerta', message);
  }

  private logWinStreak(userId: string, count: number, profit: number) {
    const state = this.users.get(userId);
    const currency = state?.currency || 'USD';
    const message = `SEQUÊNCIA DE VITÓRIAS
Título: Rendimento Positivo
Vitórias: ${count} seguidas
Lucro Acumulado: ${formatCurrency(profit, currency)}
Status: Alta Escalabilidade`;

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

    // Initialize ticks and digits for symbol if not exists
    if (!this.marketTicks.has(symbol)) {
      this.marketTicks.set(symbol, []);
      this.marketDigits.set(symbol, []);
    }

    const ticks = this.marketTicks.get(symbol)!;
    const digits = this.marketDigits.get(symbol)!;

    ticks.push(tick.value);
    if (ticks.length > 200) ticks.shift();

    // D[i] = floor(price[i] * 10) mod 10
    const digitValue = Math.floor(tick.value * 10) % 10;
    digits.push(digitValue);
    if (digits.length > 200) digits.shift(); // Long window is 200

    // Global Heartbeat (per symbol)
    const now = Date.now();
    const lastLog = this.lastLogTimeNodes.get(symbol) || 0;
    if (now - lastLog > 10000) {
      const usersOnSymbol = Array.from(this.users.values()).filter(u => u.symbol === symbol).length;
      this.logger.debug(`[APOLLO][${symbol}] 📊 Ticks/Digits: ${digits.length}/200 | Users: ${usersOnSymbol}`);
      this.lastLogTimeNodes.set(symbol, now);
    }

    for (const state of this.users.values()) {
      if (state.isOperationActive) continue;
      if (state.symbol !== symbol) continue;

      this.checkAndExecute(state, ticks, digits);
    }
  }

  private async checkAndExecute(state: ApolloUserState, ticks: number[], digits: number[]) {
    // 1. CHECK STOPS AND BLINDADO
    await this.checkApolloLimits(state);
    if (state.isStopped) return;

    // 2. TRIGGER RECOVERY & MODE DEGRADATION
    // Active if loss_streak >= 2
    if (state.consecutiveLosses >= 2) {
      // Degradação de Modo (Igual Atlas)
      if (state.consecutiveLosses >= 4 && state.mode !== 'preciso') {
        state.mode = 'preciso';
        this.saveLog(state.userId, 'info', `📉 ALTA VOLATILIDADE (${state.consecutiveLosses}x): Modo alterado para PRECISO.`);
      } else if (state.consecutiveLosses >= 2 && state.mode === 'veloz') {
        state.mode = 'normal';
        this.saveLog(state.userId, 'info', `📉 DEFESA ATIVADA (${state.consecutiveLosses}x): Modo alterado para NORMAL.`);
      }

      if (state.analysisType === 'PRINCIPAL') {
        state.analysisType = 'RECUPERACAO';
        state.recoveredAmount = 0;
        state.recoveryTarget = state.totalLossAccumulated;
        this.logContractChange(state.userId, 'UNDER 8', 'UNDER 4', 'Sequência de perdas - Ativando Recuperação');
      }
    }

    // 3. ANALYZE SIGNAL
    const signal = this.analyzeSignal(state, digits);

    if (signal) {
      await this.executeTrade(state, signal);
    }
  }

  private analyzeSignal(state: ApolloUserState, digits: number[]): 'DIGITUNDER_8' | 'DIGITUNDER_4' | null {
    if (state.analysisType === 'PRINCIPAL') {
      // ANÁLISE PRINCIPAL — DIGITS UNDER 8
      // N = 20
      if (digits.length < 20) return null;

      const last20 = digits.slice(-20);
      const count89 = last20.filter(d => d === 8 || d === 9).length;

      // CONDIÇÃO DE ENTRADA DINÂMICA (Baseada no Modo):
      let threshold = 6; // Veloz
      if (state.mode === 'normal') threshold = 5;
      else if (state.mode === 'preciso') threshold = 4;

      if (count89 < threshold) {
        this.logSignalGenerated(state.userId, 'PRINCIPAL', 'UNDER 8', [`Dígitos 8,9: ${count89} < ${threshold} (N=20)`], 77);
        return 'DIGITUNDER_8';
      } else {
        // LOG DE REJEIÇÃO (Throttled)
        const now = Date.now();
        const lastLog = state.lastLogTimePerType.get('REJ_UNDER8') || 0;
        if (now - lastLog > 30000) {
          this.logBlockedEntry(state.userId, `Dígitos 8,9 em excesso (${count89} >= ${threshold})`, 'FILTRO');
          state.lastLogTimePerType.set('REJ_UNDER8', now);
        }
      }
    } else {
      // ANÁLISE DE RECUPERAÇÃO — DIGITS UNDER 4
      // N_short = 30, N_long = 200
      if (digits.length < 200) return null;

      const last30 = digits.slice(-30);
      const last200 = digits.slice(-200);

      const count03_short = last30.filter(d => d >= 0 && d <= 3).length;
      const count03_long = last200.filter(d => d >= 0 && d <= 3).length;

      const P_short = count03_short / 30;
      const P_long = count03_long / 200;

      const count89_short = last30.filter(d => d === 8 || d === 9).length;

      // ✅ CONDIÇÕES DE ENTRADA DINÂMICAS:
      let minP = 0.47;
      if (state.mode === 'normal') minP = 0.50;
      else if (state.mode === 'preciso') minP = 0.53;

      const cond1 = P_short >= minP;
      const cond2 = (P_short - P_long) >= 0.02;
      const cond3 = count89_short <= 8;
      const now = Date.now();
      const throttleTime = 30000; // 30 segundos

      if (cond1 && cond2 && cond3) {
        this.logSignalGenerated(state.userId, 'RECUPERACAO', 'UNDER 4', [
          `P_short: ${P_short.toFixed(2)} >= ${minP}`,
          `Delta P: ${(P_short - P_long).toFixed(2)} >= 0.02`,
          `C_8_9_short: ${count89_short} <= 8`
        ], 54);
        return 'DIGITUNDER_4';
      } else {
        // LOGS DE REJEIÇÃO (Throttled)
        const lastLog = state.lastLogTimePerType.get('REJ_UNDER4') || 0;
        if (now - lastLog > throttleTime) {
          let reason = 'Densidade insuficiente';
          if (!cond1) reason = `P_short baixa (${P_short.toFixed(2)} < ${minP})`;
          else if (!cond2) reason = `Delta P insuficiente (${(P_short - P_long).toFixed(2)} < 0.02)`;
          else if (!cond3) reason = `Dígitos 8,9 altos em N=30 (${count89_short} > 8)`;

          this.logBlockedEntry(state.userId, reason, 'FILTRO');
          state.lastLogTimePerType.set('REJ_UNDER4', now);
        }
      }
    }

    return null;
  }

  private async executeTrade(state: ApolloUserState, signal: 'DIGITUNDER_8' | 'DIGITUNDER_4') {
    // 1. CALCULATE STAKE
    let stake = this.calculateStake(state);

    // Safety: Minimum Deriv Stake
    stake = Math.max(0.35, stake);

    // ✅ CHECK INSUFFICIENT BALANCE (Before Trade)
    // REMOVIDO: state.capital é inicializado com stakeAmount (entrada), não banca total.
    // A verificação real de saldo deve ser delegada à Deriv API.
    /*
    const requiredBalance = stake * 1.1;
    if (state.capital < requiredBalance) {
      this.saveLog(state.userId, 'erro', `SALDO INSUFICIENTE! Capital atual ($${state.capital.toFixed(2)}) é menor que o necessário ($${requiredBalance.toFixed(2)}) para o stake calculado ($${stake.toFixed(2)}). IA DESATIVADA.`);
      await this.handleStopInternal(state, 'insufficient_balance', state.capital);
      return;
    }
    */

    // 2. ADJUST FOR STOPS
    // ✅ REMOVIDO PARA ALINHAMENTO COM ATLAS:
    // Atlas não impede a trade prévia baseada no stop (retorna Infinity).
    // Isso evita "parada prematura" quando o saldo está próximo do floor/stop.
    // O Stop real será acionado no pós-trade (checkApolloLimits).
    /*
    const currentBalance = state.capital - state.capitalInicial;
    let limitRemaining: number;

    if (state.stopBlindadoActive) {
      limitRemaining = currentBalance - state.stopBlindadoFloor;
    } else {
      limitRemaining = state.stopLoss + currentBalance;
    }

    if (stake > limitRemaining) {
      const originalStake = stake;
      if (limitRemaining < 0.35) {
        const isBlindado = state.stopBlindadoActive;
        const msg = isBlindado
          ? `🛡️ STOP BLINDADO ATINGIDO!\n• Lucro Protegido: $${state.stopBlindadoFloor.toFixed(2)}\n• Ação: Parando IA para preservar lucros.`
          : `🛑 STOP LOSS ATINGIDO!\n• Limite de Perda: $${state.stopLoss.toFixed(2)}\n• Ação: Parando IA imediatamente.`;

        this.saveLog(state.userId, 'alerta', msg);
        this.handleStopInternal(state, isBlindado ? 'blindado' : 'loss', isBlindado ? state.stopBlindadoFloor : -state.stopLoss);
        return;
      }
      stake = Number(limitRemaining.toFixed(2));
      const adjMsg = state.stopBlindadoActive
        ? `⚠️ AJUSTE DE SEGURANÇA (PROTEÇÃO)\n• Stake Original: $${originalStake.toFixed(2)}\n• Limite Disponível: $${limitRemaining.toFixed(2)}\n• Ação: Reduzindo para $${stake.toFixed(2)} para proteger o capital.`
        : `⚠️ AJUSTE DE SEGURANÇA (STOP LOSS)\n• Stake Original: $${originalStake.toFixed(2)}\n• Limite Disponível: $${limitRemaining.toFixed(2)}\n• Ação: Reduzindo para $${stake.toFixed(2)} para respeitar o Stop Loss.`;

      this.saveLog(state.userId, 'alerta', adjMsg);
    }
    */

    state.currentStake = stake;

    // 3. RECUPERAÇÃO / MARTINGALE LOG
    if (state.consecutiveLosses > 0 || state.analysisType === 'RECUPERACAO') {
      const level = state.analysisType === 'RECUPERACAO' ? `RECUPERAÇÃO (${state.lossStreakRecovery})` : state.consecutiveLosses;
      this.logMartingaleLevelV2(state.userId, level as any, stake);
    }

    // 4. EXECUTE
    state.isOperationActive = true;

    const contractType = 'DIGITUNDER';
    const barrier = signal === 'DIGITUNDER_8' ? '8' : '4';

    state.lastDirection = signal.replace('DIGIT', '');
    state.lastContractType = `Digits ${state.lastDirection}`;

    try {
      const tradeId = await this.createTradeRecord(state, contractType, stake, barrier);
      if (!tradeId) {
        state.isOperationActive = false;
        return;
      }

      const result = await this.executeTradeViaWebSocket(state.derivToken, {
        contract_type: contractType,
        barrier: barrier,
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
                contractType,
                barrier,
                stake,
                percent,
                0, // multiplier
                1, // duration
                't', // duration_unit
                signal,
                'OPEN',
              ]
            );

            // 2. Chamar serviço de cópia para execução imediata
            if (this.copyTradingService) {
              await this.copyTradingService.replicateManualOperation(
                state.userId,
                {
                  contractId: contractId || '',
                  contractType: contractType,
                  symbol: state.symbol,
                  duration: 1,
                  durationUnit: 't',
                  stakeAmount: stake,
                  percent: percent,
                  entrySpot: entryPrice || 0,
                  entryTime: unixTimestamp,
                  barrier: Number(barrier)
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
    // ✅ LOG PADRONIZADO V2: Resultado Detalhado
    this.logTradeResultV2(state.userId, win ? 'WIN' : 'LOSS', profit, state.capital, { exitDigit: result.exitSpot ? result.exitSpot.toString().slice(-1) : '?' });

    // --- UPDATE STATE ---
    if (win) {
      if (state.analysisType === 'RECUPERACAO') {
        state.recoveredAmount += profit;
        state.lossStreakRecovery = 0;
        state.skipSorosNext = true; // Resetar após vitória na recuperação

        // CONDIÇÃO DE FECHAMENTO DA RECUPERAÇÃO: lucro_recuperado >= total_perdido_no_ciclo
        if (state.recoveredAmount >= state.totalLossAccumulated) {
          this.logSuccessfulRecoveryV2(state.userId, state.totalLossAccumulated, state.recoveredAmount, state.capital);
          this.logContractChange(state.userId, 'UNDER 4', 'UNDER 8', 'Recuperação com Sucesso - Retornando à Meta Principal');
          state.analysisType = 'PRINCIPAL';
          state.mode = state.originalMode || 'veloz'; // Resetar Modo (Igual Atlas)
          state.consecutiveLosses = 0;
          state.totalLossAccumulated = 0;
          state.recoveryTarget = 0;
          state.recoveredAmount = 0;
        }
      } else {
        // WIN NORMAL (Bônus: Se ganhou no Martingale, reseta modo também)
        if (state.consecutiveLosses > 0) {
          state.skipSorosNext = true;
          state.mode = state.originalMode || 'veloz'; // Resetar Modo (Igual Atlas)
        }
        state.consecutiveLosses = 0;
        state.totalLossAccumulated = 0;
      }
      state.consecutiveWins++;
      // Log Win Streak
      if (state.consecutiveWins > 1) {
        this.logWinStreak(state.userId, state.consecutiveWins, state.capital - state.capitalInicial);
      }
    } else {
      // LOSS
      state.consecutiveLosses++;
      state.consecutiveWins = 0;
      state.totalLossAccumulated += stakeUsed;

      if (state.analysisType === 'RECUPERACAO') {
        state.lossStreakRecovery++;

      }
    }

    // --- STOP BLINDADO UPDATE ---
    // Removido: Lógica movida para checkApolloLimits (idêntico Atlas)

    // ✅ [ZENIX v3.1] Lucro da SESSÃO (Recalculado após a trade)
    const lucroSessao = state.capital - state.capitalInicial;

    // ✅ [STOP BLINDADO FIX] Atualizar profit_peak se lucro atual for maior
    // Isso é essencial para o Stop Blindado funcionar corretamente
    if (lucroSessao > 0) {
      await this.dataSource.query(
        `UPDATE ai_user_config 
         SET session_balance = ?, 
             profit_peak = GREATEST(COALESCE(profit_peak, 0), ?)
         WHERE user_id = ? AND is_active = 1`,
        [lucroSessao, lucroSessao, state.userId]
      ).catch(e => {
        this.logger.error(`[APOLLO] Erro ao atualizar session_balance e profit_peak:`, e);
      });
    } else {
      // Se está em prejuízo, só atualizar session_balance
      await this.dataSource.query(
        `UPDATE ai_user_config SET session_balance = ? WHERE user_id = ? AND is_active = 1`,
        [lucroSessao, state.userId]
      ).catch(e => { });
    }

    // --- CHECK STOPS (Post-Trade) ---
    await this.checkApolloLimits(state);

    state.isOperationActive = false;
  }

  // --- LOGIC HELPERS ---

  private calculateStake(state: ApolloUserState): number {
    const PAYOUT_UNDER_8 = 0.18; // Payout conservador (safe-payout)
    const PAYOUT_UNDER_4 = 1.20; // Payout conservador para Under 4 (safe-payout)

    // Perfil de Lucro na Recuperação (Igual Atlas)
    let percentualPerfil = 0.15; // Moderado default (15%)
    if (state.riskProfile === 'conservador') percentualPerfil = 0.02; // (2%)
    else if (state.riskProfile === 'agressivo') percentualPerfil = 0.30; // (30%)

    if (state.analysisType === 'RECUPERACAO') {
      // 5️⃣ CÁLCULO DE STAKE — RECUPERAÇÃO (DINÂMICA)
      // Recupera o déficit ATUAL (Total de perdas acumuladas no ciclo - já recuperado)
      const lossToRecover = state.totalLossAccumulated - state.recoveredAmount;
      const stake = (lossToRecover * (1 + percentualPerfil)) / PAYOUT_UNDER_4;
      return Number(stake.toFixed(2));
    } else {
      // 4️⃣ CÁLCULO DE STAKE — META (PRINCIPAL)

      // ✅ RESET APÓS RECUPERAÇÃO/MARTINGALE: Se a flag estiver ativa, ignora Soros desta vez
      if (state.skipSorosNext) {
        state.skipSorosNext = false;
        state.consecutiveWins = 0; // Importante: Reiniciar contagem para que a PRÓXIMA vitória inicie o Soros
        return state.apostaInicial;
      }

      // ✅ CICLO DE SOROS (Fim): Se já ganhou o Soros (2 consecutivas), volta pro base
      if (state.consecutiveWins >= 2) {
        state.consecutiveWins = 0;
        return state.apostaInicial;
      }

      // ✅ SOROS (Meta): Se a última foi WIN (Base), entra com (Base + Lucro)
      if (state.lastResultWin && state.lastProfit > 0 && state.consecutiveWins === 1) {
        return Number((state.apostaInicial + state.lastProfit).toFixed(2));
      }

      // ✅ MARTINGALE (1ª Perda): Tenta recuperar no próximo Under 8
      if (state.consecutiveLosses === 1) {
        // Recupera perda + margem baseada no perfil (2%, 15% ou 30%)
        const stakeMartingale = (state.totalLossAccumulated * (1 + percentualPerfil)) / PAYOUT_UNDER_8;
        return Number(stakeMartingale.toFixed(2));
      }

      // ✅ PADRÃO: Usa o Stake Base
      return state.apostaInicial;
    }
  }

  /**
   * ✅ APOLLO: Verifica limites (meta, stop-loss) - CLONE ATLAS
   */
  private async checkApolloLimits(state: ApolloUserState): Promise<void> {
    const symbol = state.symbol || 'SISTEMA';

    // ✅ [ORION PARALLEL CHECK] - Reerificar limites do banco (Segunda Camada)
    const configResult = await this.dataSource.query(
      `SELECT
        COALESCE(loss_limit, 0) as lossLimit,
        COALESCE(profit_target, 0) as profitTarget,
        COALESCE(session_balance, 0) as sessionBalance,
        COALESCE(stake_amount, 0) as capitalInicial,
        COALESCE(profit_peak, 0) as profitPeak,
        stop_blindado_percent as stopBlindadoPercent,
        is_active
       FROM ai_user_config
       WHERE user_id = ? AND is_active = 1
       LIMIT 1`,
      [state.userId],
    );

    if (!configResult || configResult.length === 0) return;

    const config = configResult[0];
    const lossLimit = parseFloat(config.lossLimit) || 0;
    const profitTarget = parseFloat(config.profitTarget) || 0;
    const capitalInicial = parseFloat(config.capitalInicial) || 0;

    // ✅ [ATLAS ALIGNMENT] Usar valores do DB para garantir paridade estrita
    const lucroAtual = parseFloat(config.sessionBalance) || 0;
    const capitalSessao = capitalInicial + lucroAtual;

    // 1. Meta de Lucro (Profit Target)
    if (profitTarget > 0 && lucroAtual >= profitTarget) {
      this.saveLog(state.userId, 'info',
        `META DE LUCRO ATINGIDA
Status: Meta Alcançada
Lucro: ${formatCurrency(lucroAtual, state.currency)}
Meta: ${formatCurrency(profitTarget, state.currency)}
Ação: IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Meta de lucro atingida: +${formatCurrency(lucroAtual, state.currency)}`, state.userId],
      );

      this.tradeEvents.emit({
        userId: state.userId,
        type: 'stopped_profit',
        strategy: 'apollo',
        symbol: symbol,
        profitLoss: lucroAtual
      });

      this.users.delete(state.userId);
      state.isStopped = true;
      return;
    }

    // 2. Stop-loss blindado (Lógica Atlas)
    if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
      const profitPeak = parseFloat(config.profitPeak) || 0;
      const activationThreshold = profitTarget * 0.40;

      // ✅ [DEBUG] Log para rastrear valores (Igual Atlas)
      this.logger.log(`[APOLLO] 🛡️ Verificando Stop Blindado:
        profitPeak: ${profitPeak}
        activationThreshold: ${activationThreshold}
        profitTarget: ${profitTarget}
        lucroAtual: ${lucroAtual}
        capitalSessao: ${capitalSessao}
        capitalInicial: ${capitalInicial}`);

      if (profitTarget > 0 && profitPeak >= activationThreshold) {
        const factor = (parseFloat(config.stopBlindadoPercent) || 50.0) / 100;
        // ✅ Fixed Floor: Protect % of Activation Threshold
        const valorProtegidoFixo = activationThreshold * factor;
        const stopBlindado = capitalInicial + valorProtegidoFixo;

        // ✅ [DEBUG] Log para rastrear cálculo do piso
        this.logger.log(`[APOLLO] 🛡️ Stop Blindado ATIVO:
          valorProtegidoFixo: ${valorProtegidoFixo}
          stopBlindado: ${stopBlindado}
          capitalSessao: ${capitalSessao}
          Vai parar? ${capitalSessao <= stopBlindado + 0.01}`);

        // ✅ [LOG] Notificar ativação do Stop Blindado (primeira vez)
        const justActivated = profitPeak >= activationThreshold && profitPeak < (activationThreshold + 0.50);
        if (justActivated && !state.stopBlindadoActive) {
          state.stopBlindadoActive = true;
          state.stopBlindadoFloor = valorProtegidoFixo; // Manter state update por compatibilidade de logs
          this.saveLog(state.userId, 'info',
            `🛡️ STOP BLINDADO ATIVADO
Status: Proteção de Lucro Ativa
Lucro Atual: ${formatCurrency(lucroAtual, state.currency)}
Piso Protegido: ${formatCurrency(valorProtegidoFixo, state.currency)}
Percentual: ${config.stopBlindadoPercent}%
Ação: monitorando para proteger ganhos`
          );
        }

        if (capitalSessao <= stopBlindado + 0.01) {
          const lucroFinal = capitalSessao - capitalInicial;
          this.saveLog(state.userId, 'info',
            `STOP BLINDADO ATINGIDO
Status: Lucro Protegido
Lucro Protegido: ${formatCurrency(lucroFinal, state.currency)}
Ação: IA DESATIVADA`
          );

          await this.dataSource.query(
            `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop Blindado: +${formatCurrency(lucroFinal, state.currency)}`, state.userId],
          );

          this.logger.warn(`[APOLLO] 🛡️ STOP BLINDADO - UPDATE executado! session_status = 'stopped_blindado', userId: ${state.userId}`);

          this.tradeEvents.emit({
            userId: state.userId,
            type: 'stopped_blindado',
            strategy: 'apollo',
            symbol: symbol,
            profitProtected: lucroFinal,
            profitLoss: lucroFinal
          });

          this.users.delete(state.userId);
          state.isStopped = true;
          return;
        }
      }
    }

    // 3. Stop Loss Normal
    if (state.isStopped) {
      this.logger.log(`[APOLLO] ⏸️ IA já foi parada, ignorando verificação de Stop Loss Normal`);
      return;
    }

    const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
    if (lossLimit > 0 && perdaAtual >= lossLimit) {
      this.saveLog(state.userId, 'alerta',
        `STOP LOSS ATINGIDO
Status: Limite de Perda
Perda: ${formatCurrency(perdaAtual, state.currency)}
Limite: ${formatCurrency(lossLimit, state.currency)}
Ação: IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Stop Loss atingido: -${formatCurrency(perdaAtual, state.currency)}`, state.userId],
      );

      this.tradeEvents.emit({
        userId: state.userId,
        type: 'stopped_loss',
        strategy: 'apollo',
        symbol: symbol,
        profitLoss: -perdaAtual
      });

      this.users.delete(state.userId);
      state.isStopped = true;
      return;
    }
  }




  // --- INFRASTRUCTURE ---

  async activateUser(userId: string, config: any): Promise<void> {
    const modeMap: any = { 'balanceado': 'normal', 'moderado': 'normal', 'preciso': 'lento', 'veloz': 'veloz' };
    let modeRaw = (config.mode || 'normal').toLowerCase();
    if (modeMap[modeRaw]) modeRaw = modeMap[modeRaw];

    // Market Selection
    let selectedSymbol = 'R_10';
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

      // State Controls
      isStopped: false,
      isOperationActive: false,
      consecutiveLosses: 0,
      lastProfit: 0,
      lastResultWin: false,
      currentStake: 0,

      // New Strategy State
      analysisType: 'PRINCIPAL',
      lossStreak: 0,
      recoveryTarget: 0,
      recoveredAmount: 0,
      lossStreakRecovery: 0,
      skipSorosNext: false,
      consecutiveWins: 0,
      lastLogTimePerType: new Map<string, number>(),

      defenseMode: false,
      peakProfit: 0,
      stopBlindadoFloor: 0,
      stopBlindadoActive: false,
      ticksColetados: 0,
      totalLossAccumulated: 0
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
    const icons: any = {
      info: 'ℹ️',
      tick: '⏱️',
      analise: '🔍',
      sinal: '🟢',
      operacao: '🚀',
      resultado: '�',
      vitoria: '✅',
      derrota: '❌',
      alerta: '⚠️',
      erro: '�',
    };

    this.dataSource.query(`INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, type, icons[type] || '📝', message, JSON.stringify({ strategy: 'apollo' })]
    ).catch(e => console.error('Error saving log', e));

    this.tradeEvents.emitLog({
      userId,
      type,
      message,
      timestamp: new Date()
    });
  }

  // --- WEBSOCKET & TRADE ---

  private async createTradeRecord(state: ApolloUserState, direction: string, stake: number, barrier?: string): Promise<number> {
    const analysisData = {
      strategy: 'apollo',
      mode: state.mode,
      analysisType: state.analysisType,
      lossStreak: state.consecutiveLosses,
      barrier: barrier // Mantido no JSON para referência
    };

    try {
      // ✅ [BUG FIX] Removida coluna 'barrier' que não existe no BD (user solicitou ignorar)
      const result: any = await this.dataSource.query(
        `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, gemini_duration, gemini_reasoning, contract_type, created_at, analysis_data, symbol, strategy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
        [state.userId, direction, 0, stake, 'PENDING', 1, `Apollo Digit - ${direction}`, direction, JSON.stringify(analysisData), state.symbol, 'apollo']
      );
      const tradeId = result.insertId;
      return tradeId;
    } catch (e) {
      this.logger.error(`[APOLLO] DB Insert Error: ${e}`);
      this.saveLog(state.userId, 'erro', `Erro ao registrar operação: ${e.message}`);
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
      this.saveLog(userId, 'erro', `Falha ao conectar na Deriv (Timeout ou Auth). Verifique logs do sistema.`);
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
        barrier: params.barrier,
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
        this.saveLog(userId, 'erro', `FALHA NA ENTRADA: ${errorMessage}`);

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
                this.saveLog(userId, 'erro', `Erro no monitoramento: ${msg.error.message}`);
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
            this.saveLog(userId, 'erro', `Falha ao inscrever no monitoramento: ${e.message}`);
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

      this.logger.debug(`[APOLLO]  [${userId || 'SYSTEM'}] Conexão encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);

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