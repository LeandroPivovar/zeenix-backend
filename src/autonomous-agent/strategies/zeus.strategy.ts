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
// ZEUS V2 - INTERFACES
interface ZeusUserConfig extends AutonomousAgentConfig {
    // Identity
    strategyName: 'ZEUS'; // ✅ Fix: Literal type
    subtitle: string;
    symbol: string;
    is24x7: boolean;

    // Financial
    initialCapital: number;
    profitTarget: number;
    stopLoss: number;
    baseStake: number;

    // Risk
    riskProfile: RiskProfile; // CONSERVADOR, MODERADO, AGRESSIVO, FIXO

    // Protection (Blindado)
    enableStopLossBlindado: boolean;
    blindadoTriggerPctOfTarget: number; // 40% (0.4)
    blindadoProtectPctOfPeak: number;   // 50% (0.5)

    // Payouts
    payoutPrimary: number;  // 1.26
    payoutRecovery: number; // 1.26

    // Timers
    strategicPauseEnabled: boolean;
    strategicPauseSeconds: number; // 300s (5m)
    cooldownWinSeconds: number;    // 2s
    cooldownLossSeconds: number;   // 2s
    dataCollectionTicks: number;

    // V4 Limits
    limitOpsDay?: number;    // 2000 (Normal) / 400 (Preciso)
    limitOpsCycle?: number;  // 500 (Normal) / 100 (Preciso)

    // Operation Mode
    mode?: 'NORMAL' | 'PRECISO';
    operationMode?: 'NORMAL' | 'PRECISO';
}

interface ZeusUserState extends AutonomousAgentState {
    timestamp?: number; // Para logging/debug

    // Session
    balance: number;
    profit: number;        // Global Session Net Profit
    peakProfit: number;    // Highest Session Profit

    // Cycle Management (V4)
    cycleCurrent: number;      // 1 to 4
    cycleTarget: number;       // 25% of Daily Target
    cycleProfit: number;       // Net Profit of Current Cycle
    cycleMaxDrawdown: number;  // 60% of Cycle Target
    cyclePeakProfit: number;   // Highest Profit in Current Cycle
    cycleOps: number;          // Operations in Current Cycle

    // Blindado State
    blindadoActive: boolean;
    blindadoFloorProfit: number;
    recoveryLock: boolean; // ✅ V4 REQUIRED

    // Flags
    inStrategicPauseUntilTs: number;
    sessionEnded: boolean;
    endReason?: "TARGET" | "STOPLOSS" | "BLINDADO"; // ✅ Fix: Stricter type

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

    // Compatibility (Infra)
    lucroAtual: number;       // ✅ Fix: Required
    opsCount: number;         // ✅ Fix: Required

    // System
    currentContractId: string | null;
    currentTradeId: number | null;
    isWaitingContract: boolean;
    lastContractType?: string;
    ticksSinceLastAnalysis: number;
    lastDigits: number[];
    lastOpProfit?: number;
}
import { LogQueueService } from '../../utils/log-queue.service';

/**
 * ⚡ ZEUS Strategy para Agente Autônomo - Versão 2.1
 * 
 * CORE: Price Action (Trend + Volatility/Delta)
 * - MODO NORMAL: Janela 7 ticks, 4/6 moves, delta >= 0.5. WR esperado ~76%.
 * - MODO LENTO: Janela 8 ticks, 5/7 moves, delta >= 0.7. WR esperado ~90%.
 * - Gestão: Soros Nível 1 no Normal, Smart Martingale no Lento.
 * - Proteção: Stop Blindado (40% meta ativa, proteção fixa de 50%).
 */

/**
 * ⚡ ZEUS Strategy Configuration - Versão 2.2 (Manual Técnico)
 */
/**
 * ⚡ ZEUS Strategy Configuration - Versão 2.3 (Aligned with Doc V4.0)
 */
// ⚡ ZEUS V2 - TYPES
export type NegotiationMode = "NORMAL" | "PRECISO";
export type RiskProfile = "CONSERVADOR" | "MODERADO" | "AGRESSIVO" | "FIXO";
export type AnalysisType = "PRINCIPAL" | "RECUPERACAO";
export type ContractKind = "DIGITS_OVER3" | "RISE_FALL";

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

export interface ZeusLogEvent {
    ts: number;
    id: ZenixLogId;
    title: string;
    lines: Array<{ text: string; color?: LogColor }>;
}

export const ZEUS_SUBTITLE = "Agente Autônomo de Análise Tick a Tick em Volatility Indices";

export const ZEUS_CONSTANTS = {
    symbol: "1HZ100V", // R_100 (100V 1s)
    payoutPrimary: 1.26, // 126% (Net Payout -> Gross ~130% - Markup)
    payoutRecovery: 1.26, // Same payout for recovery (Contract stays Digit Over 5)
    martingaleMaxLevel: 50, // "Sem limite" for Moderate/Aggressive, but kept high safe limit
    strategicPauseSeconds: 300, // 5 minutes (V4 Spec)
    cooldownWinSeconds: 2, // Fast re-entry
    cooldownLossSeconds: 2,
    dataCollectionTicks: 5, // Just need 4 for pattern + 1 safety
    cycles: 4,
    cyclePercent: 0.25,
};
@Injectable()
export class ZeusStrategy implements IAutonomousAgentStrategy, OnModuleInit {
    name = 'zeus';
    displayName = '⚡ ZEUS';
    description = 'Agente lendário com força de Zeus e precisão cirúrgica';

