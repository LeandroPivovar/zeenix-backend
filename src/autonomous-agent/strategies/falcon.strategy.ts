import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import WebSocket from 'ws';
import {
  IAutonomousAgentStrategy,
  AutonomousAgentConfig,
  AutonomousAgentState,
  MarketAnalysis,
  TradeDecision,
} from './common.types';
import { Tick, DigitParity } from '../../ai/ai.service';
import { LogQueueService } from '../../utils/log-queue.service';

/**
 * 🦅 FALCON Strategy para Agente Autônomo - Versão 3.0 (ALINHADO COM ZEUS V4)
 * 
 * CORE: Price Action (Trend + Volatility/Delta)
 * - MODO NORMAL: Janela 7 ticks, 4/6 moves, delta >= 0.5. WR esperado ~76%.
 * - MODO LENTO: Janela 8 ticks, 5/7 moves, delta >= 0.7. WR esperado ~90%.
 * - Gestão: Soros Nível 1 no Normal, Smart Martingale no Lento.
 * - Proteção: Stop Blindado (40% meta ativa, proteção fixa de 50%).
 */

export type NegotiationMode = "NORMAL" | "PRECISO";
export type RiskProfile = "CONSERVADOR" | "MODERADO" | "AGRESSIVO" | "FIXO";
export type AnalysisType = "PRINCIPAL" | "RECUPERACAO";

export type LogColor = "green" | "red" | "blue" | "yellow" | "neutral";

export type ZenixLogId =
  | "LOG_01_SESSION_START"
  | "LOG_02_DATA_COLLECTION"
  | "LOG_03_ANALYSIS_START"
  | "LOG_04_ENTRY_BLOCKED"
  | "LOG_05_SIGNAL_FOUND"
  | "LOG_06_WIN"
  | "LOG_07_LOSS"
  | "LOG_08_SOROS"
  | "LOG_09_MARTINGALE"
  | "LOG_10_MODE_SWITCH"
  | "LOG_11_CONTRACT_SWITCH"
  | "LOG_12_RECOVERY_START"
  | "LOG_13_RECOVERY_SUCCESS"
  | "LOG_14_STRATEGIC_PAUSE"
  | "LOG_15_BLINDADO_STATUS"
  | "LOG_16_BLINDADO_TRIGGER"
  | "LOG_17_STOPLOSS_TRIGGER"
  | "LOG_18_TARGET_REACHED"
  | "LOG_19_SESSION_END"
  | "LOG_20_API_ERROR";

export interface FalconLogEvent {
  ts: number;
  id: ZenixLogId;
  title: string;
  lines: Array<{ text: string; color?: LogColor }>;
}

export const FALCON_SUBTITLE = "Agente Autônomo de Análise Tick a Tick em Volatility Indices";

export const FALCON_CONSTANTS = {
  symbol: "R_50", // Volatility 50 Index (R_50)
  payoutPrincipal: 0.34, // Digit Over 2 (37% - 3% markup)
  payoutRecovery: 0.84,  // Digit Over 4 (87% - 3% markup)
  martingaleMaxLevel: 5, // Limite para perfil Conservador
  strategicPauseSeconds: 60,
  cooldownWinSeconds: 2,
  cooldownLossSeconds: 2,
  dataCollectionTicks: 74, // Max window (J74)
  cycles: 4,
  cyclePercent: 0.25,
};

export const FALCON_MODES = {
  NORMAL: {
    principal: { window: 67, targets: [1, 2, 3, 4, 5], limit: 42, barrier: 2 },
    recovery: { window: 73, targets: [1, 2, 3, 4, 5], limit: 26, barrier: 4 }
  },
  PRECISO: {
    principal: { window: 74, targets: [6, 7], limit: 23, barrier: 2 },
    recovery: { window: 73, targets: [1, 2, 3, 4, 5], limit: 26, barrier: 4 }
  }
};

interface FalconUserConfig extends AutonomousAgentConfig {
  strategyName: 'FALCON';
  subtitle: string;
  symbol: string;
  is24x7: boolean;

  initialCapital: number;
  profitTarget: number;
  stopLoss: number;
  baseStake: number;

  riskProfile: RiskProfile;

  enableStopLossBlindado: boolean;
  blindadoTriggerPctOfTarget: number;
  blindadoProtectPctOfPeak: number;

  payoutPrincipal: number;
  payoutRecovery: number;

  strategicPauseEnabled: boolean;
  strategicPauseSeconds: number;
  cooldownWinSeconds: number;
  cooldownLossSeconds: number;
  dataCollectionTicks: number;

  limitOpsDay?: number;
  limitOpsCycle?: number;

  mode?: NegotiationMode;
  operationMode?: NegotiationMode;

  // Legacy/Infra compat
  initialBalance: number;
  stopLossType?: 'normal' | 'blindado';
}

interface FalconUserState extends AutonomousAgentState {
  timestamp?: number;

  // Session
  balance: number;
  profit: number;
  peakProfit: number;

  // Cycle Management (V4)
  cycleCurrent: number;
  cycleTarget: number;
  cycleProfit: number;
  cycleMaxDrawdown: number;
  cyclePeakProfit: number;
  cycleOps: number;

  // Blindado State
  blindadoActive: boolean;
  blindadoFloorProfit: number;

  // Flags
  inStrategicPauseUntilTs: number;
  sessionEnded: boolean;
  endReason?: "TARGET" | "STOPLOSS" | "BLINDADO";

  // Automático
  mode: NegotiationMode;
  analysis: AnalysisType;

  // Recovery
  consecutiveLosses: number;
  perdasAcumuladas: number;

  // Control
  lastOpTs: number;
  cooldownUntilTs: number;
  lastRejectionReason?: string;

  // Metrics
  opsTotal: number;
  wins: number;
  losses: number;

  // Compatibility (Legacy names)
  saldoInicial: number;
  lucroAtual: number;
  picoLucro: number;
  consecutiveWins: number;
  opsCount: number;
  stopBlindadoAtivo: boolean;
  pisoBlindado: number;
  lastProfit: number;
  martingaleLevel: number;
  sorosLevel: number;
  totalLosses: number;
  recoveryAttempts: number;
  totalLossAccumulated: number;
  lastDeniedLogData?: { probability: number; signal: string | null };
  lastSignals: Array<{ direction: string; timestamp: number }>;
  consecutiveLossesSinceModeChange: number;

  // System
  currentContractId: string | null;
  currentTradeId: number | null;
  isWaitingContract: boolean;
  lastContractType?: string;
  ticksSinceLastAnalysis: number;
  lastDigits: number[];
  lastOpProfit?: number;
  lastDeniedLogTime?: number;
  waitingContractStartTime: number | null;
}
@Injectable()
export class FalconStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'falcon';
  displayName = '🦅 FALCON';
  description = 'Agente de alta precisão com recuperação inteligente e gestão blindada';

  private readonly logger = new Logger(FalconStrategy.name);
  private readonly userConfigs = new Map<string, FalconUserConfig>();
  private readonly userStates = new Map<string, FalconUserState>();
  private readonly ticks = new Map<string, Tick[]>();
  private readonly maxTicks = 200;
  private readonly comissaoPlataforma = 0.03; // 3%
  private readonly processingLocks = new Map<string, boolean>(); // ✅ Lock para evitar processamento simultâneo
  private readonly appId: string;

  // ✅ Pool de conexões WebSocket por token (reutilização - uma conexão por token)
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
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async onModuleInit() {
    this.logger.log('🦅 FALCON Strategy inicializado');
    await this.initialize();
  }

  async initialize(): Promise<void> {
    await this.syncActiveUsersFromDb();
  }

  /**
   * Sincroniza usuários ativos do banco de dados
   */
  private async syncActiveUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT 
            c.user_id, c.initial_stake, c.daily_profit_target, c.daily_loss_limit, 
            c.initial_balance, c.deriv_token as config_token, c.currency, c.symbol, c.agent_type, c.stop_loss_type, c.risk_level,
            u.token_demo, u.token_real, u.deriv_raw,
            s.trade_currency
         FROM autonomous_agent_config c
         JOIN users u ON c.user_id = u.id
         LEFT JOIN user_settings s ON c.user_id = s.user_id
         WHERE c.is_active = TRUE 
           AND c.agent_type = 'falcon'
           AND c.session_status NOT IN ('stopped_profit', 'stopped_loss', 'stopped_blindado')`,
      );

      for (const user of activeUsers) {
        const userId = user.user_id.toString();

        // ✅ [RESOLUÇÃO DE TOKEN CENTRALIZADA]
        let resolvedToken = user.config_token;
        const wantDemo = user.trade_currency === 'DEMO';

        if (wantDemo) {
          if (user.token_demo) {
            resolvedToken = user.token_demo;
          } else if (user.deriv_raw) {
            try {
              const raw = typeof user.deriv_raw === 'string' ? JSON.parse(user.deriv_raw) : user.deriv_raw;
              if (raw.tokensByLoginId) {
                const entry = Object.entries(raw.tokensByLoginId).find(([lid]) => (lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              }
            } catch (e) {
              this.logger.warn(`[Falcon][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token: ${e.message}`);
            }
          }
        } else {
          if (user.token_real) {
            resolvedToken = user.token_real;
          } else if (user.deriv_raw) {
            try {
              const raw = typeof user.deriv_raw === 'string' ? JSON.parse(user.deriv_raw) : user.deriv_raw;
              if (raw.tokensByLoginId) {
                const entry = Object.entries(raw.tokensByLoginId).find(([lid]) => !(lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              }
            } catch (e) {
              this.logger.warn(`[Falcon][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token (Real): ${e.message}`);
            }
          }
        }

        const rawRisk = user.risk_level || 'balanced';
        const riskProfile = this.mapRiskProfile(rawRisk);

        const config: FalconUserConfig = {
          userId: userId,
          initialStake: parseFloat(user.initial_stake),
          dailyProfitTarget: parseFloat(user.daily_profit_target),
          dailyLossLimit: parseFloat(user.daily_loss_limit),
          derivToken: resolvedToken,
          currency: user.currency,

          strategyName: "FALCON",
          subtitle: FALCON_SUBTITLE,
          symbol: FALCON_CONSTANTS.symbol,
          is24x7: true,

          initialCapital: parseFloat(user.initial_balance) || 0,
          profitTarget: parseFloat(user.daily_profit_target),
          stopLoss: parseFloat(user.daily_loss_limit),
          baseStake: parseFloat(user.initial_stake),

          riskProfile: riskProfile,

          enableStopLossBlindado: user.stop_loss_type === 'blindado',
          blindadoTriggerPctOfTarget: 0.4,
          blindadoProtectPctOfPeak: 0.5,

          payoutPrincipal: FALCON_CONSTANTS.payoutPrincipal,
          payoutRecovery: FALCON_CONSTANTS.payoutRecovery,

          strategicPauseEnabled: true,
          strategicPauseSeconds: FALCON_CONSTANTS.strategicPauseSeconds,
          cooldownWinSeconds: FALCON_CONSTANTS.cooldownWinSeconds,
          cooldownLossSeconds: FALCON_CONSTANTS.cooldownLossSeconds,
          dataCollectionTicks: FALCON_CONSTANTS.dataCollectionTicks,

          limitOpsDay: 2000,
          limitOpsCycle: 500,

          initialBalance: parseFloat(user.initial_balance) || 0,
          stopLossType: user.stop_loss_type === 'blindado' ? 'blindado' : 'normal'
        };

        this.userConfigs.set(userId, config);

        if (!this.userStates.has(userId)) {
          this.initializeUserState(userId, config);
        }

        this.logger.log(`[Falcon] ✅ Usuário sincronizado: ${userId} - Perfil: ${config.riskProfile}`);
      }
    } catch (error) {
      this.logger.error('[Falcon] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * ✅ HELPER: Mapear Risk Profile (Frontend -> Backend)
   */
  private mapRiskProfile(rawRisk: string): RiskProfile {
    const r = rawRisk.toLowerCase();
    if (r === 'fixed' || r === 'fixo') return 'FIXO';
    if (r === 'conservative' || r === 'conservador') return 'CONSERVADOR';
    if (r === 'balanced' || r === 'moderado' || r === 'equilibrio') return 'MODERADO';
    if (r === 'aggressive' || r === 'agressivo') return 'AGRESSIVO';
    return 'MODERADO';
  }

  /**
   * Inicializa estado do usuário para Zeus V4 logic
   */
  private initializeUserState(userId: string, config: FalconUserConfig): void {
    const state: FalconUserState = {
      userId,
      isActive: true,
      balance: config.initialCapital,
      profit: 0,
      peakProfit: 0,

      // AutonomousAgentState compatibility
      currentProfit: 0,
      currentLoss: 0,
      operationsCount: 0,

      // Cycle Management (V4)
      cycleCurrent: 1,
      cycleTarget: config.profitTarget * FALCON_CONSTANTS.cyclePercent,
      cycleProfit: 0,
      cycleMaxDrawdown: (config.profitTarget * FALCON_CONSTANTS.cyclePercent) * 0.60,
      cyclePeakProfit: 0,
      cycleOps: 0,

      blindadoActive: false,
      blindadoFloorProfit: 0,

      inStrategicPauseUntilTs: 0,
      sessionEnded: false,

      mode: (config.mode || config.operationMode || (config.riskProfile === 'CONSERVADOR' ? 'PRECISO' : 'NORMAL')) as NegotiationMode,
      analysis: "PRINCIPAL",

      consecutiveLosses: 0,
      perdasAcumuladas: 0,

      lastOpTs: 0,
      cooldownUntilTs: 0,

      opsTotal: 0,
      wins: 0,
      losses: 0,

      // Compatibility (Legacy)
      saldoInicial: config.initialCapital,
      lucroAtual: 0,
      picoLucro: 0,
      consecutiveWins: 0,
      opsCount: 0,
      stopBlindadoAtivo: false,
      pisoBlindado: 0,
      lastProfit: 0,
      martingaleLevel: 0,
      sorosLevel: 0,
      totalLosses: 0,
      recoveryAttempts: 0,
      totalLossAccumulated: 0,
      lastSignals: [],
      consecutiveLossesSinceModeChange: 0,

      // System
      currentContractId: null,
      currentTradeId: null,
      isWaitingContract: false,
      ticksSinceLastAnalysis: 0,
      lastDigits: [],
      waitingContractStartTime: null,
    };

    this.userStates.set(userId, state);
    this.ticks.set(userId, []);
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    const rawRisk = (config as any).riskProfile || (config as any).riskLevel || 'balanced';
    const risk = this.mapRiskProfile(rawRisk);

    const falconConfig: FalconUserConfig = {
      ...config,

      strategyName: "FALCON",
      subtitle: FALCON_SUBTITLE,
      symbol: FALCON_CONSTANTS.symbol,
      is24x7: true,

      initialCapital: config.initialBalance || 0,
      profitTarget: config.dailyProfitTarget,
      stopLoss: config.dailyLossLimit,
      baseStake: parseFloat(config.initialStake.toString()),

      riskProfile: risk,

      enableStopLossBlindado: (config as any).stopLossType === 'blindado',
      blindadoTriggerPctOfTarget: 0.4,
      blindadoProtectPctOfPeak: 0.5,

      payoutPrincipal: FALCON_CONSTANTS.payoutPrincipal,
      payoutRecovery: FALCON_CONSTANTS.payoutRecovery,

      strategicPauseEnabled: true,
      strategicPauseSeconds: FALCON_CONSTANTS.strategicPauseSeconds,
      cooldownWinSeconds: FALCON_CONSTANTS.cooldownWinSeconds,
      cooldownLossSeconds: FALCON_CONSTANTS.cooldownLossSeconds,
      dataCollectionTicks: FALCON_CONSTANTS.dataCollectionTicks,

      limitOpsDay: ((config as any).mode === 'PRECISO' || (config as any).operationMode === 'PRECISO' || risk === 'CONSERVADOR') ? 400 : 2000,
      limitOpsCycle: ((config as any).mode === 'PRECISO' || (config as any).operationMode === 'PRECISO' || risk === 'CONSERVADOR') ? 100 : 500,

      initialBalance: config.initialBalance || 0,
      stopLossType: (config as any).stopLossType || 'normal'
    };

    if (this.userConfigs.has(userId)) {
      const existingConfig = this.userConfigs.get(userId);
      const hasSignificantChange = existingConfig && (
        existingConfig.riskProfile !== falconConfig.riskProfile ||
        existingConfig.dailyProfitTarget !== falconConfig.dailyProfitTarget ||
        existingConfig.dailyLossLimit !== falconConfig.dailyLossLimit ||
        existingConfig.initialStake !== falconConfig.initialStake ||
        existingConfig.symbol !== falconConfig.symbol
      );

      if (!hasSignificantChange) {
        this.userConfigs.set(userId, falconConfig);
        return;
      }

      this.logger.log(`[Falcon][${userId}] 🔄 Atualizando configuração (Mudança detectada).`);
      this.userConfigs.set(userId, falconConfig);

      const state = this.userStates.get(userId);
      if (state && !state.isActive) {
        state.isActive = true;
      }

      const mode = state?.mode || 'PRECISO';
      this.logInitialConfigV2(userId, {
        agentName: this.displayName,
        operationMode: falconConfig.operationMode || 'NORMAL',
        riskProfile: falconConfig.riskProfile || 'MODERADO',
        profitTarget: falconConfig.dailyProfitTarget,
        stopLoss: falconConfig.dailyLossLimit,
        stopBlindadoEnabled: falconConfig.stopLossType === 'blindado',
        symbol: falconConfig.symbol || 'R_50',
      });

      this.logSessionStart(userId, {
        date: new Date(),
        initialBalance: falconConfig.initialBalance || 0,
        profitTarget: falconConfig.dailyProfitTarget,
        stopLoss: falconConfig.dailyLossLimit,
        mode: mode,
        agentName: 'FALCON'
      });

      return;
    }

    this.userConfigs.set(userId, falconConfig);
    this.initializeUserState(userId, falconConfig);

    try {
      this.logger.log(`[Falcon][${userId}] 🔌 Pré-aquecendo conexão WebSocket...`);
      await this.warmUpConnection(falconConfig.derivToken);
    } catch (error: any) {
      this.logger.warn(`[Falcon][${userId}] ⚠️ Erro ao pré-aquecer conexão:`, error.message);
    }

    const state = this.userStates.get(userId);
    const mode = state?.mode || 'NORMAL';

    this.logInitialConfigV2(userId, {
      agentName: 'FALCON',
      operationMode: mode,
      riskProfile: falconConfig.riskProfile || 'MODERADO',
      profitTarget: falconConfig.dailyProfitTarget,
      stopLoss: falconConfig.dailyLossLimit,
      stopBlindadoEnabled: falconConfig.stopLossType === 'blindado',
      symbol: falconConfig.symbol || '1HZ100V',
    });

    this.logSessionStart(userId, {
      date: new Date(),
      initialBalance: falconConfig.initialBalance || 0,
      profitTarget: falconConfig.dailyProfitTarget,
      stopLoss: falconConfig.dailyLossLimit,
      mode: mode,
      agentName: 'FALCON'
    });

    this.logger.log(`[Falcon] ✅ Usuário ${userId} ativado | Total configs: ${this.userConfigs.size}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userConfigs.delete(userId);
    this.userStates.delete(userId);
    this.ticks.delete(userId);
    this.processingLocks.delete(userId);
    this.logger.log(`[Falcon] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Verifica se um usuário está ativo
   */
  isUserActive(userId: string): boolean {
    return this.userConfigs.has(userId) && this.userStates.has(userId);
  }

  /**
   * Processa um tick recebido
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    const tickSymbol = symbol || '1HZ10V';

    // ✅ Log de debug para verificar se está recebendo ticks
    // ✅ Log de debug para verificar se está recebendo ticks (Logar SEMPRE para debug)
    // if (this.userConfigs.size > 0) {
    this.logger.debug(`[Falcon] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);
    // }

    // ✅ Processar para todos os usuários ativos
    for (const [userId, config] of this.userConfigs.entries()) {
      // ✅ Verificar se o símbolo coincide (com suporte a sinônimos)
      if (this.isSymbolMatch(tickSymbol, config.symbol || '1HZ10V')) {
        promises.push(this.processTickForUser(userId, tick).catch((error) => {
          this.logger.error(`[Falcon][${userId}] Erro ao processar tick:`, error);
        }));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Processa tick para um usuário específico
   */
  private async processTickForUser(userId: string, tick: Tick): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || !state.isActive) {
      return;
    }

    // ✅ Verificar lock de processamento (evitar múltiplas análises simultâneas)
    if (this.processingLocks.get(userId)) {
      return; // Já está processando, ignorar este tick
    }
    this.processingLocks.set(userId, true);

    try {
      // ✅ CORREÇÃO CRÍTICA: Coletar tick SEMPRE, mesmo aguardando contrato
      // Isso garante que a janela de análise não tenha "buracos" (gaps) de dados
      const userTicks = this.ticks.get(userId) || [];
      userTicks.push(tick);

      // Manter apenas os últimos maxTicks
      if (userTicks.length > this.maxTicks) {
        userTicks.shift();
      }
      this.ticks.set(userId, userTicks);

      // 2. Se está aguardando resultado de contrato, realizar análise apenas para detectar entrada bloqueada
      if (state.isWaitingContract) {
        // ✅ [SAFETY] Timeout de 60s para contrato preso (possível queda de WS/Subscription)
        const now = Date.now();
        const waitTime = state.waitingContractStartTime ? (now - state.waitingContractStartTime) : 0;

        if (waitTime > 40000) {
          const contractRef = state.currentContractId || 'ativo';
          this.logger.warn(`[Falcon][${userId}] ⚠️ [SAFETY] Contrato ${contractRef} parado há ${Math.round(waitTime / 1000)}s. Destravando agente...`);

          await this.saveLog(userId, 'WARN', 'SYSTEM',
            `⚠️ TIMEOUT NA RESPOSTA (40s)...\n• Motivo: Operação ${contractRef} sem resposta da API.\n• Ação: Marcando trade como erro e destravando agente.`
          );

          // ✅ Marcar trade no banco como erro
          if (state.currentTradeId) {
            await this.updateTradeRecord(state.currentTradeId, {
              status: 'ERROR',
              errorMessage: 'Timeout aguardando resposta (40s)',
            }).catch(e => this.logger.error(`[Falcon][${userId}] Erro ao marcar timeout no banco:`, e));
          }

          state.isWaitingContract = false;
          state.waitingContractStartTime = null;
          state.currentContractId = null;
          state.currentTradeId = null;
          return;
        }

        const marketAnalysis = await this.analyzeMarket(userId, userTicks);
        if (marketAnalysis?.signal) {
          // Throttling de log para não inundar (aumentado para 30s para reduzir ruído)
          if (!state.lastDeniedLogTime || (now - state.lastDeniedLogTime) > 30000) {
            state.lastDeniedLogTime = now;
            this.logBlockedEntry(userId, {
              reason: 'OPERAÇÃO EM ANDAMENTO',
              details: `Sinal ${marketAnalysis.signal} detectado | Operação ${state.currentContractId || 'em curso'} (Há ${Math.round(waitTime / 1000)}s)`
            });
          }
        }
        return;
      }

      // ✅ TICK ADVANCE LÓGICA V2 (DIGIT DENSITY WINDOWS)
      const isRecovery = state.perdasAcumuladas > 0;
      const modeSettings = FALCON_MODES[state.mode as keyof typeof FALCON_MODES];
      const currentConfig = isRecovery ? modeSettings.recovery : modeSettings.principal;
      const requiredTicks = currentConfig.window;

      if (userTicks.length < requiredTicks) {
        if (userTicks.length % 10 === 0) {
          this.logDataCollection(userId, {
            targetCount: requiredTicks,
            currentCount: userTicks.length,
            mode: `${state.mode}${isRecovery ? ' (REC)' : ''}`
          });
        }
        return;
      }

      // ✅ Avançar contador de análise
      state.ticksSinceLastAnalysis = (state.ticksSinceLastAnalysis || 0) + 1;

      // ✅ Log de início de análise (Heartbeat a cada 3 análises = ~3s em média)
      // Primeiro log logo na primeira análise após o warm-up de dados
      if (state.ticksSinceLastAnalysis === 1 || state.ticksSinceLastAnalysis % 3 === 0) {
        this.logAnalysisStarted(userId, state.mode, userTicks.length);
      }

      // Realizar análise de mercado
      const marketAnalysis = await this.analyzeMarket(userId, userTicks);

      if (marketAnalysis) {
        const { signal, probability, details } = marketAnalysis;

        // Se usuário pediu logs detalhados, salvar no banco - Usando INFO para garantir visibilidade
        const cutoff = (state.mode as any) === 'VELOZ' ? 55 : (state.mode === 'NORMAL' ? 55 : 55);
        const message = `📊 ANÁLISE COMPLETA\n` +
          `• Sequência: ${details?.digitPattern || 'Processando...'}\n` +
          `• Status: ${signal ? 'SINAL ENCONTRADO 🟢' : 'SEM PADRÃO CLARO ❌'}\n` +
          `• Probabilidade: ${probability}% (Cutoff: ${cutoff}%)`;

        // Throttled: Apenas logar análise completa se houver sinal ou a cada 10 ticks
        if (marketAnalysis.signal || state.ticksSinceLastAnalysis === 0) {
          this.saveLog(userId, signal ? 'INFO' : 'INFO', 'ANALYZER', message);
        }

        if (signal) {
          // Se chegamos aqui, temos um sinal! Reseta o contador
          state.ticksSinceLastAnalysis = 0;

          // ✅ Verificar novamente antes de processar (pode ter mudado)
          if (state.isWaitingContract) return;

          // Processar decisão de trade
          const decision = await this.processAgent(userId, marketAnalysis);

          // ✅ Verificar novamente antes de executar
          if (state.isWaitingContract) return;

          if (decision.action === 'BUY') {
            await this.executeTrade(userId, decision, marketAnalysis);
          } else if (decision.action === 'STOP') {
            await this.handleStopCondition(userId, decision.reason || 'UNKNOWN');
          }
        }
      }
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao processar tick:`, error);
    } finally {
      // ✅ Sempre liberar lock, mesmo em caso de erro ou retorno antecipado
      this.processingLocks.set(userId, false);
    }
  }

  /**
   * ✅ LOGIC HELPER: Extrair último dígito (Protocolo v2.0 p[rec[-1]])
   */
  private lastDigitFromPrice(price: number, symbol: string): number {
    // Obter precisão do símbolo
    let decimals = 4;
    const s = symbol.toUpperCase();
    if (s.includes('100')) decimals = 2;
    else if (s.includes('50')) decimals = 4;
    else if (s.includes('10')) decimals = 3;
    else if (s.includes('25')) decimals = 3;
    else if (s.includes('75')) decimals = 4;
    else if (s.includes('1HZ')) { // Caso use sinônimo direto
      if (s.includes('100')) decimals = 2;
      else if (s.includes('50')) decimals = 4;
      else if (s.includes('10')) decimals = 3;
      else if (s.includes('25')) decimals = 3;
      else if (s.includes('75')) decimals = 4;
    }

    const priceStr = price.toFixed(decimals);
    const lastDigit = parseInt(priceStr.slice(-1), 10);
    return isNaN(lastDigit) ? 0 : lastDigit;
  }

  /**
   * ⏰ Verifica se horário é válido para operar (24/7 Enabled)
   */
  private isValidTradingHour(): boolean {
    return true;
  }

  /**
   * Processa agente (chamado via interface)
   */
  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || !state.isActive) {
      return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
    }

    // 1. Verificações de Segurança (V4 Limits)
    const nowTs = Date.now();
    if (state.sessionEnded) return { action: 'WAIT', reason: 'SESSION_ENDED' };

    if (nowTs < state.cooldownUntilTs) {
      this.logBlockedEntry(userId, {
        reason: 'COOLDOWN',
        details: 'Aguardando tempo de espera entre operações'
      });
      return { action: 'WAIT', reason: 'COOLDOWN' };
    }

    if (nowTs < state.inStrategicPauseUntilTs) {
      this.logBlockedEntry(userId, {
        reason: 'PAUSA ESTRATÉGICA',
        details: 'Agente em pausa após sequência de operações'
      });
      return { action: 'WAIT', reason: 'STRATEGIC_PAUSE' };
    }

    // V4 Limits
    const limitDay = config.limitOpsDay || 2000;
    if (state.opsTotal >= limitDay) {
      this.handleStopCondition(userId, 'DAILY_LIMIT');
      return { action: 'STOP', reason: 'DAILY_LIMIT' };
    }

    const limitCycle = config.limitOpsCycle || 500;
    if (state.cycleOps >= limitCycle) {
      this.logBlockedEntry(userId, {
        reason: 'LIMITE DE CICLO',
        details: `Máximo de ${limitCycle} operações por ciclo atingido`
      });
      return { action: 'WAIT', reason: 'CYCLE_LIMIT' };
    }

    // Global Stops check via checkStopLoss
    if (marketAnalysis.signal) {
      const stake = this.computeNextStake(config, state);

      if (stake <= 0) {
        this.logBlockedEntry(userId, {
          reason: 'STAKE INVÁLIDA',
          details: 'Calcule de stake retornou valor zero ou negativo'
        });
        return { action: 'WAIT', reason: 'NO_STAKE' };
      }

      const riskCheck = await this.checkStopLoss(userId, stake);
      if (riskCheck.action === 'STOP') {
        this.handleStopCondition(userId, riskCheck.reason as any);
        return riskCheck;
      }

      if (riskCheck.action === 'WAIT') {
        this.logBlockedEntry(userId, {
          reason: riskCheck.reason || 'RISCO_BLOQUEADO',
          details: 'Entrada bloqueada por gestão de risco'
        });
        return riskCheck;
      }
      const finalStake = riskCheck.stake ? riskCheck.stake : stake;

      return {
        action: 'BUY',
        stake: finalStake,
        contractType: marketAnalysis.details?.contractType || 'DIGITOVER',
        mode: state.mode,
        reason: marketAnalysis.details?.info || 'SIGNAL_FOUND',
      };
    }

    return { action: 'WAIT', reason: 'NO_SIGNAL' };
  }

  /**
   * ✅ LOGIC HELPER: Calcular Stake (v2.0 Martingale Inteligente)
   */
  private computeNextStake(config: FalconUserConfig, state: FalconUserState): number {
    // Principal (Over 2)
    if (state.perdasAcumuladas <= 0) {
      return config.baseStake;
    }

    // Recuperação (Over 4)
    const perdas = state.perdasAcumuladas;
    const payoutOver4 = FALCON_CONSTANTS.payoutRecovery; // 0.84

    let multiplicador = 1.00;
    switch (config.riskProfile) {
      case 'MODERADO':
        multiplicador = 1.25;
        break;
      case 'AGRESSIVO':
        multiplicador = 1.50;
        break;
      case 'CONSERVADOR':
      default:
        multiplicador = 1.00;
        break;
    }

    // Fórmula: stake_recup = (perdas_acumuladas × multiplicador) / payout_over4
    let stake = (perdas * multiplicador) / payoutOver4;

    // Reset Conservador (MAX 5 Gales)
    if (config.riskProfile === 'CONSERVADOR' && state.consecutiveLosses > FALCON_CONSTANTS.martingaleMaxLevel) {
      this.saveLog(config.userId, 'WARN', 'RISK', `⚠️ RESET CONSERVADOR: Limite de 5 gales atingido. Voltando p/ stake base.`);
      state.perdasAcumuladas = 0;
      state.consecutiveLosses = 0;
      return config.baseStake;
    }

    let finalStake = Math.max(0.35, Math.ceil(stake * 100) / 100);

    // Smart Goal (V4 Optimization)
    const dailyGap = config.profitTarget - state.profit;
    const cycleGap = state.cycleTarget - state.cycleProfit;
    const gapToTarget = Math.max(0, Math.min(dailyGap, cycleGap));
    const currentPayout = FALCON_CONSTANTS.payoutRecovery;

    if (gapToTarget > 0 && gapToTarget < (finalStake * currentPayout)) {
      const smartStake = Math.max(0.35, Math.ceil((gapToTarget / currentPayout) * 100) / 100);
      if (smartStake < finalStake) {
        finalStake = smartStake;
      }
    }

    return finalStake;
  }

  /**
   * ✅ CYCLE MANAGEMENT (V4 Spec)
   */
  private updateCycleState(userId: string): void {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);
    if (!config || !state) return;

    // 1. SAFEGUARD GLOBAL: Checar Stop Loss GLOBAL antes de qualquer lógica de ciclo
    const currentProfitRounded = Math.round(state.profit * 100) / 100;
    if (currentProfitRounded <= -config.stopLoss) {
      this.saveLog(userId, 'ERROR', 'RISK', `🛑 STOP LOSS GLOBAL ATINGIDO ($${state.profit.toFixed(2)}). Encerrando Sessão.`);
      state.sessionEnded = true;
      state.endReason = 'STOPLOSS';
      this.handleStopCondition(userId, 'STOP_LOSS');
      return;
    }

    // Checar conclusão do ciclo (Meta do Ciclo atingida)
    if (state.cycleProfit >= state.cycleTarget) {
      this.saveLog(userId, 'INFO', 'CYCLE',
        `🔄 CICLO ${state.cycleCurrent} CONCLUÍDO | Lucro Ciclo: ${state.cycleProfit.toFixed(2)}`);

      if (state.cycleCurrent < FALCON_CONSTANTS.cycles) {
        state.cycleCurrent++;
        // RESETAR métricas do ciclo (V4 Spec)
        state.cycleProfit = 0;
        state.cycleOps = 0;
        state.cyclePeakProfit = 0;
        state.blindadoActive = false;
        state.blindadoFloorProfit = 0;

        // Pausa estratégica entre ciclos
        state.inStrategicPauseUntilTs = Date.now() + 60000;
        this.saveLog(userId, 'INFO', 'CYCLE', `⏳ Pausa de transição de ciclo (60s)...`);

      } else {
        // Ciclo 4 concluído = Meta Diária
        this.saveLog(userId, 'INFO', 'SESSION', `🏆 SESSÃO FINALIZADA (4 CICLOS COMPLETOS)`);
        state.sessionEnded = true;
        state.endReason = 'TARGET';
        this.handleStopCondition(userId, 'TAKE_PROFIT');
      }
      return;
    }
  }

  /**
   * ✅ LOGIC HELPER: Atualizar estado do Stop Blindado (V4 Cycle Based)
   */
  private updateBlindado(userId: string, state: FalconUserState, config: FalconUserConfig): void {
    if (!config.enableStopLossBlindado) return;

    const currentCycleProfit = state.cycleProfit;
    const triggerValue = state.cycleTarget * config.blindadoTriggerPctOfTarget;

    if (!state.blindadoActive) {
      if (currentCycleProfit >= triggerValue) {
        state.blindadoActive = true;
        state.blindadoFloorProfit = state.cyclePeakProfit * config.blindadoProtectPctOfPeak;
        this.saveLog(userId, 'INFO', 'RISK',
          `🛡️ BLINDADO ATIVADO (Ciclo ${state.cycleCurrent}) | Profit: ${currentCycleProfit.toFixed(2)} | Floor: ${state.blindadoFloorProfit.toFixed(2)}`);
      }
    } else {
      const newFloor = state.cyclePeakProfit * config.blindadoProtectPctOfPeak;
      if (newFloor > state.blindadoFloorProfit) {
        state.blindadoFloorProfit = newFloor;
      }
    }
  }

  /**
   * Trata condições de parada
   */
  private async handleStopCondition(userId: string, reason: string): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) return;

    let status = 'active';
    let message = '';

    switch (reason) {
      case 'TAKE_PROFIT':
        status = 'stopped_profit';
        message = `META DE LUCRO ATINGIDA! daily_profit=${state.profit.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)} | cycle=${state.cycleCurrent}. Encerrando operações.`;
        break;
      case 'STOP_LOSS':
        status = 'stopped_loss';
        message = `STOP LOSS ATINGIDO! daily_loss=${Math.abs(Math.min(0, state.profit)).toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)} | cycle=${state.cycleCurrent}. Encerrando operações.`;
        break;
      case 'BLINDADO':
        status = 'stopped_blindado';
        message = `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${(config.initialCapital + state.profit).toFixed(2)} | cycle=${state.cycleCurrent}. Encerrando operações do dia.`;
        break;
      case 'DAILY_LIMIT':
        status = 'stopped_profit';
        message = `LIMITE DIÁRIO DE OPERAÇÕES! ops=${state.opsTotal}. Encerrando operações.`;
        break;
    }

    await this.saveLog(userId, 'WARN', 'RISK', message);

    state.isActive = false;
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = ?, is_active = TRUE WHERE user_id = ?`,
      [status, userId],
    );

    this.logger.log(`[Falcon][${userId}] ${message}`);
  }

  /**
   * Verifica Stop Loss (Normal ou Blindado)
   */
  private async checkStopLoss(userId: string, nextStake?: number): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
    }

    const stake = nextStake || 0;

    // 1. Stop Loss GLOBAL
    const currentDrawdown = state.profit < 0 ? Math.abs(state.profit) : 0;

    if (currentDrawdown >= config.stopLoss) {
      this.logBlockedEntry(userId, {
        reason: 'STOP LOSS GLOBAL',
        details: `Limite de $${config.stopLoss} atingido`
      });
      return { action: 'STOP', reason: 'STOP_LOSS' };
    }

    // Proteger Stop Global antecipadamente se a stake for maior que o que resta
    if (currentDrawdown + stake > config.stopLoss) {
      const remaining = config.stopLoss - currentDrawdown;
      const adjustedStake = Math.floor(remaining * 100) / 100;

      if (adjustedStake < 0.35) {
        return { action: 'STOP', reason: 'STOP_LOSS' };
      }

      this.logger.log(`[Falcon][${userId}] 🛡️ RISK PROTECT: Ajustando stake de $${stake} para $${adjustedStake} para não romper SL Global.`);
      return {
        action: 'BUY',
        stake: adjustedStake,
        reason: 'STOP_LOSS_ADJUSTED'
      };
    }

    // 2. Stop Loss Blindado (Ciclo)
    if (config.enableStopLossBlindado && state.blindadoActive) {
      if (state.cycleProfit < state.blindadoFloorProfit) {
        this.logBlockedEntry(userId, {
          reason: 'STOP BLINDADO',
          details: `Lucro do ciclo caiu abaixo do piso de $${state.blindadoFloorProfit}`
        });
        return { action: 'STOP', reason: 'BLINDADO' };
      }

      const distToFloor = state.cycleProfit - state.blindadoFloorProfit;

      if (stake > distToFloor) {
        const adjustedStake = Math.floor(distToFloor * 100) / 100;

        if (adjustedStake < 0.35) {
          this.logger.log(`[Falcon][${userId}] 🛡️ STOP BLINDADO PRÓXIMO: Encerrando para proteger lucro.`);
          return { action: 'STOP', reason: 'BLINDADO' };
        }

        this.logger.log(`[Falcon][${userId}] 🛡️ SMART BLINDADO: Ajustando stake de $${stake} para $${adjustedStake} para não romper piso.`);
        return {
          action: 'BUY',
          stake: adjustedStake,
          reason: 'BLINDADO_CLAMP'
        };
      }
    }

    return {
      action: 'BUY',
      stake: stake,
      reason: 'RiskCheckOK'
    };
  }

  /**
   * Executa trade
   */
  private async executeTrade(userId: string, decision: TradeDecision, marketAnalysis: MarketAnalysis): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || decision.action !== 'BUY') {
      return;
    }

    // ✅ Verificar se já está aguardando resultado de contrato (dupla verificação de segurança)
    if (state.isWaitingContract) {
      this.logger.warn(`[Falcon][${userId}] ⚠️ Tentativa de compra bloqueada: já aguardando resultado de contrato anterior`);
      return;
    }

    // Verificar Stop Loss antes de executar (dupla verificações)
    const stopLossCheck = await this.checkStopLoss(userId, decision.stake);
    if (stopLossCheck.action === 'STOP') {
      return;
    }

    const contractType = decision.contractType || (marketAnalysis.signal === 'CALL' ? 'CALL' : 'PUT');

    // ✅ IMPORTANTE: Setar isWaitingContract ANTES de comprar para bloquear qualquer nova análise/compra
    state.isWaitingContract = true;
    state.waitingContractStartTime = Date.now();

    // Payout fixo: 92.15%
    const zenixPayout = 0.9215;

    //  ✅ FIX: Obter preço atual do último tick disponível para usar como entry price inicial
    // Isso evita que trades sejam criados com entryPrice = 0 ou null
    const userTicks = this.ticks.get(userId) || [];
    const currentPrice = userTicks.length > 0
      ? userTicks[userTicks.length - 1].value
      : marketAnalysis.details?.currentPrice || 0;

    this.logger.debug(`[Falcon][${userId}] 💰 Usando preço atual como entry price inicial: ${currentPrice} `);

    try {
      // ✅ Salvar tipo de contrato para usar no log de resultado
      state.lastContractType = contractType;

      // ✅ Criar registro de trade ANTES de executar - com preço atual como inicial
      const tradeId = await this.createTradeRecord(
        userId,
        {
          contractType: contractType,
          stakeAmount: decision.stake || config.initialStake,
          duration: 1,
          marketAnalysis: marketAnalysis,
          payout: zenixPayout,
          entryPrice: currentPrice, // ✅ Usar preço atual instead of 0
        },
      );

      // ✅ CORREÇÃO DE RACE CONDITION:
      // Definir currentTradeId IMEDIATAMENTE, antes de chamar buyContract via API.
      state.currentTradeId = tradeId;

      let lastErrorMsg = 'Falha ao comprar contrato';
      // ✅ LOG: Notificar pedido de compra
      await this.saveLog(userId, 'INFO', 'TRADER', `📡 SOLICITANDO COMPRA: ${contractType} | VALOR: $${(decision.stake || config.initialStake).toFixed(2)}`);

      const barrier = marketAnalysis.details?.barrier || 2;

      const contractId = await this.buyContract(
        userId,
        config.derivToken,
        contractType,
        config.symbol,
        decision.stake || config.initialStake,
        1, // duration em ticks (ZENIX v1.0 standard)
        2, // maxRetries
        tradeId, // ✅ Passar tradeId para associar corretamente no callback
        barrier // ✅ Passo a barreira (dígito alvo)
      ).catch(err => {
        lastErrorMsg = err.message || 'Falha ao comprar contrato';
        return null;
      });

      if (contractId) {
        state.currentContractId = contractId;
        // state.currentTradeId = tradeId; // ✅ Já definido acima para evitar race condition

        // ✅ Log de operação no padrão Orion/Zeus
        await this.saveLog(
          userId,
          'INFO',
          'TRADER',
          `⚡ ENTRADA CONFIRMADA: ${contractType} | VALOR: $${(decision.stake || config.initialStake).toFixed(2)}`,
        );

        // ✅ Atualizar trade com contract_id
        await this.updateTradeRecord(tradeId, {
          contractId: contractId,
          status: 'ACTIVE',
        });
      } else {
        // Se falhou, resetar isWaitingContract e atualizar trade com erro
        state.isWaitingContract = false;
        state.waitingContractStartTime = null;
        state.currentTradeId = null; // ✅ Resetar ID pois falhou
        state.currentContractId = null;

        await this.updateTradeRecord(tradeId, {
          status: 'ERROR',
          errorMessage: lastErrorMsg,
        });
        await this.saveLog(userId, 'ERROR', 'API', `Erro na Corretora: ${lastErrorMsg}`);
      }
    } catch (error) {
      // ✅ Fallback de segurança máximo: resetar estado se qualquer erro crítico ocorrer antes/durante execução
      state.isWaitingContract = false;
      state.waitingContractStartTime = null;
      state.currentTradeId = null;
      this.logger.error(`[Falcon][${userId}] Erro ao executar trade: `, error);
      await this.saveLog(userId, 'ERROR', 'API', `Erro ao executar trade: ${error.message} `);
    }
  }

  /**
   * Obtém payout de um contrato via Deriv API
   */
  private async getPayout(token: string, contractType: string, symbol: string, duration: number): Promise<number> {
    try {
      // ✅ Obter conexão do pool interno
      const connection = await this.getOrCreateWebSocketConnection(token);

      const response = await connection.sendRequest(
        {
          proposal: 1,
          amount: 1,
          basis: 'stake',
          contract_type: contractType,
          currency: 'USD',
          duration: duration,
          duration_unit: 't',
          symbol: symbol,
        },
        60000, // timeout 60s (igual Orion)
      );

      if (response.error) {
        throw new Error(response.error.message || 'Erro ao obter payout');
      }

      if (response.proposal) {
        const payout = Number(response.proposal.payout || 0);
        const askPrice = Number(response.proposal.ask_price || 0);

        // Calcular payout percentual: (payout - askPrice) / askPrice
        const payoutPercent = askPrice > 0 ? (payout - askPrice) / askPrice : 0;
        return payoutPercent;
      }

      throw new Error('Resposta de proposal inválida');
    } catch (error) {
      this.logger.error(`[Falcon] Erro ao obter payout: `, error);
      // Retornar valores padrão em caso de erro
      return 0.95; // 95% para Rise/Fall
    }
  }



  /**
   * Compra contrato na Deriv via WebSocket Pool Interno com retry automático
   */
  private async buyContract(
    userId: string,
    token: string,
    contractType: string,
    symbol: string,
    stake: number,
    duration: number,
    maxRetries = 2,
    tradeId: number = 0,
    barrier: number = 2,
  ): Promise<string | null> {
    const roundedStake = Number(stake.toFixed(2));
    let lastError: Error | null = null;

    // ✅ ESTABILIDADE ZEUS: Delay inicial de 3000ms antes da primeira tentativa
    // Isso dá tempo para a conexão WebSocket se estabilizar e AUTORIZAR no pool
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ✅ Retry com backoff exponencial
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // ✅ Backoff exponencial: 1s, 2s, 4s...
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          this.logger.warn(`[Falcon][${userId}] 🔄 Tentativa ${attempt + 1}/${maxRetries + 1} após ${delayMs}ms | Erro anterior: ${lastError?.message}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // ✅ Obter conexão do pool interno
        const connection = await this.getOrCreateWebSocketConnection(token, userId);

        // ✅ Primeiro, obter proposta (usando timeout de 60s como Orion)
        // ✅ Primeiro, obter proposta (usando timeout de 60s como Orion)
        const proposalRequest: any = {
          proposal: 1,
          amount: roundedStake,
          basis: 'stake',
          contract_type: contractType,
          currency: 'USD',
          duration: duration,
          duration_unit: 't',
          symbol: symbol,
          barrier: barrier.toString()
        };

        // ✅ FALCON SPECIFIC: Adicionar prediction para DIGITODD (não precisa barrier, mas prediction talvez se fosse matches/differs)
        // Para DIGITODD/DIGITEVEN não precisa de barrier.
        // if (contractType === 'DIGITOVER') {
        //   proposalRequest.barrier = 3;
        // }

        const proposalResponse = await connection.sendRequest(
          proposalRequest,
          60000, // timeout 60s (igual Orion)
        );

        // ✅ Verificar erros na resposta (pode estar em error ou proposal.error) - igual Orion
        const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
        if (errorObj) {
          const errorCode = errorObj?.code || '';
          const errorMessage = errorObj?.message || JSON.stringify(errorObj);

          // ✅ Alguns erros não devem ser retentados (ex: saldo insuficiente, parâmetros inválidos)
          const nonRetryableErrors = ['InvalidAmount', 'InsufficientBalance', 'InvalidContract', 'InvalidSymbol'];
          if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
            this.logger.error(`[Falcon][${userId}] ❌ Erro não retentável na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
            throw new Error(errorMessage);
          }

          // ✅ Erros retentáveis: tentar novamente
          lastError = new Error(errorMessage);
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Erro retentável na proposta (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
            continue;
          }

          this.logger.error(`[Falcon][${userId}] ❌ Erro na proposta após ${maxRetries + 1} tentativas: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
          throw lastError;
        }

        const proposalId = proposalResponse.proposal?.id;
        const proposalPrice = Number(proposalResponse.proposal?.ask_price || 0);

        if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
          lastError = new Error('Resposta de proposta inválida');
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Proposta inválida (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(proposalResponse)}`);
            continue;
          }
          this.logger.error(`[Falcon][${userId}] ❌ Proposta inválida recebida após ${maxRetries + 1} tentativas: ${JSON.stringify(proposalResponse)}`);
          throw lastError;
        }

        // ✅ Enviar compra (usando timeout de 60s como Orion)
        const buyResponse = await connection.sendRequest(
          {
            buy: proposalId,
            price: proposalPrice,
          },
          60000, // timeout 60s (igual Orion)
        );

        // ✅ Verificar erros na resposta - igual Orion
        const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
        if (buyErrorObj) {
          const errorCode = buyErrorObj?.code || '';
          const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);

          // ✅ Alguns erros não devem ser retentados
          const nonRetryableErrors = ['InvalidProposal', 'ProposalExpired', 'InsufficientBalance'];
          if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
            this.logger.error(`[Falcon][${userId}] ❌ Erro não retentável ao comprar: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
            throw new Error(errorMessage);
          }

          // ✅ Erros retentáveis: tentar novamente (mas precisa obter nova proposta)
          lastError = new Error(errorMessage);
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Erro retentável ao comprar (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
            continue;
          }

          this.logger.error(`[Falcon][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
          throw lastError;
        }

        const contractId = buyResponse.buy?.contract_id;
        if (!contractId) {
          lastError = new Error('Resposta de compra inválida - sem contract_id');
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Contrato sem contract_id (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(buyResponse)}`);
            continue;
          }
          this.logger.error(`[Falcon][${userId}] ❌ Contrato criado mas sem contract_id após ${maxRetries + 1} tentativas: ${JSON.stringify(buyResponse)}`);
          throw lastError;
        }

        // ✅ Inscrever para monitorar contrato usando pool interno
        await connection.subscribe(
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          (contractMsg: any) => {
            if (contractMsg.proposal_open_contract) {
              const contract = contractMsg.proposal_open_contract;
              const state = this.userStates.get(userId);

              this.logger.debug(`[Falcon][${userId}] 📊 Atualização do contrato ${contractId}: is_sold=${contract.is_sold}, status=${contract.status}, profit=${contract.profit}`);

              // ✅ Atualizar entry_price quando disponível
              if (contract.entry_spot && state?.currentTradeId) {
                this.updateTradeRecord(state.currentTradeId, {
                  entryPrice: Number(contract.entry_spot),
                }).catch((error) => {
                  this.logger.error(`[Falcon][${userId}] Erro ao atualizar entry_price:`, error);
                });
              }

              // ✅ Verificar se contrato foi rejeitado, cancelado ou expirado
              if (contract.status === 'rejected' || contract.status === 'cancelled' || contract.status === 'expired') {
                const errorMsg = `Contrato ${contract.status}: ${contract.error_message || 'Sem mensagem de erro'}`;
                this.logger.error(`[Falcon][${userId}] ❌ Contrato ${contractId} foi ${contract.status}: ${errorMsg}`);

                if (state?.currentTradeId) {
                  this.updateTradeRecord(state.currentTradeId, {
                    status: 'ERROR',
                    errorMessage: errorMsg,
                  }).catch((error) => {
                    this.logger.error(`[Falcon][${userId}] Erro ao atualizar trade com status ERROR:`, error);
                  });
                }

                if (state) {
                  state.isWaitingContract = false;
                  state.waitingContractStartTime = null;
                }

                // Remover subscription usando pool interno
                connection.removeSubscription(contractId);
                return;
              }

              // ✅ Verificar se contrato foi finalizado
              const isFinalized = contract.is_sold === 1 || contract.is_sold === true ||
                contract.status === 'won' || contract.status === 'lost' || contract.status === 'sold';

              if (isFinalized) {
                const profit = Number(contract.profit || 0);
                const win = profit > 0;
                const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);

                this.logger.log(`[Falcon][${userId}] ✅ Contrato ${contractId} finalizado: ${win ? 'WIN' : 'LOSS'} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Exit: ${exitPrice}`);

                // Processar resultado
                this.onContractFinish(
                  userId,
                  { win, profit, contractId, exitPrice, stake: roundedStake },
                  tradeId
                ).catch((error) => {
                  this.logger.error(`[Falcon][${userId}] Erro ao processar resultado:`, error);
                });

                // Remover subscription usando pool interno
                connection.removeSubscription(contractId);
              }
            }
          },
          String(contractId), // ✅ CAST TO STRING (Consistency Fix)
          90000,
        );

        // ✅ Se chegou aqui, sucesso!
        return contractId;
      } catch (error: any) {
        lastError = error;
        const errorMessage = error?.message || JSON.stringify(error);

        // ✅ Verificar se é erro de timeout ou conexão (retentável)
        const isRetryableError = errorMessage.includes('Timeout') ||
          errorMessage.includes('WebSocket') ||
          errorMessage.includes('Conexão') ||
          errorMessage.includes('not ready') ||
          errorMessage.includes('not open');

        if (isRetryableError && attempt < maxRetries) {
          this.logger.warn(`[Falcon][${userId}] ⚠️ Erro retentável (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
          continue;
        }

        // ✅ Se não é retentável ou esgotou tentativas, logar e lançar erro
        if (attempt >= maxRetries) {
          this.logger.error(`[Falcon][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${errorMessage}`, error?.stack);
          throw new Error(`Falha após ${maxRetries + 1} tentativas: ${errorMessage}`);
        } else {
          this.logger.error(`[Falcon][${userId}] ❌ Erro não retentável ao comprar contrato: ${errorMessage}`, error?.stack);
          throw new Error(errorMessage);
        }
      }
    }

    // ✅ Se chegou aqui, todas as tentativas falharam
    const finalError = lastError?.message || 'Erro desconhecido';
    this.logger.error(`[Falcon][${userId}] ❌ Falha ao comprar contrato após ${maxRetries + 1} tentativas: ${finalError}`);
    throw new Error(finalError);
  }

  /**
   * Processa resultado de contrato finalizado
   */
  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string; exitPrice?: number; stake: number },
    tradeIdFromCallback?: number,
  ): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) return;

    const tradeId = tradeIdFromCallback || state.currentTradeId;

    if (state.currentContractId === result.contractId) state.currentContractId = null;
    if (state.currentTradeId === tradeId) state.currentTradeId = null;

    try {
      let finalTradeId = tradeId;
      if (!finalTradeId) {
        const trade = await this.dataSource.query('SELECT id FROM autonomous_agent_trades WHERE contract_id = ? ORDER BY id DESC LIMIT 1', [result.contractId]);
        if (trade && trade.length > 0) finalTradeId = trade[0].id;
      }

      if (finalTradeId) {
        await this.updateTradeRecord(finalTradeId, {
          status: result.win ? 'WON' : 'LOST',
          exitPrice: result.exitPrice || 0,
          profitLoss: result.profit,
          closedAt: new Date(),
        });
      }

      // V4 Stats Update
      state.opsTotal++;
      state.cycleOps++;
      state.profit += result.profit;
      state.cycleProfit += result.profit;
      state.lucroAtual = state.profit;
      state.opsCount = state.opsTotal;

      if (state.profit > state.peakProfit) state.peakProfit = state.profit;
      if (state.cycleProfit > state.cyclePeakProfit) state.cyclePeakProfit = state.cycleProfit;

      if (result.win) {
        state.wins++;
        state.consecutiveLosses = 0;
        state.perdasAcumuladas = 0;
        state.analysis = "PRINCIPAL";
        state.cooldownUntilTs = Date.now() + (config.cooldownWinSeconds * 1000);
      } else {
        state.losses++;
        state.consecutiveLosses++;
        state.perdasAcumuladas += Math.abs(result.profit);
        state.analysis = "RECUPERACAO";
        state.cooldownUntilTs = Date.now() + (config.cooldownLossSeconds * 1000);
      }
      this.updateBlindado(userId, state, config);

      // Log Result
      await this.logTradeResultV2(userId, {
        status: result.win ? 'WIN' : 'LOSS',
        profit: result.profit,
        stake: result.stake,
        balance: config.initialCapital + state.profit
      });

      // Update DB and check cycles/stops
      await this.updateUserStateInDb(userId, state);
      this.updateCycleState(userId);

    } catch (criticalError) {
      this.logger.error(`[Falcon][${userId}] ❌ ERRO CRÍTICO no processamento de contrato:`, criticalError);
    } finally {
      state.isWaitingContract = false;
      state.waitingContractStartTime = null;
    }
  }

  /**
   * ✅ CORE: Analyze Market (v2.0 Digit Density)
   */
  private async analyzeMarket(userId: string, ticks: Tick[]): Promise<MarketAnalysis | null> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);
    if (!config || !state) return null;

    // Detectar Sub-Modo (Principal vs Recuperação)
    const isRecovery = state.perdasAcumuladas > 0;
    const modeName = state.mode;
    const modeConfig = FALCON_MODES[modeName][isRecovery ? 'recovery' : 'principal'];

    if (ticks.length < modeConfig.window) return null;

    // 1. Extrair dígitos da janela solicitada
    const windowTicks = ticks.slice(-modeConfig.window);
    const symbol = config.symbol || 'R_50';
    const digits = windowTicks.map(t => this.lastDigitFromPrice(t.value, symbol));
    state.lastDigits = digits;

    // 2. Contar ocorrências dos dígitos alvo
    const count = digits.filter(d => modeConfig.targets.includes(d)).length;

    // ✅ LOG DE MONITORAMENTO (A cada 3 ticks para não inundar)
    if (state.ticksSinceLastAnalysis % 3 === 0) {
      const message = `📊 MONITORANDO DENSIDADE\n` +
        `• SINAL: Digit Over ${modeConfig.barrier}\n` +
        `• DENSIDADE: ${count}/${modeConfig.window}\n` +
        `• ALVO: >= ${modeConfig.limit}\n` +
        `• ÚLTIMOS: ${digits.slice(-10).join('|')}`;
      this.saveLog(userId, 'INFO', 'ANALYZER', message);
    }

    // 3. Verificar Limite (Relaxado para >= conforme nova estratégia de precisão)
    if (count >= modeConfig.limit) {
      const contractType = 'DIGITOVER';
      const barrier = modeConfig.barrier;
      const payout = isRecovery ? FALCON_CONSTANTS.payoutRecovery : FALCON_CONSTANTS.payoutPrincipal;
      const probability = isRecovery ? 60.91 : (modeName === 'NORMAL' ? 78.02 : 77.22);

      return {
        signal: 'DIGIT',
        probability,
        payout,
        confidence: probability / 100,
        details: {
          contractType,
          barrier,
          info: isRecovery ? 'Filtro Recuperação' : `Filtro Principal ${modeName}`,
          mode: modeName,
          density: `${count}/${modeConfig.window}`,
          targets: modeConfig.targets.join(','),
          currentPrice: ticks[ticks.length - 1].value
        }
      };
    } else if (count >= (modeConfig.limit * 0.8)) {
      // Log de "Força Insuficiente" se estiver próximo (80% do alvo)
      this.logBlockedEntry(userId, {
        reason: 'FORÇA INSUFICIENTE',
        details: `Densidade: ${count}/${modeConfig.window} (Alvo: >= ${modeConfig.limit})`
      });
    }

    return null;
  }

  /**
   * ✅ HELPER: Normaliza e compara símbolos de mercado
   */
  private isSymbolMatch(tickSymbol: string, configSymbol: string): boolean {
    if (!tickSymbol || !configSymbol) return false;

    const s1 = tickSymbol.toUpperCase();
    const s2 = configSymbol.toUpperCase();

    if (s1 === s2) return true;

    // Mapeamento de sinônimos (Deriv API vs Interno Zenix)
    const synonyms: Record<string, string[]> = {
      'R_100': ['1HZ100V', 'VOLATILITY 100 INDEX'],
      'R_50': ['1HZ50V', 'VOLATILITY 50 INDEX'],
      'R_10': ['1HZ10V', 'VOLATILITY 10 INDEX'],
      'R_25': ['1HZ25V', 'VOLATILITY 25 INDEX'],
      'R_75': ['1HZ75V', 'VOLATILITY 75 INDEX'],
      '1HZ100V': ['R_100'],
      '1HZ50V': ['R_50'],
      '1HZ10V': ['R_10'],
      '1HZ25V': ['R_25'],
      '1HZ75V': ['R_75'],
    };

    if (synonyms[s1]?.includes(s2)) return true;
    if (synonyms[s2]?.includes(s1)) return true;

    return false;
  }

  /**
   * Cria registro de trade no banco
   */
  private async createTradeRecord(
    userId: string,
    trade: {
      contractType: string;
      stakeAmount: number;
      duration: number;
      marketAnalysis: MarketAnalysis;
      payout: number;
      entryPrice: number;
    },
  ): Promise<number> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) return 0;

    const analysisData = {
      strategy: 'falcon',
      mode: state.mode,
      cycle: state.cycleCurrent,
      probability: trade.marketAnalysis.probability,
      signal: trade.marketAnalysis.signal,
      info: trade.marketAnalysis.details?.info,
      digitPattern: trade.marketAnalysis.details?.digitPattern,
      timestamp: new Date().toISOString(),
    };

    const analysisReasoning = `Análise FALCON V4: Probabilidade ${trade.marketAnalysis.probability.toFixed(1)}%, ` +
      `Sinal ${trade.marketAnalysis.details?.info}, ` +
      `Modo ${state.mode}, ` +
      `Ciclo ${state.cycleCurrent}`;

    try {
      const result = await this.dataSource.query(
        `INSERT INTO autonomous_agent_trades (
          user_id, analysis_data, confidence_score, analysis_reasoning,
          contract_type, contract_duration, entry_price, stake_amount,
          martingale_level, payout, symbol, status, strategy, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'falcon', NOW())`,
        [
          userId,
          JSON.stringify(analysisData),
          trade.marketAnalysis.probability,
          analysisReasoning,
          trade.contractType,
          trade.duration,
          trade.entryPrice,
          trade.stakeAmount,
          state.perdasAcumuladas > 0 ? 'M1' : 'M0',
          trade.payout * 100,
          config.symbol,
        ],
      );

      const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
      return insertId || 0;
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao criar registro de trade:`, error);
      return 0;
    }
  }

  /**
   * Atualiza registro de trade no banco
   */
  private async updateTradeRecord(
    tradeId: number,
    updates: {
      contractId?: string;
      entryPrice?: number;
      exitPrice?: number;
      status?: string;
      profitLoss?: number;
      errorMessage?: string;
      closedAt?: Date;
    },
  ): Promise<void> {
    if (!tradeId || tradeId === 0) {
      return;
    }

    const updateFields: string[] = [];
    const updateValues: any[] = [];

    if (updates.contractId !== undefined) {
      updateFields.push('contract_id = ?');
      updateValues.push(updates.contractId);
    }

    if (updates.entryPrice !== undefined) {
      updateFields.push('entry_price = ?');
      updateValues.push(updates.entryPrice);
    }

    if (updates.exitPrice !== undefined) {
      updateFields.push('exit_price = ?');
      updateValues.push(updates.exitPrice);
    }

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      updateValues.push(updates.status);

      if (updates.status === 'ACTIVE') {
        updateFields.push('started_at = NOW()');
      }
    }

    if (updates.profitLoss !== undefined) {
      updateFields.push('profit_loss = ?');
      updateValues.push(updates.profitLoss);
    }

    if (updates.errorMessage !== undefined) {
      updateFields.push('error_message = ?');
      updateValues.push(updates.errorMessage);
    }

    if (updates.closedAt !== undefined) {
      updateFields.push('closed_at = ?');
      updateValues.push(updates.closedAt);
    }

    if (updateFields.length === 0) {
      this.logger.warn(`[Falcon] ⚠️ Tentativa de atualizar trade ${tradeId} sem campos para atualizar`);
      return;
    }

    updateValues.push(tradeId);

    try {
      this.logger.debug(`[Falcon] 📝 Atualizando trade ${tradeId}: ${updateFields.join(', ')}`);
      await this.dataSource.query(
        `UPDATE autonomous_agent_trades SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues,
      );
      this.logger.debug(`[Falcon] ✅ Trade ${tradeId} atualizado com sucesso`);
    } catch (error) {
      this.logger.error(`[Falcon] ❌ Erro ao atualizar trade ${tradeId}:`, error);
      throw error; // ✅ Re-throw para que o erro seja visível
    }
  }

  // logInitialConfigV2 removed (implemented at the end of the class)

  /**
   * Atualiza estado do usuário no banco de dados
   */
  /**
   * Atualiza estado do usuário no banco de dados
   */
  private async updateUserStateInDb(userId: string, state: FalconUserState): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_config
         SET daily_profit = ?,
             daily_loss = ?,
             total_trades = ?,
             updated_at = NOW()
         WHERE user_id = ? AND agent_type = 'falcon'`,
        [state.profit, state.losses, state.opsTotal, userId]
      );
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao atualizar estado no banco:`, error);
    }
  }

  private saveLog(userId: string, level: 'INFO' | 'WARN' | 'ERROR', module: string, message: string): void {
    if (this.logQueueService) {
      this.logQueueService.saveLogAsync({
        userId,
        level,
        module: module as any,
        message,
        tableName: 'autonomous_agent_logs',
      });
    }
  }

  private getLogIcon(type: string, module: string): string {
    if (type === 'ERROR') return '❌';
    if (type === 'WARN') return '⚠️';
    if (module === 'CORE') return '⚙️';
    if (module === 'ANALYZER') return '🧠';
    if (module === 'DECISION') return '🔍';
    if (module === 'EXECUTION') return '🎯';
    if (module === 'RISK') return '🛡️';
    return '📝';
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    const state = this.userStates.get(userId);
    if (!state) return null;
    return {
      userId: state.userId,
      isActive: state.isActive,
      currentProfit: state.profit,
      currentLoss: Math.abs(Math.min(0, state.profit)),
      operationsCount: state.opsTotal,
      mode: state.mode,
      consecutiveWins: state.wins,
      consecutiveLosses: state.consecutiveLosses,
    };
  }

  async resetDailySession(userId: string): Promise<void> {
    const state = this.userStates.get(userId);
    const config = this.userConfigs.get(userId);
    if (state && config) {
      state.profit = 0;
      state.lucroAtual = 0;
      state.peakProfit = 0;
      state.consecutiveLosses = 0;
      state.perdasAcumuladas = 0;
      state.opsTotal = 0;
      state.opsCount = 0;
      state.wins = 0;
      state.losses = 0;
      state.cycleCurrent = 1;
      state.cycleProfit = 0;
      state.cycleOps = 0;
      state.cyclePeakProfit = 0;
      state.blindadoActive = false;
      state.blindadoFloorProfit = 0;
      state.sessionEnded = false;
      state.mode = config.mode || 'NORMAL';
      await this.updateUserStateInDb(userId, state);
    }
  }

  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    if (this.wsConnections.has(token)) {
      const existing = this.wsConnections.get(token)!;
      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        return {
          ws: existing.ws,
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
            this.subscribeViaConnection(token, payload, callback, String(subId), timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      }
      this.wsConnections.delete(token);
    }

    return new Promise((resolve, reject) => {
      let authResolved = false;
      const socket = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.appId}`);
      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          authResolved = true;
          this.wsConnections.delete(token);
          socket.terminate();
          reject(new Error('Timeout ao conectar/autorizar WebSocket (15s)'));
        }
      }, 15000);

      socket.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const conn = this.wsConnections.get(token);
          if (!conn) return;

          if (msg.msg_type === 'authorize' && !authResolved) {
            authResolved = true;
            clearTimeout(connectionTimeout);
            if (msg.error) {
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(msg.error.message || 'Erro na autorização'));
              return;
            }
            conn.authorized = true;
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
            }, 30000);
            resolve({
              ws: socket,
              sendRequest: (p, t = 60000) => this.sendRequestViaConnection(token, p, t),
              subscribe: (p, c, s, t = 90000) => this.subscribeViaConnection(token, p, c, s, t),
              removeSubscription: (s) => this.removeSubscriptionFromConnection(token, s),
            });
            return;
          }

          if (msg.proposal_open_contract) {
            const subId = String(msg.proposal_open_contract.contract_id);
            if (conn.subscriptions.has(subId)) conn.subscriptions.get(subId)!(msg);
            return;
          }

          const reqId = msg.req_id || msg.echo_req?.passthrough?.req_id;
          if (reqId && conn.pendingRequests.has(reqId)) {
            const pending = conn.pendingRequests.get(reqId)!;
            clearTimeout(pending.timeout);
            conn.pendingRequests.delete(reqId);
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg);
          }
        } catch (e) { }
      });

      socket.on('open', () => {
        this.wsConnections.set(token, {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        });
        socket.send(JSON.stringify({ authorize: token }));
      });

      socket.on('error', (e) => {
        if (!authResolved) {
          authResolved = true;
          clearTimeout(connectionTimeout);
          reject(e);
        }
      });

      socket.on('close', () => {
        const conn = this.wsConnections.get(token);
        if (conn?.keepAliveInterval) clearInterval(conn.keepAliveInterval);
        this.wsConnections.delete(token);
      });
    });
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
      const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });

      const enrichedPayload = {
        ...payload,
        passthrough: {
          ...payload.passthrough,
          req_id: requestId,
        },
      };

      conn.ws.send(JSON.stringify(enrichedPayload));
    });
  }

  /**
   * ✅ Subscreve para atualizações via conexão existente
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

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.subscriptions.delete(subId);
        reject(new Error(`Timeout ao inscrever ${subId}`));
      }, timeoutMs);

      const wrappedCallback = (msg: any) => {
        if (msg.proposal_open_contract || msg.error) {
          clearTimeout(timeout);
          if (msg.error) {
            conn.subscriptions.delete(subId);
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
          conn.subscriptions.set(subId, callback);
          resolve();
          callback(msg);
          return;
        }
        callback(msg);
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
    }
  }

  /**
   * ✅ Warm-up de conexão (Ping)
   */
  private async warmUpConnection(token: string): Promise<void> {
    try {
      const { sendRequest } = await this.getOrCreateWebSocketConnection(token);
      await sendRequest({ ping: 1 }, 5000);
    } catch (error) {
      this.logger.debug(`[Falcon] ⚠️ WarmUp failed for token ending in ...${token.slice(-4)}`);
    }
  }

  // ============================================
  // LOGS PADRONIZADOS ZENIX v2.0 (Portado de Orion)
  // ============================================

  // --- CATEGORIA 1: CONFIGURAÇÃO E SESSÃO ---

  private logInitialConfigV2(userId: string, config: {
    agentName: string;
    operationMode: string;
    riskProfile: string;
    profitTarget: number;
    stopLoss: number;
    stopBlindadoEnabled: boolean;
    symbol: string;
  }) {
    const message = `⚙️ CONFIGURAÇÃO INICIAL\n` +
      `• Agente: ${config.agentName}\n` +
      `• Mercado: ${config.symbol}\n` +
      `• Modo: ${config.operationMode}\n` +
      `• Perfil: ${config.riskProfile}\n` +
      `• Meta Lucro: $${config.profitTarget.toFixed(2)}\n` +
      `• Stop Loss: $${config.stopLoss.toFixed(2)}\n` +
      `• Stop Blindado: ${config.stopBlindadoEnabled ? '✅ ATIVO' : '❌ DESATIVADO'}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'CORE', message);
  }

  private logSessionStart(userId: string, session: {
    date: Date;
    initialBalance: number;
    profitTarget: number;
    stopLoss: number;
    mode: string;
    agentName: string;
  }) {
    const message = `🚀 INICIANDO SESSÃO DE OPERAÇÕES\n` +
      `• Banca Inicial: $${session.initialBalance.toFixed(2)}\n` +
      `• Meta do Dia: +$${session.profitTarget.toFixed(2)}\n` +
      `• Stop Loss: -$${session.stopLoss.toFixed(2)}\n` +
      `• Modo: ${session.mode}\n` +
      `• Agente: ${session.agentName}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'CORE', message);
  }

  // --- CATEGORIA 2: COLETA E ANÁLISE ---

  private logDataCollection(userId: string, data: {
    targetCount: number;
    currentCount: number;
    mode?: string;
  }) {
    const modeStr = data.mode ? ` (${data.mode})` : '';
    const message = `📡 COLETANDO DADOS...\n` +
      `• META DE COLETA: ${data.targetCount} TICKS${modeStr}\n` +
      `• CONTAGEM: ${data.currentCount}/${data.targetCount}`;

    this.saveLog(userId, 'INFO', 'ANALYZER', message);
  }

  private logAnalysisStarted(userId: string, mode: string, tickCount?: number) {
    const countStr = tickCount ? ` (Ticks: ${tickCount})` : '';
    const message = `🧠 ANÁLISE DO MERCADO\n` +
      `• MODO: ${mode}\n` +
      `• STATUS: Monitorando padrões${countStr}\n` +
      `• AÇÃO: Aguardando oportunidade...`;

    this.saveLog(userId, 'INFO', 'ANALYZER', message);
  }

  private logBlockedEntry(userId: string, blocked: {
    reason: string;
    details?: string;
  }) {
    const message = `⏸️ ENTRADA BLOQUEADA\n` +
      `• Motivo: ${blocked.reason}\n` +
      (blocked.details ? `• Detalhes: ${blocked.details}` : '');

    this.saveLog(userId, 'WARN', 'ANALYZER', message);
  }

  private logSignalGenerated(userId: string, signal: {
    mode: string;
    isRecovery: boolean;
    filters: string[];
    trigger: string;
    probability: number;
    contractType: string;
    direction?: 'CALL' | 'PUT' | 'DIGIT' | 'ODD' | 'EVEN';
  }) {
    let message = `🔍 ANÁLISE: MODO ${signal.mode}${signal.isRecovery ? ' (RECUPERAÇÃO)' : ''}\n`;
    signal.filters.forEach((filter, index) => {
      message += `✅ FILTRO ${index + 1}: ${filter}\n`;
    });
    message += `✅ GATILHO: ${signal.trigger}\n`;
    message += `💪 FORÇA DO SINAL: ${signal.probability}%\n`;

    if (signal.direction) {
      message += `📊 ENTRADA: ${signal.contractType} ${signal.direction}`;
    } else {
      message += `📊 ENTRADA: ${signal.contractType}`;
    }

    this.logger.log(`[Falcon][${userId}] SINAL: ${signal.trigger} | ${signal.direction}`);
    this.saveLog(userId, 'INFO', 'DECISION', message);
  }

  // --- CATEGORIA 3: EXECUÇÃO E RESULTADOS ---

  private async logTradeResultV2(userId: string, result: {
    status: 'WIN' | 'LOSS';
    profit: number;
    stake: number;
    balance: number;
  }) {
    const icon = result.status === 'WIN' ? '✅' : '❌';
    const message = `${icon} TRADE FINALIZADO: ${result.status}\n` +
      `• Resultado: ${result.status === 'WIN' ? '+' : '-'}$${result.profit.toFixed(2)}\n` +
      `• Stake: $${result.stake.toFixed(2)}\n` +
      `• Banca Atual: $${result.balance.toFixed(2)}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    await this.saveLog(userId, result.status === 'WIN' ? 'INFO' : 'WARN', 'EXECUTION', message);
  }

  private async logSuccessfulRecoveryV2(userId: string, data: {
    recoveredLoss: number;
    additionalProfit: number;
  }) {
    const message = `🛡️ RECUPERAÇÃO CONCLUÍDA\n` +
      `• Perda Recuperada: $${data.recoveredLoss.toFixed(2)}\n` +
      `• Lucro Adicional: $${data.additionalProfit.toFixed(2)}\n` +
      `• Ação: Retornando ao Modo Normal`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    await this.saveLog(userId, 'INFO', 'EXECUTION', message);
  }

  // --- CATEGORIA 4: RISCO E ALERTAS ---

  private logRiskAlert(userId: string, alert: {
    type: 'STOP_LOSS' | 'PROFIT_TARGET' | 'DRAWDOWN' | 'LIMIT_OPS';
    message: string;
    value?: number;
  }) {
    const icon = alert.type === 'PROFIT_TARGET' ? '🎯' : '⚠️';
    const message = `${icon} ALERTA DE RISCO: ${alert.type}\n` +
      `• Mensagem: ${alert.message}` +
      (alert.value !== undefined ? `\n• Valor: $${alert.value.toFixed(2)}` : '');

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, alert.type === 'PROFIT_TARGET' ? 'INFO' : 'ERROR', 'RISK', message);
  }

  private logStatusUpdate(userId: string, status: {
    currentProfit: number;
    targetRemaining: number;
    stopRemaining: number;
    isBlindado: boolean;
  }) {
    const message = `📊 STATUS DA SESSÃO\n` +
      `• Lucro Atual: $${status.currentProfit.toFixed(2)}\n` +
      `• Falta para Meta: $${status.targetRemaining.toFixed(2)}\n` +
      `• Distância do Stop: $${status.stopRemaining.toFixed(2)}\n` +
      `• Proteção Blindada: ${status.isBlindado ? 'ATIVA 🛡️' : 'INATIVA ❌'}`;

    this.saveLog(userId, 'INFO', 'RISK', message);
  }

  private logWinStreak(userId: string, streak: {
    consecutiveWins: number;
    accumulatedProfit: number;
    currentStake: number;
  }) {
    const message = `🔥 SEQUÊNCIA DE VITÓRIAS!\n` +
      `• Vitórias Consecutivas: ${streak.consecutiveWins}\n` +
      `• Lucro Acumulado: $${streak.accumulatedProfit.toFixed(2)}\n` +
      `• Próxima Stake: $${streak.currentStake.toFixed(2)}`;

    this.saveLog(userId, 'INFO', 'RISK', message);
  }

  private logMartingaleAdjustment(userId: string, adjustment: {
    level: number;
    reason: string;
    nextStake: number;
  }) {
    const message = `🔄 AJUSTE DE MARTINGALE\n` +
      `• Nível: ${adjustment.level}\n` +
      `• Motivo: ${adjustment.reason}\n` +
      `• Próxima Stake: $${adjustment.nextStake.toFixed(2)}`;

    this.saveLog(userId, 'WARN', 'RISK', message);
  }

  private logStopLossAdjustmentV2(userId: string, adjustment: {
    calculatedStake: number;
    remainingUntilStop: number;
    adjustedStake: number;
  }) {
    const message = `⚠️ AJUSTE DE RISCO (STOP LOSS)\n` +
      `• Stake Calculada: $${adjustment.calculatedStake.toFixed(2)}\n` +
      `• Saldo Restante até Stop: $${adjustment.remainingUntilStop.toFixed(2)}\n` +
      `• Ação: Reduzindo para $${adjustment.adjustedStake.toFixed(2)}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'WARN', 'RISK', message);
  }
}