    private readonly logger = new Logger(ZeusStrategy.name);
    private readonly userConfigs = new Map<string, ZeusUserConfig>();
    private readonly userStates = new Map<string, ZeusUserState>();
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
            currency?: string; // ✅ Adicionado para suportar múltiplas moedas (BRL, USD, etc)
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
        this.appId = process.env.DERIV_APP_ID || '1089';
    }

    async onModuleInit() {
        this.logger.log(`⚡ ZEUS Strategy inicializado (App ID: ${this.appId})`);
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
           AND c.agent_type = 'zeus'
           AND c.session_status NOT IN ('stopped_profit', 'stopped_loss', 'stopped_blindado')`,
            );

            for (const user of activeUsers) {
                const userId = user.user_id.toString();

                // ✅ [RESOLUÇÃO DE TOKEN CENTRALIZADA]
                // Prioridade: 1. Preferência (user_settings) -> 2. Colunas Específicas (users) -> 3. Parsing Raw -> 4. Config Antiga
                let resolvedToken = user.config_token;
                const wantDemo = user.trade_currency === 'DEMO';

                if (wantDemo) {
                    if (user.token_demo) {
                        resolvedToken = user.token_demo;
                    } else if (user.deriv_raw) {
                        // Fallback: Tentar extrair token VRTC do JSON raw
                        try {
                            const raw = typeof user.deriv_raw === 'string' ? JSON.parse(user.deriv_raw) : user.deriv_raw;
                            if (raw.tokensByLoginId) {
                                const entry = Object.entries(raw.tokensByLoginId).find(([lid]) => (lid as string).startsWith('VRTC'));
                                if (entry) resolvedToken = entry[1] as string;
                            }
                        } catch (e) {
                            this.logger.warn(`[Zeus][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token: ${e.message}`);
                        }
                    }
                } else {
                    // Real Account
                    if (user.token_real) {
                        resolvedToken = user.token_real;
                    } else if (user.deriv_raw) {
                        // Fallback: Tentar extrair token Real (não-VRTC) do JSON raw
                        try {
                            const raw = typeof user.deriv_raw === 'string' ? JSON.parse(user.deriv_raw) : user.deriv_raw;
                            if (raw.tokensByLoginId) {
                                const entry = Object.entries(raw.tokensByLoginId).find(([lid]) => !(lid as string).startsWith('VRTC'));
                                if (entry) resolvedToken = entry[1] as string;
                            }
                        } catch (e) {
                            this.logger.warn(`[Zeus][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token (Real): ${e.message}`);
                        }
                    }
                }

                // Log para debug da resolução - DETALHADO POR SOLICITAÇÃO DO USUÁRIO
                this.logger.log(`[Zeus][${userId}] 🔍 Rastreio de Token:
                    - Config Token: ${user.config_token ? user.config_token.substring(0, 8) + '...' : 'N/A'}
                    - Trade Currency (Settings): ${user.trade_currency}
                    - Want Demo: ${wantDemo}
                    - Token Demo (User): ${user.token_demo ? user.token_demo.substring(0, 8) + '...' : 'N/A'}
                    - Token Real (User): ${user.token_real ? user.token_real.substring(0, 8) + '...' : 'N/A'}
                    - Resolved Token: ${resolvedToken ? resolvedToken.substring(0, 8) + '...' : 'N/A'}
                `);

                if (resolvedToken !== user.config_token) {
                    this.logger.log(`[Zeus][ResolucaoToken] User ${userId}: Token atualizado dinamicamente. Modo=${wantDemo ? 'DEMO' : 'REAL'}.`);
                }

                // ✅ Map Risk Profile from DB/Frontend to Enum
                const rawRisk = user.risk_level || 'balanced';
                const riskProfile = this.mapRiskProfile(rawRisk);

                const zeusConfig: ZeusUserConfig = {
                    // System
                    userId: userId,
                    initialStake: parseFloat(user.initial_stake),
                    dailyProfitTarget: parseFloat(user.daily_profit_target),
                    dailyLossLimit: parseFloat(user.daily_loss_limit),
                    derivToken: resolvedToken,
                    currency: user.currency,

                    // Zeus V2 defaults
                    strategyName: "ZEUS",
                    subtitle: ZEUS_SUBTITLE,
                    symbol: ZEUS_CONSTANTS.symbol,
                    is24x7: true,

                    initialCapital: parseFloat(user.initial_balance) || 0,
                    profitTarget: parseFloat(user.daily_profit_target),
                    stopLoss: parseFloat(user.daily_loss_limit),
                    baseStake: parseFloat(user.initial_stake),

                    riskProfile: riskProfile,

                    enableStopLossBlindado: user.stop_loss_type === 'blindado', // ✅ Fix mapping
                    blindadoTriggerPctOfTarget: 0.4,
                    blindadoProtectPctOfPeak: 0.5,

                    payoutPrimary: ZEUS_CONSTANTS.payoutPrimary,
                    payoutRecovery: ZEUS_CONSTANTS.payoutRecovery,

                    strategicPauseEnabled: true,
                    strategicPauseSeconds: ZEUS_CONSTANTS.strategicPauseSeconds,
                    cooldownWinSeconds: ZEUS_CONSTANTS.cooldownWinSeconds,
                    cooldownLossSeconds: ZEUS_CONSTANTS.cooldownLossSeconds,
                    dataCollectionTicks: ZEUS_CONSTANTS.dataCollectionTicks,

                    // ✅ V4 Limits
                    limitOpsDay: 2000,
                    limitOpsCycle: 500
                };

                this.userConfigs.set(userId, zeusConfig);

                // ✅ Verificar se já tem estado inicializado
                if (!this.userStates.has(userId)) {
                    this.initializeUserState(userId, zeusConfig);
                }

                // ✅ Log de sucesso (apenas na primeira vez/reconexão)
                this.logger.log(`[Zeus] ✅ Usuário sincronizado: ${userId} (${user.email || 'N/A'}) - Perfil: ${zeusConfig.riskProfile}`);
            }
        } catch (error) {
            this.logger.error(`[Zeus] ❌ Erro ao sincronizar usuários: ${error.message}`);
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
        return 'MODERADO'; // Default
    }

    /**
     * Inicializa estado do usuário
     */
    /**
     * Inicializa estado do usuário para Zeus V2
     */
    private initializeUserState(userId: string, config: ZeusUserConfig): void {
        const state: ZeusUserState = {
            userId,
            isActive: true, // System
            balance: config.initialCapital,
            profit: 0,
            peakProfit: 0,

            // Cycle Management (V4)
            cycleCurrent: 1,
            cycleTarget: config.profitTarget * ZEUS_CONSTANTS.cyclePercent, // 25% of daily target
            cycleProfit: 0,
            cycleMaxDrawdown: (config.profitTarget * ZEUS_CONSTANTS.cyclePercent) * 0.60, // 60% of cycle target
            cyclePeakProfit: 0,
            cycleOps: 0, // ✅ V4: Operations in Current Cycle

            blindadoActive: false,
            blindadoFloorProfit: 0,
            recoveryLock: false, // ✅ V4 REQUIRED

            inStrategicPauseUntilTs: 0,
            sessionEnded: false,

            // Automático
            // Automático: Se não vier no config, infere pelo perfil de Risco
            mode: config.mode || config.operationMode || (config.riskProfile === 'CONSERVADOR' ? 'PRECISO' : 'NORMAL'),
            analysis: "PRINCIPAL",

            // Perdas
            consecutiveLosses: 0,
            perdasAcumuladas: 0,

            // Controle
            lastOpTs: 0,
            cooldownUntilTs: 0,

            // Métricas
            opsTotal: 0,
            wins: 0,
            losses: 0,

            // Compatibility fields (infra)
            lucroAtual: 0,
            opsCount: 0,
            currentProfit: 0,   // ✅ Inherited from AutonomousAgentState
            currentLoss: 0,     // ✅ Inherited from AutonomousAgentState
            operationsCount: 0, // ✅ Inherited from AutonomousAgentState
            currentContractId: null,
            currentTradeId: null,
            isWaitingContract: false,
            ticksSinceLastAnalysis: 0,
            lastDigits: [],
            lastOpProfit: 0,
        };

        this.userStates.set(userId, state);
        this.ticks.set(userId, []);
    }

    async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
        // Mapear AutonomousAgentConfig (DB) para ZeusConfig (Spec)
        // Valores default do Spec `buildDefaultConfig`
        const rawRisk = (config as any).riskProfile || (config as any).riskLevel || 'balanced';
        const risk = this.mapRiskProfile(rawRisk);

        // Coletar token resolvido anteriormente ou do config
        const derivToken = config.derivToken; // Já resolvido na syncActiveUsersFromDb

        const zeusConfig: ZeusUserConfig = {
            ...config, // Mantém compatibilidade com infra (userId, etc)

            strategyName: "ZEUS",
            subtitle: ZEUS_SUBTITLE,
            symbol: ZEUS_CONSTANTS.symbol,
            is24x7: true,

            initialCapital: config.initialBalance || 0,
            profitTarget: config.dailyProfitTarget,
            stopLoss: config.dailyLossLimit,
            baseStake: parseFloat(config.initialStake.toString()),

            riskProfile: risk,

            enableStopLossBlindado: (config as any).stopLossType === 'blindado',
            blindadoTriggerPctOfTarget: 0.4,
            blindadoProtectPctOfPeak: 0.5,

            payoutPrimary: ZEUS_CONSTANTS.payoutPrimary,
            payoutRecovery: ZEUS_CONSTANTS.payoutRecovery,

            strategicPauseEnabled: true,
            strategicPauseSeconds: ZEUS_CONSTANTS.strategicPauseSeconds,
            cooldownWinSeconds: ZEUS_CONSTANTS.cooldownWinSeconds,
            cooldownLossSeconds: ZEUS_CONSTANTS.cooldownLossSeconds,
            dataCollectionTicks: ZEUS_CONSTANTS.dataCollectionTicks,

            // ✅ V4 Limits (Normal vs Preciso logic)
            // Normal: 2000/500 | Preciso: 400/100
            // Normal: 2000/500 | Preciso: 400/100 (Auto-infer from Risk if mode not set)
            limitOpsDay: ((config as any).mode === 'PRECISO' || (config as any).operationMode === 'PRECISO' || risk === 'CONSERVADOR') ? 400 : 2000,
            limitOpsCycle: ((config as any).mode === 'PRECISO' || (config as any).operationMode === 'PRECISO' || risk === 'CONSERVADOR') ? 100 : 500
        };
        // Actually, we should probably set them based on a default assumption or fetch mode?
        // For now, setting safe defaults.


        // ✅ Proteção contra reset de estado pelo Sync (5min)
        if (this.userConfigs.has(userId)) {
            const existingConfig = this.userConfigs.get(userId);
            const hasSignificantChange = existingConfig && (
                existingConfig.riskProfile !== zeusConfig.riskProfile ||
                existingConfig.dailyProfitTarget !== zeusConfig.dailyProfitTarget ||
                existingConfig.dailyLossLimit !== zeusConfig.dailyLossLimit ||
                existingConfig.initialStake !== zeusConfig.initialStake
            );

            if (!hasSignificantChange) {
                // Se não mudou nada importante, apenas mantém e retorna sem logar sessão de novo
                this.userConfigs.set(userId, zeusConfig);
                return;
            }

            this.logger.log(`[Zeus][${userId}] 🔄 Atualizando configuração (Usuário já ativo - Mudança detectada).`);
            this.userConfigs.set(userId, zeusConfig);

            // Apenas garantir que está ativo (se não estiver pausado por stop)
            const state = this.userStates.get(userId);
            if (state && !state.isActive) {
                state.isActive = true;
            }

            // ✅ Log de reativação com configs atualizadas
            const mode = state?.mode || 'PRECISO';
            this.logInitialConfigV2(userId, {
                agentName: 'Zeus',
                operationMode: mode,
                riskProfile: zeusConfig.riskProfile || 'MODERADO',
                profitTarget: zeusConfig.dailyProfitTarget,
                stopLoss: zeusConfig.dailyLossLimit,
                stopBlindadoEnabled: zeusConfig.stopLossType === 'blindado'
            });

            this.logSessionStart(userId, {
                date: new Date(),
                initialBalance: zeusConfig.initialBalance || 0,
                profitTarget: zeusConfig.dailyProfitTarget,
                stopLoss: zeusConfig.dailyLossLimit,
                mode: mode,
                agentName: 'Zeus'
            });

            return;
        }

        this.userConfigs.set(userId, zeusConfig);
        this.initializeUserState(userId, zeusConfig);

        // ✅ PRÉ-AQUECER conexão WebSocket para evitar erro "Conexão não está pronta"
        try {
            this.logger.log(`[Zeus][${userId}] 🔌 Pré-aquecendo conexão WebSocket...`);
            await this.warmUpConnection(zeusConfig.derivToken);
            this.logger.log(`[Zeus][${userId}] ✅ Conexão WebSocket pré-aquecida e pronta`);
        } catch (error: any) {
            this.logger.warn(`[Zeus][${userId}] ⚠️ Erro ao pré-aquecer conexão (continuando mesmo assim):`, error.message);
        }

        // ✅ Obter modo do estado (inicializado como 'NORMAL')
        const state = this.userStates.get(userId);
        const mode = state?.mode || 'NORMAL';


        // ✅ Log de ativação no padrão Orion
        this.logInitialConfigV2(userId, {
            agentName: 'Zeus',
            operationMode: mode,
            riskProfile: zeusConfig.riskProfile || 'MODERADO',
            profitTarget: zeusConfig.dailyProfitTarget,
            stopLoss: zeusConfig.dailyLossLimit,
            stopBlindadoEnabled: zeusConfig.stopLossType === 'blindado'
        });

        this.logSessionStart(userId, {
            date: new Date(),
            initialBalance: zeusConfig.initialBalance || 0,
            profitTarget: zeusConfig.dailyProfitTarget,
            stopLoss: zeusConfig.dailyLossLimit,
            mode: mode,
            agentName: 'Zeus'
        });

        this.logger.log(`[Zeus] ✅ Usuário ${userId} ativado | Symbol: ${zeusConfig.symbol} | Total configs: ${this.userConfigs.size}`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.userConfigs.delete(userId);
        this.userStates.delete(userId);
        this.ticks.delete(userId);
        this.logger.log(`[Zeus] ✅ Usuário ${userId} desativado`);
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
        const tickSymbol = symbol || 'R_100'; // ✅ Todos os agentes autônomos usam R_100

        // ✅ Log de debug para verificar se está recebendo ticks
        // this.logger.debug(`[Zeus] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);

        if (this.userConfigs.size === 0) {
            // this.logger.warn(`[Zeus] ⚠️ Tick recebido mas nenhum usuário configurado.`);
            return;
        }

        // ✅ Processar para todos os usuários ativos
        for (const [userId, config] of this.userConfigs.entries()) {
            // ✅ Log temporário para debug de match
            // this.logger.debug(`[Zeus] Checking match: TickSymbol=${tickSymbol} vs UserSymbol=${config.symbol}`);

            if (this.isSymbolMatch(tickSymbol, config.symbol)) {
                promises.push(this.processTickForUser(userId, tick).catch((error) => {
                    this.logger.error(`[Zeus][${userId}] Erro ao processar tick:`, error);
                }));
            } else {
                // Log mismatch only once per 100 ticks to avoid spam but allow debugging
                if (Math.random() < 0.01) {
                    this.logger.warn(`[Zeus][DEBUG] Symbol Mismatch: Tick=${tickSymbol} User=${config.symbol}`);
                }
            }
        }

        await Promise.all(promises);
    }

    /**
     * Processa tick para um usuário específico
     */
    /**
     * ✅ LOGIC HELPER: Extrair último dígito
     */
    /**
     * ✅ LOGIC HELPER: Extrair último dígito
     */
    private lastDigitFromPrice(price: number, symbol: string = '1HZ100V'): number {
        let precision = 2; // Default 1HZ100V / R_100

        // Ajuste de precisão por ativo
        if (symbol.includes('R_10') || symbol.includes('1HZ10V')) precision = 3;
        if (symbol.includes('R_25') || symbol.includes('1HZ25V')) precision = 3;
        // ✅ V4 OPTIMIZED: R_50 no Deriv tem 2 dígitos ativos que saltam. 4 dígitos traz muitos zeros.
        if (symbol.includes('R_50') || symbol.includes('1HZ50V')) precision = 2;
        if (symbol.includes('R_75') || symbol.includes('1HZ75V')) precision = 4;
        if (symbol.includes('R_100') || symbol.includes('1HZ100V')) precision = 2;

        const priceStr = price.toFixed(precision);
        return parseInt(priceStr.slice(-1), 10);
    }

    /**
     * ✅ LOGIC HELPER: Filtros Principais (Digits Over 3)
     */
    /**
     * ✅ LOGIC HELPER: Filtro Onda Alta (V4 Spec)
     * Regra: Sequência de 4 dígitos altos consecutivos (6, 7, 8, 9)
     */
    private filtroOndaAlta(digits: number[]): { passes: boolean; reason?: string; metrics?: any } {
        const sequence = digits.slice(-4);
        const isHigh = sequence.every(d => d >= 6);

        if (isHigh) {
            // ✅ V4 OPTIMIZATION (Phase 1): Stricter "Onda Alta"
            // Requer pelo menos 2 dígitos >= 7 para garantir força na tendência
            const strongDigits = sequence.filter(d => d >= 7).length;
            if (strongDigits >= 2) {
                return { passes: true, metrics: { sequence } };
            }
            return { passes: false, reason: `Onda Fraca (Muitos 6s): [${sequence.join(', ')}]` };
        }
        return { passes: false, reason: `Dígitos não são todos altos: [${sequence.join(', ')}]` };
    }

    /**
     * ✅ LOGIC HELPER: Filtro Quarteto Perfeito (V4 Spec)
     * Regra: Sequência de 4 dígitos altos consecutivos e TODOS DIFERENTES
     */
    private filtroQuartetoPerfeito(digits: number[]): { passes: boolean; reason?: string; metrics?: any } {
        const sequence = digits.slice(-4);
        const isHigh = sequence.every(d => d >= 6);

        if (!isHigh) {
            return { passes: false, reason: `Dígitos não são todos altos: [${sequence.join(', ')}]` };
        }

        const unique = new Set(sequence);
        if (unique.size === 4) {
            return { passes: true, metrics: { sequence } };
        }
        return { passes: false, reason: `Dígitos repetidos: [${sequence.join(', ')}]` };
    }

    /**
     * ✅ LOGIC HELPER: Filtro de Densidade de Dígitos (Novo)
     * Regra: Frequência de dígitos altos (6,7,8,9) >= 40% nos últimos 25 ticks
     */
    private filtroDensidade(digits: number[]): { passes: boolean; density: number; reason?: string } {
        const window = 25;
        const recent = digits.slice(-window);
        if (recent.length < 10) return { passes: true, density: 0.5 }; // Inicializando

        const highCount = recent.filter(d => d >= 6).length;
        const density = highCount / recent.length;

        if (density >= 0.40) {
            return { passes: true, density };
        }
        return { passes: false, density, reason: `Densidade de dígitos baixos (${(density * 100).toFixed(0)}%)` };
    }

    /**
     * ✅ LOGIC HELPER: Filtro de Dígito Fatal (Novo)
     * Regra: Bloquear entrada se o último dígito for 5
     */
    private filtroDigitoFatal(digits: number[]): { passes: boolean; reason?: string } {
        if (digits.length === 0) return { passes: true };
        const last = digits[digits.length - 1];
        if (last === 5) {
            return { passes: false, reason: `Dígito Fatal (5) detectado` };
        }
        return { passes: true };
    }

    /**
     * ✅ LOGIC HELPER: Filtro de Lado (Paridade / LALDO)
     * Regra: Se a densidade de um lado (Par ou Ímpar) for >= 60% nos últimos 20 ticks
     */
    private filtroLadoParidade(digits: number[]): { passes: boolean; side?: string; density?: number; reason?: string } {
        const window = 2; // ✅ Sequência curta para evitar lógica de densidade estendida
        const lastDigits = digits.slice(-window);
        if (lastDigits.length < window) {
            return { passes: false, reason: `Dados insuficientes (${lastDigits.length}/${window})` };
        }

        const isEven = lastDigits.every(d => d % 2 === 0);
        const isOdd = lastDigits.every(d => d % 2 !== 0);

        if (isEven) {
            return { passes: true, side: 'PAR', density: 100 };
        }
        if (isOdd) {
            return { passes: true, side: 'ÍMPAR', density: 100 };
        }

        return { passes: false, reason: `Paridade inconsistente: [${lastDigits.join(', ')}]` };
    }


    /**
     * ✅ LOGIC HELPER: Filtro de Tendência (Price Action) - V4 Spec
     * Regra: Evitar entradas de Call/Over se o preço estiver caindo forte
     */
    private filtroTendencia(prices: number[]): { passes: boolean; status: 'UP' | 'DOWN' | 'NEUTRAL'; reason?: string } {
        if (prices.length < 5) return { passes: true, status: 'NEUTRAL' }; // Sem dados, confia nos dígitos

        const recentPrices = prices.slice(-5);
        const first = recentPrices[0];
        const last = recentPrices[recentPrices.length - 1];

        // ✅ V4 OPTIMIZATION: Evitar micro-quedas repentinas (3 ticks atrás)
        const prev3 = recentPrices[recentPrices.length - 4];
        if (last < prev3) {
            return { passes: false, status: 'DOWN', reason: `Micro-queda detectada (${last} < ${prev3})` };
        }

        // Simples variação total
        const change = last - first;

        if (change < 0) {
            // Contar quantos ticks foram de queda
            let drops = 0;
            for (let i = 1; i < recentPrices.length; i++) {
                if (recentPrices[i] < recentPrices[i - 1]) drops++;
            }

            // Se cair em 3 ou 4 dos últimos 4 intervalos, é queda forte
            if (drops >= 3) {
                return { passes: false, status: 'DOWN', reason: `Tendência de Baixa (${drops}/4 quedas)` };
            }
        }

        return { passes: true, status: change > 0 ? 'UP' : 'NEUTRAL' };
    }

    /**
     * ✅ LOGIC HELPER: Calcular Stake (Soros / Martingale)
     */
    /**
     * ✅ LOGIC HELPER: Calcular Stake (V4 Formulas)
     */
    private computeNextStake(config: ZeusUserConfig, state: ZeusState): number {
        // Se não houver perdas acumuladas, usa stake base
        if (state.perdasAcumuladas <= 0) {
            return config.baseStake;
        }

        let stake = config.baseStake;
        const perdas = state.perdasAcumuladas;
        const payoutLiq = 126; // 126% conforme spec V4

        switch (config.riskProfile) {
            case 'CONSERVADOR':
                // Recupera 100% das perdas
                stake = (perdas * 1.00 * 100) / payoutLiq;
                break;
            case 'MODERADO':
                // Recupera 100% + 15%
                stake = (perdas * 1.15 * 100) / payoutLiq;
                break;
            case 'AGRESSIVO':
                // Recupera 100% + 30%
                stake = (perdas * 1.30 * 100) / payoutLiq;
                break;
            case 'FIXO':
                stake = config.baseStake;
                break;
            default:
                return config.baseStake;
        }

        // Safety e Arredondamento
        let finalStake = Math.max(0.35, Math.ceil(stake * 100) / 100);

        // ✅ SMART GOAL (V4): Ajustar entrada para bater a meta exata (evitar exposição desnecessária)
        // Se falta pouco para a meta (do dia ou do ciclo), não apostar mais do que o necessário.
        const dailyGap = config.profitTarget - state.profit;
        const cycleGap = state.cycleTarget - state.cycleProfit;

        // 🚨 FIX: Em recuperação (Martingale), ignoramos o gap do ciclo e focamos na Meta Global.
        // Se tentarmos respeitar o ciclo durante a recuperação, a stake será capada e não recuperaremos o prejuízo total.
        const gapToTarget = (state.perdasAcumuladas > 0)
            ? Math.max(0, dailyGap)
            : Math.max(0, Math.min(dailyGap, cycleGap));

        // Calcular quanto precisamos apostar para ganhar o gapToTarget
        // Stake = Lucro / (Payout% / 100)
        // V4: O payout é dinâmico (Princial vs Recuperação), mas geralmente 126% (1.26x de lucro)
        const payoutRate = state.analysis === 'PRINCIPAL' ? (config.payoutPrimary || 1.26) : (config.payoutRecovery || 1.26);

        if (gapToTarget > 0 && gapToTarget < (finalStake * payoutRate)) {
            const neededStake = gapToTarget / payoutRate;
            let smartStake = Math.ceil(neededStake * 100) / 100;

            // Ensure minimum Deriv stake
            smartStake = Math.max(0.35, smartStake);

            if (smartStake < finalStake) {
                this.logger.log(`[Zeus][${config.userId}] 🎯 SMART GOAL: Ajustando stake de $${finalStake} para $${smartStake} para bater meta de $${gapToTarget.toFixed(2)}` +
                    (state.perdasAcumuladas <= 0 ? ` (Cycle Target: ${state.cycleTarget.toFixed(2)})` : ` (Recuperação Global)`));
                finalStake = smartStake;
            }
        }

        // ✅ Log Martingale Calculation for User Awareness
        // "Recuperando $20.00 (Total) com Stake de $18.26 (@126%)..."
        if (state.perdasAcumuladas > 0) {
            // this.saveLog is not available here easily without instance ref? 
            // Actually it is a private method of ZeusStrategy class, so yes 'this' works if called from instance.
            // But logger is safer.
        }

        // ✅ CYCLE DRAWDOWN PROTECTION: Cap stake to prevent exceeding 60% cycle loss
        // If we're already in negative territory for this cycle, ensure the next loss won't exceed the limit
        if (state.cycleProfit < 0) {
            const currentCycleLoss = Math.abs(state.cycleProfit);
            const remainingDrawdownAllowance = state.cycleMaxDrawdown - currentCycleLoss;

            if (remainingDrawdownAllowance > 0) {
                // Maximum we can afford to lose on this trade
                const maxAffordableLoss = remainingDrawdownAllowance;

                // Assuming worst case (100% loss of stake), cap the stake
                if (finalStake > maxAffordableLoss) {
                    const cappedStake = Math.max(0.35, Math.floor(maxAffordableLoss * 100) / 100);
                    this.logger.log(`[Zeus][${config.userId}] 🛡️ DRAWDOWN PROTECTION: Capping stake from $${finalStake.toFixed(2)} to $${cappedStake.toFixed(2)} ` +
                        `(Cycle Loss: $${currentCycleLoss.toFixed(2)}, Max Drawdown: $${state.cycleMaxDrawdown.toFixed(2)})`);
                    finalStake = cappedStake;
                }
            } else {
                // Already at or past the drawdown limit - should not happen if updateCycleState is working
                this.logger.error(`[Zeus][${config.userId}] ⚠️ Cycle already exceeded drawdown limit! This should trigger cycle end.`);
                return 0.35; // Minimum stake as safety
            }
        }

        return finalStake;
    }

    /**
     * ✅ LOGIC HELPER: Verificar se pode operar (V4 Limits)
     */
    private canOperate(userId: string, config: ZeusUserConfig, state: ZeusUserState): boolean {
        const nowTs = Date.now();

        if (state.sessionEnded) return false;
        if (nowTs < state.cooldownUntilTs) return false;
        if (nowTs < state.inStrategicPauseUntilTs) {
            // Log a cada 60 segundos para não floodar
            if (nowTs % 60000 < 1000) {
                const minutesLeft = Math.ceil((state.inStrategicPauseUntilTs - nowTs) / 60000);
                this.logger.log(`[Zeus][${userId}] ⏸️ Pausa Estratégica Ativa! Restam ${minutesLeft} minutos.`);
            }
            return false;
        }

        // ✅ V4 Limits Check
        const limitDay = config.limitOpsDay || 2000;
        if (state.opsTotal >= limitDay) {
            state.sessionEnded = true;
            state.endReason = "TARGET"; // Technically "LIMIT_REACHED" but treating as target/done
            this.logger.log(`[Zeus][${userId}] 🛑 Limite Diário de Operações atingido (${state.opsTotal}/${limitDay})`);
            this.handleStopCondition(userId, 'DAILY_LIMIT');
            return false;
        }

        const limitCycle = config.limitOpsCycle || 500;
        if (state.cycleOps >= limitCycle) {
            // ✅ V4 Checklist: 1 hora de pausa após Limite de Operações do Ciclo
            // ✅ Test Mode: Shortened to 10 min
            state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + 10 * 60 * 1000);
            this.logger.log(`[Zeus][${userId}] 🛑 Limite de Operações do Ciclo atingido (${state.cycleOps}/${limitCycle}). Pausando 10 min.`);
            this.saveLog(userId, 'WARN', 'CYCLE', `🛑 Limite de Operações do Ciclo atingido (${state.cycleOps}/${limitCycle}). Pausando 10 min.`);
            return false;
        }

        // STOPLOSS sessão (Global)
        const drawdown = Math.max(0, -state.profit); // Using global profit
        const roundedDrawdown = Math.round(drawdown * 100) / 100;
        if (roundedDrawdown >= config.stopLoss) {
            state.sessionEnded = true;
            state.endReason = "STOPLOSS";
            this.handleStopCondition(userId, 'STOP_LOSS_LIMIT');
            return false;
        }

        // Blindado (Ciclo)
        if (config.enableStopLossBlindado && state.blindadoActive) {
            const currentCycleProfit = Math.round(state.cycleProfit * 100) / 100;
            if (currentCycleProfit < state.blindadoFloorProfit) {
                state.sessionEnded = true;
                state.endReason = "BLINDADO";
                this.handleStopCondition(userId, 'BLINDADO');
                return false;
            }
        }

        // Meta Global
        const currentProfit = Math.round(state.profit * 100) / 100;
        if (currentProfit >= config.profitTarget) {
            state.sessionEnded = true;
            state.endReason = "TARGET";
            this.handleStopCondition(userId, 'TAKE_PROFIT');
            return false;
        }

        return true;
    }

    /**
     * ✅ CORE: Processar Tick
     */
    private async processTickForUser(userId: string, tick: Tick): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || !state.isActive) {
            if (Math.random() < 0.01) this.logger.warn(`[Zeus][${userId}] ⚠️ Tick ignorado: Config=${!!config} State=${!!state} Active=${state?.isActive}`);
            return;
        }

        // Infra: Check Lock
        if (this.processingLocks.get(userId)) return;

        // Infra: History & Digits
        const userTicks = this.ticks.get(userId) || [];
        userTicks.push(tick);
        this.ticks.set(userId, userTicks); // Ensure updated array is set back

        if (userTicks.length > config.dataCollectionTicks + 50) userTicks.shift();

        // Debug Log: Valid Tick Processed
        // if (userTicks.length <= 5) {
        //    this.saveLog(userId, 'INFO', 'CORE', `DEBUG: Tick processado #${userTicks.length}`);
        // }

        const lastDigit = this.lastDigitFromPrice(tick.value, config.symbol);
        state.lastDigits.push(lastDigit);
        if (state.lastDigits.length > 50) state.lastDigits.shift();

        // 1. Coleta de dados e progresso inicial
        const requiredTicks = config.dataCollectionTicks;
        if (userTicks.length < requiredTicks) {
            // Log de progresso imediato no primeiro tick e depois a cada 3
            if (userTicks.length === 1 || userTicks.length % 2 === 0) {
                this.logDataCollection(userId, {
                    targetCount: requiredTicks,
                    currentCount: userTicks.length,
                    mode: state.mode
                });
            }
            return;
        }

        // 2. Can we operate?
        if (!this.canOperate(userId, config, state)) return;

        // 2. Are we waiting for contract?
        if (state.isWaitingContract) {
            const marketAnalysis = this.analyzeMarket(userId, config, state, userTicks, state.lastDigits);
            if (marketAnalysis?.signal) {
                this.logBlockedEntry(userId, {
                    reason: 'OPERAÇÃO EM ANDAMENTO',
                    details: `Sinal ${marketAnalysis.signal} detectado em ${config.symbol}`
                });
            }
            return;
        }

        // 3. Analyze Market
        this.processingLocks.set(userId, true);
        try {
            const analysis = this.analyzeMarket(userId, config, state, userTicks, state.lastDigits);

            if (analysis && analysis.signal) {
                const stake = this.computeNextStake(config, state);

                if (stake < 0.35) {
                    // Stake inválida (provavelmente stop loss próximo)
                    return;
                }

                // Execute Trade
                if (state.perdasAcumuladas > 0 && config.riskProfile !== 'FIXO') {
                    this.saveLog(userId, 'INFO', 'RISK', `🔄 MARTINGALE (${config.riskProfile}): Recuperando $${state.perdasAcumuladas.toFixed(2)} com Stake $${stake} (Payout 126%)`);
                }

                await this.executeTrade(userId, {
                    action: 'BUY',
                    stake,
                    contractType: analysis.details.contractType,
                    reason: 'ZEUS_V2_SIGNAL',
                }, analysis);
            }
        } finally {
            this.processingLocks.set(userId, false);
        }
    }

    /**
     * ✅ CORE: Análise de Mercado (Substitui analyzeMarket antigo)
     */
    /**
     * ✅ CORE: Análise de Mercado (V4 Spec: Verifica padrões Onda Alta e Quarteto Perfeito)
     */
    private analyzeMarket(userId: string, config: ZeusUserConfig, state: ZeusState, pricesObj: Tick[], digits: number[]): MarketAnalysis | null {
        // V4 precisa de 4 dígitos para análise de padrão
        const MIN_TICKS = 4;
        if (digits.length < MIN_TICKS) return null;
        // 0. Preparar Dados de Tendência
        const ticks = this.ticks.get(userId) || []; // ✅ Fix: Retrieve ticks from state map

        // Converter ticks em array de preços para análise de tendência
        const prices = ticks.map(t => t.value);
        const trend = this.filtroTendencia(prices);

        // Se tendência for CLARAMENTE de baixa, abortar qualquer Call/Over
        if (!trend.passes && state.mode === 'PRECISO') { // Tendência importa mais no modo Preciso
            state.lastRejectionReason = trend.reason;

            // Log throttle logic duplication for early exit?
            // Better: Just store rejection and let heartbeat log it if needed
            // But we need to ensure we don't spam "Blocked by Trend"
            // Let's rely on the heartbeat at the end function
        }
        else {
            // Continue analysis only if Trend passes OR Mode is Normal (Normal is more aggressive)
        }

        // 1. Filtragem por Lado (Paridade) - Novo Requisito V4 Plus
        const fl = this.filtroLadoParidade(digits);

        // 2. Novos Filtros Estatísticos (Densidade e Fatal)
        const fd = this.filtroDensidade(digits);
        if (!fd.passes) {
            state.lastRejectionReason = fd.reason;
            return null;
        }

        const ff = this.filtroDigitoFatal(digits);
        if (!ff.passes) {
            state.lastRejectionReason = ff.reason;
            return null;
        }

        // 3. Check Quarteto Perfeito (Higher Priority/Precision)
        const qp = this.filtroQuartetoPerfeito(digits);
        if (qp.passes) {
            const sequence = qp.metrics?.sequence || [];

            // Se passar no Lado também, a confiança é máxima
            const hasLado = fl.passes;
            const probability = hasLado ? 75.0 : 68.0; // Bump probability per user feedback

            // ✅ MODO PRECISO REQUIRES LADO (Paridade)
            if (state.mode === 'PRECISO' && !hasLado) {
                state.lastRejectionReason = `Preciso requer confirmação de Lado (Paridade)`;
                return null;
            }

            // ✅ Check Trend as final gatekeeper for Preciso
            if (!trend.passes) {
                state.lastRejectionReason = trend.reason;
                return null;
            }

            this.saveLog(userId, 'INFO', 'CORE',
                `⚡ SINAL ENCONTRADO (PRECISO)\n` +
                `• Padrão Quarteto: [${sequence.join(', ')}]\n` +
                `• Filtro Lado: ${hasLado ? `✅ ATIVO (${fl.side} ${fl.density?.toFixed(0)}%)` : `⏸️ INATIVO`}`
            );

            state.lastRejectionReason = undefined;

            return {
                signal: 'DIGIT',
                probability,
                payout: config.payoutPrimary,
                confidence: probability / 100,
                details: {
                    contractType: 'DIGITOVER',
                    barrier: 5,
                    info: hasLado ? 'Quarteto Perfeito + Lado' : 'Quarteto Perfeito',
                    mode: 'PRECISO',
                    trend: trend.status
                }
            };
        }

        // 4. Check Onda Alta
        if (state.mode !== 'PRECISO') {
            const oa = this.filtroOndaAlta(digits);
            if (oa.passes) {
                const sequence = oa.metrics?.sequence || [];

                // Aplicar Filtro de Lado como confirmação para modo Normal
                const hasLado = fl.passes;
                const probability = hasLado ? 65.0 : 58.0;

                // ✅ Check Trend as final gatekeeper
                if (!trend.passes) {
                    state.lastRejectionReason = trend.reason;
                    return null;
                }

                this.saveLog(userId, 'INFO', 'CORE',
                    `⚡ SINAL ENCONTRADO (NORMAL)\n` +
                    `• Padrão Onda Alta: [${sequence.join(', ')}]\n` +
                    `• Filtro Lado: ${hasLado ? `✅ ATIVO (${fl.side} ${fl.density?.toFixed(0)}%)` : `⏸️ INATIVO`}`
                );

                state.lastRejectionReason = undefined;

                return {
                    signal: 'DIGIT',
                    probability,
                    payout: config.payoutPrimary,
                    confidence: probability / 100,
                    details: {
                        contractType: 'DIGITOVER',
                        barrier: 5,
                        info: hasLado ? 'Onda Alta + Lado' : 'Onda Alta',
                        mode: 'NORMAL',
                        trend: trend.status // Add trend info
                    }
                };
            }
            // Store rejection reason if Normal mode but failed
            if (!qp.passes) {
                state.lastRejectionReason = oa.reason || qp.reason || fl.reason;
            }
        } else {
            // If Preciso mode and QP failed, check if Lado was the blocker or pattern
            if (!qp.passes) {
                state.lastRejectionReason = qp.reason || fl.reason;
            }
        }

        // Heartbeat log (Throttled to prevent UI freeze - 1 log per ~15s)
        state.ticksSinceLastAnalysis = (state.ticksSinceLastAnalysis || 0) + 1;
        if (state.ticksSinceLastAnalysis >= 15) {
            state.ticksSinceLastAnalysis = 0;
            this.logAnalysisStarted(userId, state.mode, digits.length, state.lastRejectionReason);
        }

        return null;
    }

    // Métodos antigos placeholders removidos (isValidHour, processAgent, etc)


    /**
     * Stub para satisfazer interface IAutonomousAgentStrategy
     * (A lógica agora reside inteiramente em processTickForUser)
     */
    async processAgent(userId: string, marketAnalysis: any): Promise<any> {
        return { action: 'WAIT', reason: 'DEPRECATED_METHOD' };
    }

    /**
     * ✅ LOGIC HELPER: Verificar Stop Loss e Gerenciamento de Risco
     */
    private async checkStopLoss(userId: string, nextStake?: number): Promise<{ action: 'STOP' | 'WAIT' | 'BUY'; stake?: number; reason?: string }> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state) {
            return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
        }

        const stake = nextStake || 0;

        // 1. Stop Loss Normal
        const currentDrawdown = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;

        // Verificação de limite simples (já estourou?)
        if (currentDrawdown >= config.stopLoss) {
            return { action: 'STOP', reason: 'STOP_LOSS' };
        }

        // Verificação com a próxima stake
        if (currentDrawdown + stake > config.stopLoss) {
            const remaining = config.stopLoss - currentDrawdown;
            // Arredondar para 2 casas e garantir mínimo da Deriv (0.35)
            const adjustedStake = Math.round(remaining * 100) / 100;

            if (adjustedStake < 0.35) {
                this.logger.log(`[Zeus][${userId}] 🛑 STOP LOSS ATINGIDO POR AJUSTE DE ENTRADA!`);
                await this.saveLog(userId, 'WARN', 'RISK', `🛑 STOP LOSS ATINGIDO POR AJUSTE DE ENTRADA!\n• Motivo: Limite de perda diária alcançado.\n• Ação: Encerrando operações imediatamente.`);
                return { action: 'STOP', reason: 'STOP_LOSS_LIMIT' };
            }

            this.logger.log(`[Zeus][${userId}] ⛔ STAKE AJUSTADA PELO STOP: De ${stake.toFixed(2)} para ${adjustedStake.toFixed(2)}`);
            await this.saveLog(userId, 'WARN', 'RISK',
                `Risco de ultrapassar Stop Loss! perdas=${currentDrawdown.toFixed(2)}, stake=${stake.toFixed(2)}, limite=${config.stopLoss.toFixed(2)}. Ajustando para ${adjustedStake.toFixed(2)}`);

            return {
                action: 'BUY',
                stake: adjustedStake,
                reason: 'STOP_LOSS_ADJUSTED'
            };
        }

        // 2. Stop Loss Blindado (V2 + Smart Stop)
        if (config.enableStopLossBlindado && state.blindadoActive) {
            if (state.cycleProfit < state.blindadoFloorProfit) {
                return { action: 'STOP', reason: 'BLINDADO' };
            }

            // ✅ SMART STOP BLINDADO: Verificar se a stake atual faria romper o piso
            // Distância até o piso:
            const distToFloor = state.cycleProfit - state.blindadoFloorProfit;

            // Se a perda da aposta (valor da stake) for maior que a distância até o piso
            if (stake > distToFloor) {
                // Ajustar stake para proteger o piso
                const adjustedStake = Math.floor(distToFloor * 100) / 100;

                if (adjustedStake < 0.35) {
                    this.logger.log(`[Zeus][${userId}] 🛡️ STOP BLINDADO PRÓXIMO: Encerrando para proteger lucro.`);
                    return { action: 'STOP', reason: 'BLINDADO_SMART' };
                }

                this.logger.log(`[Zeus][${userId}] 🛡️ SMART BLINDADO: Ajustando stake de $${stake} para $${adjustedStake} para não romper piso.`);
                return {
                    action: 'BUY',
                    stake: adjustedStake,
                    reason: 'BLINDADO_ADJUSTED'
                };
            }
        }

        return { action: 'BUY', stake: stake };
    }

    /**
     * ✅ CORE: Executa trade (Zeus V2) - OTIMIZADO PARA LATÊNCIA ULTRA-BAIXA (0.3s - 0.5s)
     */
    private async executeTrade(userId: string, decision: TradeDecision, marketAnalysis: MarketAnalysis): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || decision.action !== 'BUY') {
            return;
        }

        if (state.isWaitingContract) {
            this.logger.warn(`[Zeus][${userId}] ⚠️ Tentativa de compra bloqueada: já aguardando resultado de contrato anterior`);
            return;
        }

        // 1. Checagem de Risco Ultra-Rápida (In-Memory)
        const stopLossCheck = await this.checkStopLoss(userId, decision.stake);
        if (stopLossCheck.action === 'STOP') {
            await this.handleStopCondition(userId, stopLossCheck.reason || 'STOP_LOSS');
            return;
        }

        const finalStake = stopLossCheck.stake || decision.stake || config.baseStake;
        const contractType = 'DIGITOVER';
        const barrier = "5";
        const duration = 1;

        // ✅ BLOQUEAR ENTRADA IMEDIATAMENTE
        state.isWaitingContract = true;

        const userTicks = this.ticks.get(userId) || [];
        const currentPrice = userTicks.length > 0
            ? userTicks[userTicks.length - 1].value
            : marketAnalysis.details?.currentPrice || 0;

        // 🧠 ESTRATÉGIA DE LATÊNCIA: Disparar compra e processar "papelada" em paralelo
        try {
            state.currentContractId = "PENDING";

            // 🎫 Inicia criação do registro no banco em background (sem await imediato)
            const tradeRecordPromise = this.createTradeRecord(
                userId,
                {
                    contractType: contractType || 'UNKNOWN',
                    stakeAmount: finalStake,
                    duration: duration,
                    marketAnalysis: marketAnalysis,
                    payout: state.analysis === "PRINCIPAL" ? config.payoutPrimary : config.payoutRecovery,
                    entryPrice: currentPrice,
                },
            );

            // 🚀 ENTRADA IMEDIATA: Chama o buyContract sem esperar o log ou o registro no banco
            const buyPromise = this.buyContract(
                userId,
                config.derivToken,
                contractType,
                config.symbol,
                finalStake,
                duration,
                barrier,
                1, // Reduzido retry interno para priorizar velocidade
                0  // TradeId será vinculado depois
            );

            // Registrar log de execução em paralelo
            this.saveLog(userId, 'INFO', 'TRADER', `⚡ EXECUTANDO: ${contractType} (Over 5) | Stake: $${finalStake.toFixed(2)} | Modo: ${state.mode}`);

            // Aguardar o resultado da compra (o ponto crítico de latência)
            const contractId = await buyPromise;

            // Aguardar o ID do registro no banco (deve estar pronto ou quase pronto)
            const tradeId = await tradeRecordPromise;
            state.currentTradeId = tradeId;

            if (contractId) {
                state.currentContractId = contractId;
                this.logger.log(`[Zeus][${userId}] 🎫 Contrato Confirmado: ${contractId} (TradeId: ${tradeId})`);

                // Atualizar status trade ativo (Background ok)
                this.updateTradeRecord(tradeId, {
                    contractId: contractId,
                    status: 'ACTIVE',
                }).catch(e => this.logger.error(`Error updating trade ${tradeId}`, e));
            } else {
                state.isWaitingContract = false;
                state.currentContractId = null;
                this.updateTradeRecord(tradeId, {
                    status: 'ERROR',
                    errorMessage: 'Falha na compra (Resposta nula)',
                }).catch(e => this.logger.error(`Error updating trade error ${tradeId}`, e));
                this.saveLog(userId, 'ERROR', 'API', `Erro na Corretora: Resposta de compra vazia.`);
                state.cooldownUntilTs = Date.now() + 15000;
            }
        } catch (error: any) {
            state.isWaitingContract = false;
            state.currentContractId = null;
            this.logger.error(`[Zeus][${userId}] Erro ao executar trade:`, error);

            // Exibir erro real do broker se disponível
            const errorMsg = error.message || 'Erro desconhecido';
            this.saveLog(userId, 'ERROR', 'API', `ERRO NA CORRETORA: ${errorMsg}`);

            if (state.currentTradeId) {
                this.updateTradeRecord(state.currentTradeId, {
                    status: 'ERROR',
                    errorMessage: errorMsg,
                }).catch(e => { });
            }

            // ✅ Cooldown após erro para evitar loop infinito de erros
            state.cooldownUntilTs = Date.now() + 15000;
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
                    currency: connection.currency || 'USD', // ✅ Usar moeda real da conta
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
            this.logger.error(`[Zeus] Erro ao obter payout:`, error);
            // Retornar valores padrão em caso de erro
            return 0.95; // 95% para Rise/Fall
        }
    }

    /**
     * Pré-aquece conexão WebSocket para garantir que esteja pronta
     * Envia um ping simples para forçar criação e autorização da conexão
     */
    async warmUpConnection(token: string): Promise<void> {
        try {
            await this.getOrCreateWebSocketConnection(token, 'warmup');
        } catch (error: any) {
            this.logger.warn(`[Zeus] Falha no warm-up: ${error.message}`);
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
        barrier?: string, // Adicionado barrier
        maxRetries = 2,
        tradeId: number = 0, // ✅ Adicionado tradeId
    ): Promise<string | null> {
        const roundedStake = Math.round(stake * 100) / 100;
        let lastError: Error | null = null;

        // ✅ Retry com backoff exponencial
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    // ✅ Backoff exponencial: 1s, 2s, 4s...
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    this.logger.warn(`[Zeus][${userId}] 🔄 Tentativa ${attempt + 1}/${maxRetries + 1} após ${delayMs}ms | Erro anterior: ${lastError?.message}`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }

                // ✅ Obter conexão do pool interno
                const connection = await this.getOrCreateWebSocketConnection(token, userId);

                // ✅ OBTER PROPOSTA (Estabilização V4)
                // Solicitar proposta antes de comprar garante que a Deriv valide saldo e parâmetros
                const proposalResponse = await connection.sendRequest(
                    {
                        proposal: 1,
                        amount: roundedStake,
                        basis: 'stake',
                        contract_type: contractType,
                        currency: connection.currency || 'USD',
                        duration: duration,
                        duration_unit: 't',
                        symbol: symbol,
                        barrier: barrier,
                    },
                    60000
                );

                const propError = proposalResponse.error || proposalResponse.proposal?.error;
                if (propError) {
                    const errorCode = propError?.code || '';
                    const errorMessage = propError?.message || JSON.stringify(propError);

                    // Erros de proposta geralmente não progridem
                    const nonRetryableErrors = ['InvalidAmount', 'InsufficientBalance', 'InvalidContract', 'InvalidSymbol', 'CustomLimitsViolated'];
                    if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
                        this.logger.error(`[Zeus][${userId}] ❌ Erro na proposta: ${errorMessage}`);
                        throw new Error(errorMessage);
                    }

                    lastError = new Error(errorMessage);
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ⚠️ Erro retentável na proposta (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                        continue;
                    }
                    throw lastError;
                }

                const proposalId = proposalResponse.proposal?.id;
                const askPrice = proposalResponse.proposal?.ask_price;

                if (!proposalId || askPrice === undefined) {
                    throw new Error('Proposta inválida recebida (sem id ou ask_price)');
                }

                // ✅ COMPRAR VIA PROPOSTA (Fluxo estável)
                const buyResponse = await connection.sendRequest(
                    {
                        buy: proposalId,
                        price: askPrice,
                    },
                    60000,
                );

                // ✅ Verificar erros na resposta - igual Orion
                const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
                if (buyErrorObj) {
                    const errorCode = buyErrorObj?.code || '';
                    const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);

                    // ✅ Alguns erros não devem ser retentados
                    const nonRetryableErrors = ['InvalidProposal', 'ProposalExpired', 'InsufficientBalance', 'InvalidAmount', 'InvalidContract', 'InvalidSymbol'];
                    if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
                        this.logger.error(`[Zeus][${userId}] ❌ Erro não retentável ao comprar: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
                        throw new Error(errorMessage);
                    }

                    // ✅ Erros retentáveis: tentar novamente
                    lastError = new Error(errorMessage);
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ⚠️ Erro retentável ao comprar (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                        continue;
                    }

                    this.logger.error(`[Zeus][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
                    throw lastError;
                }

                const contractId = buyResponse.buy?.contract_id;
                if (!contractId) {
                    lastError = new Error('Resposta de compra inválida - sem contract_id');
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ⚠️ Contrato sem contract_id (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(buyResponse)}`);
                        continue;
                    }
                    this.logger.error(`[Zeus][${userId}] ❌ Contrato criado mas sem contract_id após ${maxRetries + 1} tentativas: ${JSON.stringify(buyResponse)}`);
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

                            // ✅ Log de debug para rastrear atualizações do contrato
                            this.logger.debug(`[Zeus][${userId}] 📊 Atualização do contrato ${contractId}: is_sold=${contract.is_sold}, status=${contract.status}, profit=${contract.profit}`);

                            // ✅ Atualizar entry_price quando disponível - USANDO tradeId DO CLOSURE
                            if (contract.entry_spot && tradeId) {
                                this.updateTradeRecord(tradeId, {
                                    entryPrice: Number(contract.entry_spot),
                                }).catch((error) => {
                                    this.logger.error(`[Zeus][${userId}] Erro ao atualizar entry_price:`, error);
                                });
                            }

                            // ✅ Verificar se contrato foi rejeitado, cancelado ou expirado
                            if (contract.status === 'rejected' || contract.status === 'cancelled' || contract.status === 'expired') {
                                const errorMsg = `Contrato ${contract.status}: ${contract.error_message || 'Sem mensagem de erro'}`;
                                this.logger.error(`[Zeus][${userId}] ❌ Contrato ${contractId} foi ${contract.status}: ${errorMsg}`);

                                if (tradeId) {
                                    this.updateTradeRecord(tradeId, {
                                        status: 'ERROR',
                                        errorMessage: errorMsg,
                                    }).catch((error) => {
                                        this.logger.error(`[Zeus][${userId}] Erro ao atualizar trade com status ERROR:`, error);
                                    });
                                }

                                if (state) {
                                    state.isWaitingContract = false;
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

                                this.logger.log(`[Zeus][${userId}] ✅ Contrato ${contractId} finalizado: ${win ? 'WIN' : 'LOSS'} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Exit: ${exitPrice}`);

                                // Processar resultado - PASSANDO tradeId DO CLOSURE
                                this.onContractFinish(
                                    userId,
                                    {
                                        win,
                                        profit,
                                        contractId,
                                        exitPrice,
                                        stake,
                                        entryPrice: Number(contract.entry_spot || 0),
                                        entryTick: contract.entry_tick_value,
                                        exitTick: contract.exit_tick_value
                                    },
                                    tradeId
                                ).catch((error) => {
                                    this.logger.error(`[Zeus][${userId}] Erro ao processar resultado:`, error);
                                });

                                // Remover subscription usando pool interno
                                connection.removeSubscription(contractId);
                            }
                        }
                    },
                    contractId,
                    90000, // timeout 90s
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
                    this.logger.warn(`[Zeus][${userId}] ⚠️ Erro retentável (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                    continue;
                }

                // ✅ Se não é retentável ou esgotou tentativas, lançar erro para ser capturado no executeTrade
                if (attempt >= maxRetries) {
                    this.logger.error(`[Zeus][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${errorMessage}`, error?.stack);
                    throw new Error(errorMessage);
                } else {
                    this.logger.error(`[Zeus][${userId}] ❌ Erro não retentável ao comprar contrato: ${errorMessage}`, error?.stack);
                    throw new Error(errorMessage);
                }
            }
        }

        // ✅ Se chegou aqui, todas as tentativas falharam
        const finalError = lastError?.message || 'Falha desconhecida no sistema de compra';
        this.logger.error(`[Zeus][${userId}] ❌ Falha ao comprar contrato após ${maxRetries + 1} tentativas: ${finalError}`);
        throw new Error(finalError);
    }

    /**
     * ✅ LOGIC HELPER: Atualizar estado do Stop Blindado (V4 Cycle Based)
     */
    private updateBlindado(userId: string, state: ZeusUserState, config: ZeusUserConfig): void {
        if (!config.enableStopLossBlindado) return;

        // V4: Baseado no lucro do CICLO
        const currentCycleProfit = state.cycleProfit;
        const triggerValue = state.cycleTarget * 0.4; // ✅ V4 spec: Ativa com 40% da meta do ciclo

        if (!state.blindadoActive) {
            if (currentCycleProfit >= triggerValue) {
                state.blindadoActive = true;
                // ✅ Fix V4 spec: Lock 50% of the Cycle Target as minimum floor
                state.blindadoFloorProfit = state.cycleTarget * 0.5;
                this.saveLog(userId, 'INFO', 'RISK',
                    `🛡️ BLINDADO ATIVADO (Ciclo ${state.cycleCurrent}) | Profit: ${currentCycleProfit.toFixed(2)} | Piso Protegido (50% Meta): ${state.blindadoFloorProfit.toFixed(2)}`);
            }
        } else {
            // Trailing Stop logic: Se o lucro do pico subir significativamente, podemos subir o floor?
            // A spec diz "Cadeado" e "Sair se começar a devolver". 
            // Vamos manter o floor em 50% do target ou seguir o pico se o pico for muito alto.
            const potentialNewFloor = state.cyclePeakProfit * 0.5; // 50% do pico atual
            if (potentialNewFloor > state.blindadoFloorProfit) {
                state.blindadoFloorProfit = potentialNewFloor;
            }
        }
    }

    /**
     * ✅ LOGIC HELPER: Atualizar Estado do Ciclo (V4)
     */
    private async updateCycleState(userId: string, state: ZeusUserState, config: ZeusUserConfig): Promise<void> {
        // 0. META GLOBAL: Checar se o lucro total já atingiu a meta diária
        // Fazemos isso antes de qualquer lógica de ciclo para encerrar imediatamente.
        const currentProfitTotal = Math.round(state.profit * 100) / 100;
        if (currentProfitTotal >= config.profitTarget) {
            this.saveLog(userId, 'SUCCESS', 'SESSION', `🏆 META DE LUCRO ATINGIDA ($${state.profit.toFixed(2)}). Encerrando Sessão.`);
            state.sessionEnded = true;
            state.endReason = 'TARGET';
            this.handleStopCondition(userId, 'TAKE_PROFIT');
            return;
        }

        // 1. SAFEGUARD GLOBAL: Checar Stop Loss GLOBAL antes de qualquer lógica de ciclo
        // Se bateu o Stop Loss Global, a sessão morre aqui, independente de ciclo.
        // Fix: Usar Math.round para evitar erro de float (ex: -19.999999 <= -20)
        const currentProfitRounded = Math.round(state.profit * 100) / 100;
        if (currentProfitRounded <= -config.stopLoss) {
            this.saveLog(userId, 'ERROR', 'RISK', `🛑 STOP LOSS GLOBAL ATINGIDO ($${state.profit.toFixed(2)}). Encerrando Sessão.`);
            state.sessionEnded = true;
            state.endReason = 'STOPLOSS';
            this.handleStopCondition(userId, 'STOP_LOSS');
            return;
        }

        // Atualizar picos do ciclo
        if (state.cycleProfit > state.cyclePeakProfit) {
            state.cyclePeakProfit = state.cycleProfit;
        }

        // Checar conclusão do ciclo (Meta do Ciclo atingida)
        const currentCycleProfitRounded = Math.round(state.cycleProfit * 100) / 100;
        if (currentCycleProfitRounded >= state.cycleTarget) { // 25% da meta diária
            this.saveLog(userId, 'SUCCESS', 'CYCLE',
                `🔄 CICLO ${state.cycleCurrent} CONCLUÍDO | Lucro Ciclo: ${state.cycleProfit.toFixed(2)}`);

            if (state.cycleCurrent < ZEUS_CONSTANTS.cycles) {
                state.cycleCurrent++;
                // RESETAR métricas do ciclo (V4 Spec: "Ao virar ciclo, reseta ops e lucro do ciclo")
                state.cycleProfit = 0;
                state.cycleOps = 0;
                state.cyclePeakProfit = 0;
                state.blindadoActive = false; // Reset blindado for new cycle
                state.blindadoFloorProfit = 0;

                // Pausa estratégica entre ciclos (V4 Checklist: 30 minutos)
                state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + 30 * 60 * 1000);
                this.saveLog(userId, 'INFO', 'CYCLE', `⏳ Pausa de transição de ciclo (30 minutos)...`);

            } else {
                // Ciclo 4 concluído = Meta Diária
                this.saveLog(userId, 'SUCCESS', 'SESSION', `🏆 SESSÃO FINALIZADA (4 CICLOS COMPLETOS)`);
                state.sessionEnded = true;
                state.endReason = 'TARGET';
                this.handleStopCondition(userId, 'TAKE_PROFIT');
            }
            return; // Cycle transition processed
        }

        // meta do ciclo check ends here...

        // 2. GATILHO: Exaustão (Limite de Operações do Ciclo)
        const limitCycle = config.limitOpsCycle || 500;
        if (state.cycleOps >= limitCycle) {
            this.saveLog(userId, 'WARN', 'CYCLE',
                `⌛ EXAUSTÃO DO CICLO ${state.cycleCurrent} | Entradas: ${state.cycleOps}/${limitCycle}`);

            if (state.cycleCurrent < ZEUS_CONSTANTS.cycles) {
                state.cycleCurrent++;
                // RESET SELETIVO (Ops e Lucro)
                state.cycleProfit = 0;
                state.cycleOps = 0;
                state.cyclePeakProfit = 0;
                state.blindadoActive = false;
                state.blindadoFloorProfit = 0;

                // Pausa longa de exaustão (V4 Checklist: 1 hora)
                state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + 60 * 60 * 1000);
                this.saveLog(userId, 'INFO', 'CYCLE', `⏳ Avançando após exaustão (Pausa 1 hora)...`);
            } else {
                state.sessionEnded = true;
                this.saveLog(userId, 'INFO', 'SESSION', `🏁 Sessão finalizada (4 ciclos atingidos/exauridos).`);
            }
            return;
        }

        // 3. GATILHO: Risco (Drawdown Máximo do Ciclo)
        const currentCycleLossRounded = Math.round(state.cycleProfit * 100) / 100;
        if (currentCycleLossRounded <= -state.cycleMaxDrawdown) {
            this.saveLog(userId, 'ERROR', 'RISK', `🛑 DRAWDOWN MÁXIMO DO CICLO ${state.cycleCurrent} ATINGIDO ($${state.cycleProfit.toFixed(2)}). Encerrando ciclo.`);

            // ✅ V4 Checklist: Memória de Risco - Se o ciclo foi ruim, o próximo começa em PRECISO
            if (state.mode !== 'PRECISO') {
                state.mode = 'PRECISO';
                state.recoveryLock = true;
                this.saveLog(userId, 'WARN', 'RISK', `⚠️ CICLO NEGATIVO: Ativando MODO PRECISO para o próximo mini-expediente.`);
            }

            if (state.cycleCurrent < ZEUS_CONSTANTS.cycles) {
                state.cycleCurrent++;
                // RESET SELETIVO
                state.cycleProfit = 0;
                state.cycleOps = 0;
                state.cyclePeakProfit = 0;
                state.blindadoActive = false;
                state.blindadoFloorProfit = 0;

                // Pausa de drawdown (V4 Checklist: 1 hora)
                state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + 60 * 60 * 1000);
                this.saveLog(userId, 'INFO', 'CYCLE', `⏳ Pausa de recuperação de risco (1 hora)...`);
            } else {
                state.sessionEnded = true;
                this.saveLog(userId, 'INFO', 'SESSION', `🏁 Sessão finalizada (Todos ciclos concluídos/stopados).`);
            }
        }

        // Atualizar Blindado com os novos valores (chamada pós-update)
        this.updateBlindado(userId, state, config);
    }

    /**
     * Processa resultado de contrato finalizado
     */
    async onContractFinish(
        userId: string,
        result: {
            win: boolean;
            profit: number;
            contractId: string;
            exitPrice?: number;
            stake: number;
            entryPrice?: number;
            entryTick?: number;
            exitTick?: number;
        },
        tradeIdFromCallback?: number,
    ): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state) return;

        // Priorizar tradeId que veio do closure do buyContract
        const tradeId = tradeIdFromCallback || state.currentTradeId;
        state.currentContractId = null;
        if (state.currentTradeId === tradeId) state.currentTradeId = null;

        // Atualizar Financeiro State GLOBAL
        state.profit += result.profit;
        state.balance += result.profit;
        state.lastOpProfit = result.profit;

        if (state.profit > state.peakProfit) state.peakProfit = state.profit;

        // Atualizar Financeiro CICLO
        state.cycleProfit += result.profit;
        state.cycleOps++; // Fix missing ops count increment for cycle
        if (state.cycleProfit > state.cyclePeakProfit) state.cyclePeakProfit = state.cycleProfit;

        if (result.win) {
            state.wins++;
            state.consecutiveLosses = 0;
            state.perdasAcumuladas = 0;
            state.analysis = "PRINCIPAL"; // ✅ Resetar para principal após vitória

            // ✅ Reset Recovery: Voltar para o modo original se estava em modo de segurança
            const originalMode = config.mode || config.operationMode || (config.riskProfile === 'CONSERVADOR' ? 'PRECISO' : 'NORMAL');
            if (state.mode !== originalMode) {
                state.mode = originalMode;
                state.recoveryLock = false; // ✅ V4 RECOVERED
                this.saveLog(userId, 'INFO', 'RISK', `✅ RECUPERADO: Retornando ao modo original (${state.mode}).`);
            }
        } else {
            state.losses++;
            state.consecutiveLosses++;
            state.perdasAcumuladas += Math.abs(result.profit);
            state.analysis = "RECUPERACAO"; // ✅ Marcar como recuperação após perda

            // ✅ V4 Checklist: Ativar MODO PRECISO após 1 PERDA (Modo Recuperação)
            if (state.consecutiveLosses >= 1 && state.mode !== 'PRECISO') {
                state.mode = 'PRECISO';
                state.recoveryLock = true; // ✅ V4 LOCKED
                this.saveLog(userId, 'WARN', 'RISK', `⚠️ PERDA DETECTADA: Ativando MODO PRECISO para maior segurança.`);
            }

            // ✅ V4 Checklist: Pausa por Sequência de Perdas (Graduated)
            // 3 Losses -> 5 min | 4 Losses -> 10 min | 5 Losses -> 20 min
            if (state.consecutiveLosses === 3) {
                const pauseDurationMs = 5 * 60 * 1000; // 5 minutes
                state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + pauseDurationMs);
                this.saveLog(userId, 'WARN', 'RISK', `🛑 PAUSA TÉCNICA (3 Perdas Consecutivas). Pausando por 5 minutos.`);
            } else if (state.consecutiveLosses === 4) {
                const pauseDurationMs = 10 * 60 * 1000; // 10 minutes
                state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + pauseDurationMs);
                this.saveLog(userId, 'WARN', 'RISK', `🛑 PAUSA TÉCNICA (4 Perdas Consecutivas). Pausando por 10 minutos.`);
            } else if (state.consecutiveLosses >= 5) {
                const pauseDurationMs = 20 * 60 * 1000; // 20 minutes
                state.inStrategicPauseUntilTs = Math.max(state.inStrategicPauseUntilTs || 0, Date.now() + pauseDurationMs);
                state.consecutiveLosses = 0; // Reset only after full 5-loss cycle
                this.saveLog(userId, 'WARN', 'RISK', `🛑 PAUSA ESTRATÉGICA (5 Perdas Consecutivas). Pausando por 20 minutos.`);
            }
        }

        // Compatibilidade Infra & V4 Counters
        state.lucroAtual = state.profit;
        state.currentProfit = state.profit;
        state.currentLoss = state.perdasAcumuladas;
        state.opsCount++;
        state.opsTotal++;
        state.operationsCount++;

        // ✅ Log Trade Result (Orion Format with Digits)
        this.logTradeResultV2(userId, {
            status: result.win ? 'WIN' : 'LOSS',
            profit: result.profit,
            stake: result.stake,
            balance: state.balance,
            entryDigit: result.entryTick !== undefined ? this.lastDigitFromPrice(result.entryTick, config.symbol) : undefined,
            exitDigit: result.exitTick !== undefined ? this.lastDigitFromPrice(result.exitTick, config.symbol) : undefined
        });

        // ✅ Atualizar DB (Trade)
        if (tradeId) {
            try {
                await this.updateTradeRecord(tradeId, {
                    status: result.win ? 'WON' : 'LOST',
                    exitPrice: result.exitPrice || 0,
                    profitLoss: result.profit,
                    closedAt: new Date(),
                });
            } catch (error) {
                this.logger.error(`[Zeus][${userId}] ❌ Erro ao atualizar trade ${tradeId} no banco:`, error);
            }
        }

        // ✅ Lógica Core: Check Blindado, Cycles
        await this.updateCycleState(userId, state, config);

        // ✅ Persistir State
        await this.updateUserStateInDb(userId, state);

        // ✅ COOLDOWN PÓS-TRADE (Executado após todas as cálculos e pausas serem definidos)
        state.isWaitingContract = false;
        state.lastOpTs = Date.now();
        state.cooldownUntilTs = Date.now() + (result.win ? config.cooldownWinSeconds : config.cooldownLossSeconds) * 1000;

        // ✅ Verificar Fim de Sessão
        this.canOperate(userId, config, state);
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
     * Trata condições de parada
     */
    private async handleStopCondition(userId: string, reason: string): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state) {
            return;
        }

        let status = 'active';
        let message = '';

        switch (reason) {
            case 'TAKE_PROFIT':
                status = 'stopped_profit';
                message = `META DE LUCRO ATINGIDA! daily_profit=${state.lucroAtual.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)} | cycle=${state.cycleCurrent}. Encerrando operações.`;
                break;
            case 'STOP_LOSS':
                status = 'stopped_loss';
                message = `STOP LOSS ATINGIDO! daily_loss=${Math.abs(Math.min(0, state.lucroAtual)).toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)} | cycle=${state.cycleCurrent}. Encerrando operações.`;
                break;
            case 'BLINDADO':
                status = 'stopped_blindado';
                message = `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${((config.initialBalance || 0) + state.lucroAtual).toFixed(2)} | cycle=${state.cycleCurrent}. Encerrando operações do dia.`;
                break;

        }

        await this.saveLog(userId, 'WARN', 'RISK', message);

        // Desativar agente (apenas em memória para parar hoje)
        // ✅ MANTER NO BANCO COMO ATIVO (is_active = TRUE) para que o scheduler reinicie amanhã
        state.isActive = false;
        await this.dataSource.query(
            `UPDATE autonomous_agent_config SET session_status = ?, is_active = TRUE WHERE user_id = ?`,
            [status, userId],
        );

        this.logger.log(`[Zeus][${userId}] ${message}`);
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

        if (!config || !state) {
            return 0;
        }

        const analysisData = {
            strategy: 'zeus',
            mode: state.mode,
            probability: trade.marketAnalysis.probability,
            signal: trade.marketAnalysis.signal,
            volatility: trade.marketAnalysis.details?.volatility,
            trend: trade.marketAnalysis.details?.trend,
            digitPattern: trade.marketAnalysis.details?.digitPattern,
            timestamp: new Date().toISOString(),
        };

        const analysisReasoning = `Análise Zeus: Probabilidade ${trade.marketAnalysis.probability.toFixed(1)}%, ` +
            `Direção ${trade.marketAnalysis.signal}, ` +
            `Modo ${state.mode}, ` +
            `Volatilidade=${trade.marketAnalysis.details?.volatility ? Number(trade.marketAnalysis.details.volatility).toFixed(4) : 'N/A'}`;

        try {
            const result = await this.dataSource.query(
                `INSERT INTO autonomous_agent_trades (
          user_id, analysis_data, confidence_score, analysis_reasoning,
          contract_type, contract_duration, entry_price, stake_amount,
          martingale_level, payout, symbol, status, strategy, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'zeus', NOW())`,
                [
                    userId,
                    JSON.stringify(analysisData),
                    trade.marketAnalysis.probability,
                    analysisReasoning,
                    trade.contractType,
                    trade.duration,
                    trade.entryPrice,
                    trade.stakeAmount,
                    state.mode === 'NORMAL' ? 'M0' : (state.mode === 'PRECISO' ? 'M1' : 'M2'), // ✅ Fixed lint and mapping
                    trade.payout * 100, // Converter para percentual
                    config.symbol || 'R_100',
                ],

            );

            const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;

            if (!insertId) {
                this.logger.error(`[Zeus][${userId}] ❌ INSERT falhou - Sem ID gerado. Result: ${JSON.stringify(result)}`);
            } else {
                this.logger.log(`[Zeus][${userId}] 💾 Registro de trade criado: ID ${insertId}`);
            }

            return insertId || 0;
        } catch (error: any) {
            this.logger.error(`[Zeus][${userId}] ❌ ERRO CRÍTICO no Banco de Dados (INSERT): ${error.message}`);
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
            this.logger.warn(`[Zeus] ⚠️ Tentativa de atualizar trade ${tradeId} sem campos para atualizar`);
            return;
        }

        updateValues.push(tradeId);

        try {
            this.logger.debug(`[Zeus] 📝 Atualizando trade ${tradeId}: ${updateFields.join(', ')}`);
            await this.dataSource.query(
                `UPDATE autonomous_agent_trades SET ${updateFields.join(', ')} WHERE id = ?`,
                updateValues,
            );
            this.logger.debug(`[Zeus] ✅ Trade ${tradeId} atualizado com sucesso`);
        } catch (error) {
            this.logger.error(`[Zeus] ❌ Erro ao atualizar trade ${tradeId}:`, error);
            throw error; // ✅ Re-throw para que o erro seja visível
        }
    }

    /**
     * Atualiza estado do usuário no banco de dados
     */
    private async updateUserStateInDb(userId: string, state: ZeusUserState): Promise<void> {
        try {
            await this.dataSource.query(
                `UPDATE autonomous_agent_config 
         SET daily_profit = ?, 
             daily_loss = ?,
             total_trades = ?,
             updated_at = NOW()
         WHERE user_id = ? AND agent_type = 'zeus'`,
                [
                    Math.max(0, state.lucroAtual),
                    Math.abs(Math.min(0, state.lucroAtual)),
                    state.opsCount,
                    userId,
                ],
            );
        } catch (error) {
            this.logger.error(`[Zeus] Erro ao atualizar estado no DB:`, error);
        }
    }

    /**
     * Salva log no sistema (via LogQueueService que salva no banco)
     * ✅ Evita duplicação: salva apenas uma vez via LogQueueService
     */
    private async saveLog(userId: string, level: string, module: string, message: string): Promise<void> {
        // ✅ Formatar mensagem sem duplicar prefixo do módulo
        let formattedMessage = message;
        // Remover prefixos duplicados se existirem (ex: [CORE] - mensagem)
        formattedMessage = formattedMessage.replace(/^\[.*?\]\s*-\s*/g, '');

        // ✅ Salvar APENAS via LogQueueService (evita duplicação)
        // O LogQueueService já salva no banco de dados automaticamente
        if (this.logQueueService) {
            // Normalizar módulo para tipo válido
            const validModules: ('CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER')[] =
                ['CORE', 'API', 'ANALYZER', 'DECISION', 'TRADER', 'RISK', 'HUMANIZER'];
            const normalizedModule = validModules.includes(module.toUpperCase() as any)
                ? (module.toUpperCase() as 'CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER')
                : 'CORE';

            this.logQueueService.saveLogAsync({
                userId,
                level: level.toUpperCase() as 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
                module: normalizedModule,
                message: formattedMessage, // Usar mensagem formatada sem duplicar prefixo
                icon: this.getLogIcon(level),
                details: { symbol: this.userConfigs.get(userId)?.symbol || 'R_100' },
                tableName: 'autonomous_agent_logs',
            });
        }

        this.logger.log(`[Zeus][${module}][${userId}] ${formattedMessage}`);
    }

    private getLogIcon(level: string): string {
        switch (level.toUpperCase()) {
            case 'ERROR':
                return '🚫';
            case 'WARN':
                return '⚠️';
            case 'INFO':
                return 'ℹ️';
            case 'DEBUG':
                return '🔍';
            default:
                return 'ℹ️';
        }
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
            consecutiveLosses: state.consecutiveLosses,
        };
    }

    async resetDailySession(userId: string): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (state && config) {
            state.balance = config.initialCapital;
            state.profit = 0;
            state.peakProfit = 0;
            state.cycleCurrent = 1;
            state.cycleProfit = 0;
            state.cyclePeakProfit = 0;
            state.cycleTarget = config.profitTarget * ZEUS_CONSTANTS.cyclePercent;
            state.blindadoActive = false;
            state.blindadoFloorProfit = 0;
            state.recoveryLock = false;
            state.consecutiveLosses = 0;
            state.perdasAcumuladas = 0;
            state.opsTotal = 0;
            state.wins = 0;
            state.losses = 0;
            state.isWaitingContract = false;
            state.sessionEnded = false;
            state.endReason = undefined;
            state.mode = 'NORMAL';
        }
    }


    // ============================================
    // MÉTODOS DE GERENCIAMENTO DE WEBSOCKET (Pool Interno)
    // Copiados da Orion Strategy
    // ============================================

    /**
     * ✅ Obtém ou cria conexão WebSocket reutilizável por token
     * AGORA COM FALLBACK DINÂMICO DE APP ID (111346 -> 1089)
     */
    private async getOrCreateWebSocketConnection(token: string, userId?: string, forceAppId?: string): Promise<{
        ws: WebSocket;
        currency?: string;
        sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
        subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
        removeSubscription: (subId: string) => void;
    }> {
        // Tenta conectar (lógica padrão)
        try {
            return await this._internalConnect(token, userId, forceAppId);
        } catch (error: any) {
            // Se falhar e for erro de Token Inválido E não estivermos já usando o ID 1089
            if (error.message && error.message.includes('InvalidToken') && forceAppId !== '1089') {
                this.logger.warn(`[Zeus][${userId}] ⚠️ Token inválido no App ID padrão. Tentando fallback para App ID 1089...`);
                // Tenta de novo forçando o ID 1089
                return await this._internalConnect(token, userId, '1089');
            }
            throw error;
        }
    }
    /**
     * ✅ Método interno de conexão (com suporte a override de App ID)
     */
    private async _internalConnect(
        token: string,
        userId?: string,
        forceAppId?: string
    ): Promise<{
        ws: WebSocket;
        currency?: string;
        sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
        subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
        removeSubscription: (subId: string) => void;
    }> {
        // ✅ Verificar se já existe conexão para este token
        const existing = this.wsConnections.get(token);
        if (existing) {
            const readyState = existing.ws.readyState;
            const readyStateText = readyState === WebSocket.OPEN ? 'OPEN' :
                readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                    readyState === WebSocket.CLOSING ? 'CLOSING' :
                        readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN';

            this.logger.debug(`[Zeus] 🔍 [${userId || 'SYSTEM'}] Conexão encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);

            if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
                this.logger.debug(`[Zeus] ♻️ [${userId || 'SYSTEM'}] ✅ Reutilizando conexão WebSocket existente`);

                return {
                    ws: existing.ws,
                    sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
                    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
                        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
                    removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
                };
            } else {
                this.logger.warn(`[Zeus] ⚠️ [${userId || 'SYSTEM'}] Conexão existente não está pronta (readyState=${readyStateText}, authorized=${existing.authorized}). Fechando e recriando.`);
                if (existing.keepAliveInterval) {
                    clearInterval(existing.keepAliveInterval);
                }
                existing.ws.close();
                this.wsConnections.delete(token);
            }
        } else {
            this.logger.debug(`[Zeus] 🔍 [${userId || 'SYSTEM'}] Nenhuma conexão existente encontrada para token ${token.substring(0, 8)}`);
        }

        // ✅ Criar nova conexão com App ID dinâmico
        const currentAppId = forceAppId || this.appId;
        this.logger.debug(`[Zeus] 🔌 [${userId || 'SYSTEM'}] Criando nova conexão WebSocket (App ID: ${currentAppId})`);

        // ✅ [FIX] Usar ws.derivws.com para maior compatibilidade
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${currentAppId}`;

        const ws = await new Promise<WebSocket>((resolve, reject) => {
            // ✅ [FIX] Usar Origin header para evitar bloqueios de CORS
            const socket = new WebSocket(endpoint, {
                headers: { Origin: 'https://app.deriv.com' },
            });

            let authResolved = false;
            const connectionTimeout = setTimeout(() => {
                if (!authResolved) {
                    this.logger.error(`[Zeus] ❌ [${userId || 'SYSTEM'}] Timeout na autorização após 20s. Estado: readyState=${socket.readyState}`);
                    socket.close();
                    this.wsConnections.delete(token);
                    reject(new Error('Timeout ao conectar e autorizar WebSocket (20s)'));
                }
            }, 20000);

            // ✅ Listener de mensagens para capturar autorização e outras respostas
            socket.on('message', (data: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // ✅ Ignorar ping/pong
                    if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
                        return;
                    }

                    const conn = this.wsConnections.get(token);
                    if (!conn) {
                        this.logger.warn(`[Zeus] ⚠️ [${userId || 'SYSTEM'}] Mensagem recebida mas conexão não encontrada no pool para token ${token.substring(0, 8)}`);
                        return;
                    }

                    // ✅ Processar autorização (apenas durante inicialização)
                    if (msg.msg_type === 'authorize' && !authResolved) {
                        this.logger.debug(`[Zeus] 🔐 [${userId || 'SYSTEM'}] Processando resposta de autorização...`);
                        authResolved = true;
                        clearTimeout(connectionTimeout);

                        if (msg.error || (msg.authorize && msg.authorize.error)) {
                            const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autorização';
                            this.logger.error(`[Zeus] ❌ [${userId || 'SYSTEM'}] Erro na autorização: ${errorMsg}`);
                            socket.close();
                            this.wsConnections.delete(token);
                            reject(new Error(`Erro na autorização: ${errorMsg}`));
                            return;
                        }

                        conn.authorized = true;
                        conn.currency = msg.authorize?.currency || 'USD'; // ✅ Capturar moeda real da conta
                        this.logger.log(`[Zeus] ✅ [${userId || 'SYSTEM'}] Autorizado com sucesso | LoginID: ${msg.authorize?.loginid || 'N/A'} | Moeda: ${conn.currency}`);

                        // ✅ Iniciar keep-alive
                        conn.keepAliveInterval = setInterval(() => {
                            if (socket.readyState === WebSocket.OPEN) {
                                try {
                                    socket.send(JSON.stringify({ ping: 1 }));
                                    this.logger.debug(`[Zeus][KeepAlive][${token.substring(0, 8)}] Ping enviado`);
                                } catch (error) {
                                    // Ignorar erros
                                }
                            }
                        }, 90000);

                        resolve(socket);
                        return;
                    }

                    // ✅ Processar mensagens de subscription (proposal_open_contract) - PRIORIDADE 1
                    if (msg.proposal_open_contract) {
                        const contractId = msg.proposal_open_contract.contract_id;
                        if (contractId && conn.subscriptions.has(contractId)) {
                            const callback = conn.subscriptions.get(contractId)!;
                            callback(msg);
                            return;
                        }
                    }

                    // ✅ Processar respostas de requisições (ROTEAMENDO POR REQ_ID / PASSTHROUGH) - PRIORIDADE 2
                    const reqId = msg.req_id || (msg.echo_req?.passthrough?.req_id);

                    if (reqId && conn.pendingRequests.has(reqId)) {
                        const pending = conn.pendingRequests.get(reqId);
                        if (pending) {
                            clearTimeout(pending.timeout);
                            conn.pendingRequests.delete(reqId);
                            if (msg.error) {
                                pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                            } else {
                                pending.resolve(msg);
                            }
                            return; // Resolvido
                        }
                    }

                    // ✅ FALLBACK: Processar por tipo se não tiver reqId (Apenas para garantir compatibilidade)
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
                        }
                    }
                } catch (error) {
                    // Continuar processando
                }
            });

            socket.on('open', () => {
                this.logger.log(`[Zeus] ✅ [${userId || 'SYSTEM'}] WebSocket conectado, enviando autorização...`);

                // ✅ Criar entrada no pool
                const conn = {
                    ws: socket,
                    authorized: false,
                    keepAliveInterval: null,
                    requestIdCounter: 0,
                    pendingRequests: new Map(),
                    subscriptions: new Map(),
                };
                this.wsConnections.set(token, conn);

                // ✅ Enviar autorização
                const authPayload = { authorize: token };
                this.logger.debug(`[Zeus] 📤 [${userId || 'SYSTEM'}] Enviando autorização: ${JSON.stringify({ authorize: token.substring(0, 8) + '...' })}`);
                socket.send(JSON.stringify(authPayload));
            });

            socket.on('error', (error) => {
                if (!authResolved) {
                    clearTimeout(connectionTimeout);
                    authResolved = true;
                    this.wsConnections.delete(token);
                    reject(error);
                }
            });

            socket.on('close', () => {
                this.logger.debug(`[Zeus] 🔌 [${userId || 'SYSTEM'}] WebSocket fechado`);
                const conn = this.wsConnections.get(token);
                if (conn) {
                    if (conn.keepAliveInterval) {
                        clearInterval(conn.keepAliveInterval);
                    }
                    // Rejeitar todas as requisições pendentes
                    conn.pendingRequests.forEach(pending => {
                        clearTimeout(pending.timeout);
                        pending.reject(new Error('WebSocket fechado'));
                    });
                    conn.subscriptions.clear();
                }
                this.wsConnections.delete(token);

                if (!authResolved) {
                    clearTimeout(connectionTimeout);
                    authResolved = true;
                    reject(new Error('WebSocket fechado antes da autorização'));
                }
            });
        });

        const conn = this.wsConnections.get(token)!;
        return {
            ws: conn.ws,
            currency: conn.currency, // ✅ Retornar a moeda capturada
            sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
            subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
                this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
            removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
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

            // ✅ Garantir que o req_id vá na requisição para roteamento seguro
            const enrichedPayload = {
                ...payload,
                passthrough: {
                    ...payload.passthrough,
                    req_id: requestId
                }
            };

            conn.ws.send(JSON.stringify(enrichedPayload));
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
                if (msg.proposal_open_contract || msg.error) {
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
                // ✅ Se não for primeira mensagem, já deve estar usando callback original
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
    // ============================================
    // LOGS PADRONIZADOS ZENIX v2.0 (Portado de Orion)
    // ============================================

    // --- CATEGORIA 1: CONFIGURAÇÃO E MONITORAMENTO ---

    private logInitialConfigV2(userId: string, config: {
        agentName: string;
        operationMode: string;
        riskProfile: string;
        profitTarget: number;
        stopLoss: number;
        stopBlindadoEnabled: boolean;
    }) {
        const message = `⚙️ CONFIGURAÇÃO INICIAL\n` +
            `• Agente: ${config.agentName}\n` +
            `• Modo: ${config.operationMode}\n` +
            `• Perfil: ${config.riskProfile}\n` +
            `• Meta Lucro: $${config.profitTarget.toFixed(2)}\n` +
            `• Stop Loss: $${config.stopLoss.toFixed(2)}\n` +
            `• Stop Blindado: ${config.stopBlindadoEnabled ? 'ATIVO 🛡️' : 'INATIVO ❌'}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
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

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
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

    private logAnalysisStarted(userId: string, mode: string, tickCount?: number, reason?: string) {
        const countStr = tickCount ? ` (Ticks: ${tickCount})` : '';
        // ✅ Melhoria Visual: "⏳ AGUARDANDO PADRÃO" em vez de "BLOQUEADA" para não confundir o usuário
        const actionStr = reason ? `⏳ AGUARDANDO PADRÃO: ${reason}` : 'Aguardando padrões...';
        const message = `🧠 ANÁLISE DO MERCADO\n` +
            `• MODO: ${mode}\n` +
            `• STATUS: Monitorando padrões${countStr}\n` +
            `• AÇÃO: ${actionStr}`;

        this.saveLog(userId, 'INFO', 'ANALYZER', message);
    }

    private logBlockedEntry(userId: string, blocked: {
        reason: string;
        details?: string;
    }) {
        // ⏸️ ENTRADA BLOQUEADA (Yellow/WARN)
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
        direction?: 'CALL' | 'PUT' | 'DIGIT';
    }) {
        let message = `🔍 ANÁLISE: MODO ${signal.mode}${signal.isRecovery ? ' (RECUPERAÇÃO)' : ''}\n`;
        signal.filters.forEach((filter, index) => {
            message += `✅ FILTRO ${index + 1}: ${filter}\n`;
        });
        message += `✅ GATILHO: ${signal.trigger}\n`;
        message += `💪 CONFIANÇA TÉCNICA: ${signal.probability}% (Filtros Atendidos)\n`;
        message += `⚠️ Nota: 100% indica que todas as regras de entrada foram cumpridas. O mercado ainda pode variar.`;

        if (signal.direction) {
            message += `📊 ENTRADA: ${signal.contractType} ${signal.direction}`;
        } else {
            message += `📊 ENTRADA: ${signal.contractType}`;
        }

        this.logger.log(`[Zeus][${userId}] SINAL: ${signal.trigger} | ${signal.direction}`);
        this.saveLog(userId, 'INFO', 'DECISION', message);
    }

    // --- CATEGORIA 3: EXECUÇÃO E RESULTADO ---

    private logTradeResultV2(userId: string, result: {
        status: 'WIN' | 'LOSS';
        profit: number;
        stake: number;
        balance: number;
        entryDigit?: number;
        exitDigit?: number;
    }) {
        const profitStr = result.status === 'WIN' ? `+$${result.profit.toFixed(2)}` : `-$${result.stake.toFixed(2)}`;
        const digitsStr = result.entryDigit !== undefined && result.exitDigit !== undefined
            ? `\n• Dígitos: [Entrada: ${result.entryDigit} | Saída: ${result.exitDigit}]`
            : '';

        const message = `🎯 RESULTADO DA ENTRADA\n` +
            `• Status: ${result.status}\n` +
            `• Lucro/Prejuízo: ${profitStr}${digitsStr}\n` +
            `• Saldo Atual: $${result.balance.toFixed(2)}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'EXECUTION', message);
    }

    // --- CATEGORIA 4: RECUPERAÇÃO E RISCO ---

    private logMartingaleLevelV2(userId: string, martingale: {
        level: number;
        lossNumber: number;
        accumulatedLoss: number;
        calculatedStake: number;
        profitPercentage: number;
        maxLevel: number; // ✅ Adicionado em 2.1
        contractType: string;
    }) {
        const message = `📊 NÍVEL DE RECUPERAÇÃO\n` +
            `• Nível Atual: M${martingale.level} (${martingale.lossNumber}ª perda)\n` +
            `• Perdas Acumuladas: $${martingale.accumulatedLoss.toFixed(2)}\n` +
            `• Stake Calculada: $${martingale.calculatedStake.toFixed(2)}\n` +
            `• Objetivo: Recuperar + ${martingale.profitPercentage}%\n` +
            `• Limite Máximo: M${martingale.maxLevel}\n` +
            `• Contrato: ${martingale.contractType}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'WARN', 'RISK', message);
    }

    private logSuccessfulRecoveryV2(userId: string, recovery: {
        recoveredLoss: number;
        additionalProfit: number;
        profitPercentage: number;
        stakeBase: number;
    }) {
        const message = `✅ RECUPERAÇÃO BEM-SUCEDIDA!\n` +
            `• Perdas Recuperadas: $${recovery.recoveredLoss.toFixed(2)}\n` +
            `• Lucro Adicional: $${recovery.additionalProfit.toFixed(2)} (${recovery.profitPercentage}%)\n` +
            `• Ação: Resetando sistema e voltando à entrada principal\n` +
            `• Próxima Operação: Entrada Normal (Stake Base: $${recovery.stakeBase.toFixed(2)})`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'RISK', message);
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

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'WARN', 'RISK', message);
    }

}

/**
 * ⚡ ZEUS V2 CONFIG (New Spec)
 * Mantém compatibilidade com AutonomousAgentConfig para a infra.
 */
export interface ZeusConfig {
    strategyName: "ZEUS";
    subtitle: string;

    // Mercado
    symbol: string; // ex: "1HZ100V"
    is24x7: boolean;

    // Usuário
    initialCapital: number;
    profitTarget: number;
    stopLoss: number;
    baseStake: number;

    // Usuário escolhe só risco
    riskProfile: RiskProfile;

    // Blindado
    enableStopLossBlindado: boolean;
    blindadoTriggerPctOfTarget: number; // 0.40 (40% meta)
    blindadoProtectPctOfPeak: number; // 0.50 (50% do pico)

    // Payouts líquidos (Fixo em 1.26 na V4)
    payoutPrimary: number;
    payoutRecovery: number;

    // Pausa estratégica
    strategicPauseEnabled: boolean;
    strategicPauseSeconds: number; // 300s

    // Cooldown
    cooldownWinSeconds: number;
    cooldownLossSeconds: number;

    // Coleta
    dataCollectionTicks: number; // 4+
}

/**
 * Interface combinada para uso na classe Strategy
 */
interface ZeusUserConfig extends AutonomousAgentConfig, ZeusConfig { }

/**
 * ⚡ ZEUS V2 STATE (New Spec)
 */
export interface ZeusState {
    // sessão
    balance: number;
    profit: number; // Overall profit
    peakProfit: number; // Overall peak

    // Cycles Management (V4)
    cycleCurrent: number; // 1 to 4
    cycleProfit: number;
    cycleTarget: number;
    cycleMaxDrawdown: number; // 60% of cycle target
    cyclePeakProfit: number; // For Blindado intra-cycle? Spec says "Meta Fracionada (4 Ciclos)... Stop Blindado: atinge 40% da meta do ciclo".
    // So Blindado is per cycle.

    blindadoActive: boolean;
    blindadoFloorProfit: number; // Absolute value relative to cycle start? Or session?
    // Spec: "Stop Blindado... Encerra ciclo se lucro cair..." -> Per Cycle.

    inStrategicPauseUntilTs: number;
    sessionEnded: boolean;
    endReason?: "TARGET" | "STOPLOSS" | "BLINDADO";

    // automático
    mode: NegotiationMode; // NORMAL or PRECISO
    analysis: AnalysisType; // PRINCIPAL (Legacy prop name, kept for compatibility)

    // perdas
    consecutiveLosses: number; // For Pause logic (5 losses)

    // martingale
    perdasAcumuladas: number; // V4 Formula: stake = perdasAcumuladas * Factor...

    // controle
    lastOpTs: number;
    cooldownUntilTs: number;

    // métricas
    opsTotal: number;
    wins: number;
    losses: number;

    // System fields (infra)
    isActive: boolean;
    currentContractId: string | null;
    currentTradeId: number | null;
    isWaitingContract: boolean;
    ticksSinceLastAnalysis: number;
    lastDigits: number[];
    lastRejectionReason?: string;
}

// Alias para manter compatibilidade com nome antigo se necessário, mas preferimos usar ZeusState
interface ZeusUserState extends ZeusState, AutonomousAgentState { }

