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
export type RiskProfile = "CONSERVADOR" | "MODERADO" | "AGRESSIVO";
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
    payoutPrimary: 0.56,
    payoutRecovery: 0.85,
    martingaleMaxLevel: 5,
    martingaleMultiplier: 2.0,
    strategicPauseSeconds: 60,
    cooldownWinSeconds: 20,
    cooldownLossSeconds: 40,
    dataCollectionTicks: 7,
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
        this.logger.log('⚡ ZEUS Strategy inicializado');
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
            c.initial_balance, c.deriv_token as config_token, c.currency, c.symbol, c.agent_type,
            u.token_demo, u.token_real, u.deriv_raw,
            s.trade_currency
         FROM autonomous_agent_config c
         JOIN users u ON c.user_id = u.id
         LEFT JOIN user_settings s ON c.user_id = s.user_id
         WHERE c.is_active = TRUE 
           AND c.agent_type = 'Zeus'
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

                // Log para debug da resolução
                if (resolvedToken !== user.config_token) {
                    this.logger.log(`[Zeus][ResolucaoToken] User ${userId}: Token atualizado dinamicamente. Modo=${wantDemo ? 'DEMO' : 'REAL'}.`);
                } else {
                    // Se for igual, ainda assim pode ser que o config_token esteja certo, mas bom logar se estivermos inconsistentes
                    // Mas para não floodar, deixamos quieto se não houve mudança.
                }

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

                    riskProfile: ((user as any).riskProfile as RiskProfile) || 'MODERADO', // Use user.riskProfile if available, otherwise default

                    enableStopLossBlindado: (user as any).stopLossType === 'blindado', // Use user.stopLossType
                    blindadoTriggerPctOfTarget: 0.4,
                    blindadoProtectPctOfPeak: 0.5,

                    payoutPrimary: ZEUS_CONSTANTS.payoutPrimary,
                    payoutRecovery: ZEUS_CONSTANTS.payoutRecovery,

                    martingaleMaxLevel: ZEUS_CONSTANTS.martingaleMaxLevel,
                    martingaleMultiplier: ZEUS_CONSTANTS.martingaleMultiplier,
                    // Default recovery extra profit based on risk (simplified, will be overwritten by activateUser logic if needed)
                    recoveryExtraProfitPct: 0.15,

                    hasContractSwitch: true,
                    strategicPauseEnabled: true,
                    strategicPauseSeconds: ZEUS_CONSTANTS.strategicPauseSeconds,
                    cooldownWinSeconds: ZEUS_CONSTANTS.cooldownWinSeconds,
                    cooldownLossSeconds: ZEUS_CONSTANTS.cooldownLossSeconds,
                    dataCollectionTicks: ZEUS_CONSTANTS.dataCollectionTicks
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

            blindadoActive: false,
            blindadoFloorProfit: 0,

            inStrategicPauseUntilTs: 0,
            sessionEnded: false,

            // Automático
            mode: "NORMAL",
            analysis: "PRINCIPAL",
            contract: "DIGITS_OVER3",

            consecutiveLosses: 0,
            consecutiveLossesOnPrimaryContract: 0,

            mgLevel: 0,
            lossSum: 0,

            recoveryStartBalance: config.initialCapital,
            recoveryLossStreak: 0,
            currentRecoveryLosses: 0,

            sorosPending: false,
            lastWinProfit: 0,
            lastOpProfit: 0,

            lastOpTs: 0,
            cooldownUntilTs: 0,

            opsTotal: 0,
            wins: 0,
            losses: 0,

            currentContractId: null,
            currentTradeId: null,
            isWaitingContract: false,
            ticksSinceLastAnalysis: 0,
            lastDigits: [],

            // Compatibilidade infra
            currentProfit: 0,
            currentLoss: 0,
            operationsCount: 0,
            saldoInicial: config.initialCapital,
            lucroAtual: 0,
            picoLucro: 0,
            stopBlindadoAtivo: false,
            pisoBlindado: 0
        };



        this.userStates.set(userId, state);
        this.ticks.set(userId, []);
    }

    async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
        // Mapear AutonomousAgentConfig (DB) para ZeusConfig (Spec)
        // Valores default do Spec `buildDefaultConfig`
        const risk = (config as any).riskProfile as RiskProfile || 'MODERADO';

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

            martingaleMaxLevel: ZEUS_CONSTANTS.martingaleMaxLevel,
            martingaleMultiplier: ZEUS_CONSTANTS.martingaleMultiplier,
            recoveryExtraProfitPct: risk === 'CONSERVADOR' ? 0 : (risk === 'AGRESSIVO' ? 0.30 : 0.15),

            hasContractSwitch: true,
            strategicPauseEnabled: true,
            strategicPauseSeconds: ZEUS_CONSTANTS.strategicPauseSeconds,
            cooldownWinSeconds: ZEUS_CONSTANTS.cooldownWinSeconds,
            cooldownLossSeconds: ZEUS_CONSTANTS.cooldownLossSeconds,
            dataCollectionTicks: ZEUS_CONSTANTS.dataCollectionTicks
        };


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
        // ✅ Log de debug para verificar se está recebendo ticks (Logar SEMPRE para debug)
        // if (this.userConfigs.size > 0) {
        this.logger.debug(`[Zeus] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);
        // }

        // ✅ Processar para todos os usuários ativos
        for (const [userId, config] of this.userConfigs.entries()) {
            // ✅ Processar se o símbolo coincidir (com suporte a sinônimos de mercado)
            if (this.isSymbolMatch(tickSymbol, config.symbol)) {
                promises.push(this.processTickForUser(userId, tick).catch((error) => {
                    this.logger.error(`[Zeus][${userId}] Erro ao processar tick:`, error);
                }));
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
        if (symbol.includes('R_50') || symbol.includes('1HZ50V')) precision = 4;
        if (symbol.includes('R_75') || symbol.includes('1HZ75V')) precision = 4;
        if (symbol.includes('R_100') || symbol.includes('1HZ100V')) precision = 2;

        const priceStr = price.toFixed(precision);
        return parseInt(priceStr.slice(-1), 10);
    }

    /**
     * ✅ LOGIC HELPER: Filtros Principais (Digits Over 3)
     */
    private passesPrimaryFilters(prices: number[], digits: number[]): { passes: boolean; reason?: string } {
        if (digits.length < 5) return { passes: false, reason: 'Coleta de dígitos insuficiente' };

        // Filtro 1: média dos dígitos > 4.5
        const avgDigit = digits.reduce((a, b) => a + b, 0) / digits.length;
        if (avgDigit <= 4.5) return { passes: false, reason: `Média de dígitos baixa (${avgDigit.toFixed(1)} ≤ 4.5)` };

        // Filtro 2: std dev controlado (Price Action)
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev > 0.5) return { passes: false, reason: `Instabilidade de preço alta (Vol: ${stdDev.toFixed(4)})` };

        return { passes: true };
    }

    /**
     * ✅ LOGIC HELPER: Filtros de Recuperação (Rise/Fall)
     */
    private passesRecoveryFilters(prices: number[], digits: number[]): { passes: boolean; reason?: string } {
        if (prices.length < 10) return { passes: false, reason: 'Aguardando ticks para tendência' };

        // Filtro 1: preço atual > média dos últimos 10 (Trend Following)
        const last10 = prices.slice(-10);
        const avg10 = last10.reduce((a, b) => a + b, 0) / last10.length;
        const currentPrice = prices[prices.length - 1];

        if (currentPrice <= avg10) return { passes: false, reason: 'Tendência de baixa (Preço ≤ Média)' };

        // Filtro 2: não ter muitos dígitos baixos recentes (Evitar tendência de baixa oculta)
        const last5Digits = digits.slice(-5);
        const lowCount = last5Digits.filter((d) => d < 4).length;
        if (lowCount > 2) return { passes: false, reason: 'Ruído de dígitos baixos detectado' };

        return { passes: true };
    }

    /**
     * ✅ LOGIC HELPER: Calcular Stake (Soros / Martingale)
     */
    private computeNextStake(config: ZeusUserConfig, state: ZeusState): number {
        let stake = config.baseStake;

        // Martingale (só na RECUPERAÇÃO)
        if (state.analysis === "RECUPERACAO") {
            stake = config.baseStake * Math.pow(config.martingaleMultiplier, state.mgLevel);
        }

        // Soros N1 (1 nível) - Só no modo PRINCIPAL
        if (state.analysis === "PRINCIPAL" && state.sorosPending) {
            stake = config.baseStake + state.lastWinProfit;
        }

        // Clamp Stop Loss (Não apostar mais do que o restante até o stop)
        const currentDrawdown = Math.abs(Math.min(0, state.profit));
        const remainingStop = Math.max(0, config.stopLoss - currentDrawdown);
        stake = Math.min(stake, remainingStop);

        // Clamp Profit Target (Não apostar muito mais do que precisa para bater a meta)
        // Regra fixa: stake para meta
        const payout = state.analysis === "PRINCIPAL" ? config.payoutPrimary : config.payoutRecovery;
        const remainingProfit = config.profitTarget - state.profit;

        if (remainingProfit > 0) {
            const maxStakeForTarget = remainingProfit / payout;
            // Regra fixa: stake para meta (sem margem, conforme spec)
            stake = Math.min(stake, maxStakeForTarget);
        }

        return Math.max(0.35, Math.round(stake * 100) / 100);
    }

    /**
     * ✅ LOGIC HELPER: Verificar se pode operar
     */
    private canOperate(userId: string, config: ZeusUserConfig, state: ZeusState): boolean {
        const nowTs = Date.now();

        if (state.sessionEnded) return false;
        if (nowTs < state.cooldownUntilTs) return false;
        if (nowTs < state.inStrategicPauseUntilTs) return false;

        // STOPLOSS sessão
        const drawdown = Math.max(0, -state.profit);
        if (drawdown >= config.stopLoss) {
            state.sessionEnded = true;
            state.endReason = "STOPLOSS";
            this.handleStopCondition(userId, 'STOP_LOSS_LIMIT');
            return false;
        }

        // Blindado
        if (config.enableStopLossBlindado && state.blindadoActive) {
            if (state.profit < state.blindadoFloorProfit) {
                state.sessionEnded = true;
                state.endReason = "BLINDADO";
                this.handleStopCondition(userId, 'BLINDADO');
                return false;
            }
        }

        // Meta
        if (state.profit >= config.profitTarget) {
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
            return;
        }

        // Infra: Check Lock
        if (this.processingLocks.get(userId)) return;

        // Infra: History & Digits
        const userTicks = this.ticks.get(userId) || [];
        userTicks.push(tick);
        if (userTicks.length > config.dataCollectionTicks + 50) userTicks.shift();
        this.ticks.set(userId, userTicks);

        const lastDigit = this.lastDigitFromPrice(tick.value, config.symbol);
        state.lastDigits.push(lastDigit);
        if (state.lastDigits.length > 50) state.lastDigits.shift();

        // 1. Coleta de dados e progresso inicial
        const requiredTicks = config.dataCollectionTicks;
        if (userTicks.length < requiredTicks) {
            // Log de progresso a cada 3 ticks
            if (userTicks.length % 3 === 0) {
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
    private analyzeMarket(userId: string, config: ZeusUserConfig, state: ZeusState, pricesObj: Tick[], digits: number[]): MarketAnalysis | null {
        // Converter ticks objects para array de numbers
        const prices = pricesObj.map(t => t.value);
        if (prices.length < config.dataCollectionTicks) return null;

        const WINDOW = config.dataCollectionTicks;
        const wPrices = prices.slice(-WINDOW);
        const wDigits = digits.slice(-WINDOW);

        let filterResult: { passes: boolean; reason?: string } = { passes: false };
        let probability = 0;
        let details: any = {};

        // Lógica Principal vs Recuperação
        if (state.analysis === "PRINCIPAL") {
            filterResult = this.passesPrimaryFilters(wPrices, wDigits);
            probability = filterResult.passes ? 88.5 : 20.0;
            details = {
                contractType: 'DIGITOVER', // M0
                info: 'Análise Principal (Digits Over 3)',
                mode: 'NORMAL'
            };
        } else {
            filterResult = this.passesRecoveryFilters(wPrices, wDigits);
            probability = filterResult.passes ? 95.0 : 30.0; // Recuperação exige alta confiança

            // Direção Rise/Fall
            const priceNow = prices[prices.length - 1];
            // Simples previsão baseada no ultimo tick vs média (implementado no filtro)
            // Se passou no filtro, é porque está subindo (Preço > Média) -> CALL
            // Se quiséssemos PUT, teríamos que adaptar o filtro.
            // O filtro: "currentPrice > avg10" -> Tendência de Alta -> CALL

            details = {
                contractType: 'RISE_FALL',
                direction: 'CALL', // Simplificado para Uptrend following
                info: 'Análise Recuperação (Trend Follow)',
                mode: 'PRECISO'
            };
        }

        if (filterResult.passes) {
            state.lastRejectionReason = undefined;
            return {
                signal: state.analysis === "RECUPERACAO" ? details.direction : 'DIGIT',
                probability,
                payout: state.analysis === "PRINCIPAL" ? config.payoutPrimary : config.payoutRecovery,
                confidence: probability / 100,
                details
            };
        }

        // Armazenar motivo da rejeição para o log de heartbeat
        state.lastRejectionReason = filterResult.reason;

        // Heartbeat para log a cada 10 ticks de análise sem sinal
        state.ticksSinceLastAnalysis = (state.ticksSinceLastAnalysis || 0) + 1;
        if (state.ticksSinceLastAnalysis >= 10) {
            state.ticksSinceLastAnalysis = 0;
            this.logAnalysisStarted(userId, state.mode, prices.length, state.lastRejectionReason);
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

        // 2. Stop Loss Blindado (V2)
        if (config.enableStopLossBlindado) {
            if (state.blindadoActive && state.profit < state.blindadoFloorProfit) {
                return { action: 'STOP', reason: 'BLINDADO' };
            }
        }

        return { action: 'BUY', stake: stake };
    }

    /**
     * ✅ CORE: Executa trade (Zeus V2)
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

        // Dupla checagem de Stop Loss
        const stopLossCheck = await this.checkStopLoss(userId, decision.stake);
        if (stopLossCheck.action === 'STOP') {
            await this.handleStopCondition(userId, stopLossCheck.reason || 'STOP_LOSS');
            return;
        }

        // Stake final (pode ter sido ajustada pelo stop check)
        const finalStake = stopLossCheck.stake || decision.stake || config.baseStake;

        // Determinar tipo de contrato e Barreira
        let contractType: string = decision.contractType || 'CALL';
        let barrier: string | undefined;
        let duration = 1;

        if (contractType === 'RISE_FALL') {
            // Recuperação: Rise/Fall 1 tick
            contractType = decision.reason === 'CALL' ? 'CALL' : (decision.reason === 'PUT' ? 'PUT' : marketAnalysis.signal as 'CALL' | 'PUT'); // V2: Use signal as direction
            if (contractType !== 'CALL' && contractType !== 'PUT') contractType = 'CALL'; // Fallback
            duration = 1;
        } else if (contractType === 'DIGITOVER') {
            // Principal: Digits Over 3
            contractType = 'DIGITOVER';
            barrier = "3";
            duration = 1;
        }

        // ✅ Setar isWaitingContract ANTES de comprar
        state.isWaitingContract = true;

        // Registrar tentativa no log
        await this.saveLog(userId, 'INFO', 'TRADER', `⚡ EXECUTANDO: ${contractType} ${barrier ? `(Over ${barrier})` : ''} | Stake: $${finalStake.toFixed(2)} | Modo: ${state.mode}`);

        // Payout esperado (apenas informativo)
        const payoutRate = state.analysis === "PRINCIPAL" ? config.payoutPrimary : config.payoutRecovery;

        const userTicks = this.ticks.get(userId) || [];
        const currentPrice = userTicks.length > 0
            ? userTicks[userTicks.length - 1].value
            : marketAnalysis.details?.currentPrice || 0;

        try {
            state.currentContractId = "PENDING"; // Marker
            state.lastContractType = contractType;

            const tradeId = await this.createTradeRecord(
                userId,
                {
                    contractType: contractType || 'UNKNOWN',
                    stakeAmount: finalStake,
                    duration: duration,
                    marketAnalysis: marketAnalysis,
                    payout: payoutRate,
                    entryPrice: currentPrice,
                },
            );

            state.currentTradeId = tradeId;

            let lastErrorMsg = 'Falha ao comprar contrato';
            const contractId = await this.buyContract(
                userId,
                config.derivToken,
                contractType,
                config.symbol,
                finalStake,
                duration,
                barrier,
                2,
                tradeId
            ).catch(err => {
                lastErrorMsg = err.message;
                return null;
            });

            if (contractId) {
                state.currentContractId = contractId;
                // Log sucesso vinculo
                this.logger.log(`[Zeus][${userId}] 🎫 Contrato Confirmado: ${contractId}`);

                // Atualizar status trade ativo
                await this.updateTradeRecord(tradeId, {
                    contractId: contractId,
                    status: 'ACTIVE',
                });
            } else {
                state.isWaitingContract = false;
                state.currentContractId = null;
                await this.updateTradeRecord(tradeId, {
                    status: 'ERROR',
                    errorMessage: lastErrorMsg,
                });
                await this.saveLog(userId, 'ERROR', 'API', `Erro na Corretora: ${lastErrorMsg}`);
            }
        } catch (error: any) {
            state.isWaitingContract = false;
            this.logger.error(`[Zeus][${userId}] Erro crítico ao executar trade:`, error);
            await this.saveLog(userId, 'ERROR', 'API', `Erro crítico trade: ${error.message}`);
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

        // ✅ CORREÇÃO: Delay inicial de 3000ms antes da primeira tentativa
        // Isso dá tempo para a conexão WebSocket se estabilizar e AUTORIZAR
        await new Promise(resolve => setTimeout(resolve, 3000));

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

                // ✅ Primeiro, obter proposta (usando timeout de 60s como Orion)
                const proposalResponse = await connection.sendRequest(
                    {
                        proposal: 1,
                        amount: roundedStake,
                        basis: 'stake',
                        contract_type: contractType,
                        currency: 'USD',
                        duration: duration,
                        duration_unit: 't',
                        symbol: symbol,
                        barrier: barrier,
                    },
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
                        this.logger.error(`[Zeus][${userId}] ❌ Erro não retentável na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
                        throw new Error(errorMessage);
                    }

                    // ✅ Erros retentáveis: tentar novamente
                    lastError = new Error(errorMessage);
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ⚠️ Erro retentável na proposta (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                        continue;
                    }

                    this.logger.error(`[Zeus][${userId}] ❌ Erro na proposta após ${maxRetries + 1} tentativas: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
                    throw lastError;
                }

                const proposalId = proposalResponse.proposal?.id;
                const proposalPrice = Number(proposalResponse.proposal?.ask_price || 0);

                if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
                    lastError = new Error('Resposta de proposta inválida');
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ⚠️ Proposta inválida (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(proposalResponse)}`);
                        continue;
                    }
                    this.logger.error(`[Zeus][${userId}] ❌ Proposta inválida recebida após ${maxRetries + 1} tentativas: ${JSON.stringify(proposalResponse)}`);
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
                        this.logger.error(`[Zeus][${userId}] ❌ Erro não retentável ao comprar: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
                        throw new Error(errorMessage);
                    }

                    // ✅ Erros retentáveis: tentar novamente (mas precisa obter nova proposta)
                    lastError = new Error(errorMessage);
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ⚠️ Erro retentável ao comprar (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                        continue;
                    }

                    this.logger.error(`[Zeus][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
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
                                    { win, profit, contractId, exitPrice, stake },
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

                // ✅ Se não é retentável ou esgotou tentativas, logar e retornar null
                if (attempt >= maxRetries) {
                    this.logger.error(`[Zeus][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${errorMessage}`, error?.stack);
                } else {
                    this.logger.error(`[Zeus][${userId}] ❌ Erro não retentável ao comprar contrato: ${errorMessage}`, error?.stack);
                }
                return null;
            }
        }

        // ✅ Se chegou aqui, todas as tentativas falharam
        this.logger.error(`[Zeus][${userId}] ❌ Falha ao comprar contrato após ${maxRetries + 1} tentativas: ${lastError?.message || 'Erro desconhecido'}`);
        return null;
    }

    /**
     * ✅ LOGIC HELPER: Atualizar Blindado Stop
     */
    private updateBlindado(userId: string, profit: number): void {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (!config || !state || !config.enableStopLossBlindado) return;

        // 1. Ativação
        if (!state.blindadoActive) {
            const activationThreshold = config.profitTarget * config.blindadoTriggerPctOfTarget;
            if (state.profit >= activationThreshold) {
                state.blindadoActive = true;
                state.blindadoFloorProfit = state.profit * 0.5; // Protege 50% do que tem
                this.saveLog(userId, 'INFO', 'RISK', `🛡️ STOP BLINDADO ATIVADO! Lucro > $${activationThreshold.toFixed(2)}. Piso garantido: $${state.blindadoFloorProfit.toFixed(2)}`);
            }
        } else {
            // 2. Trailing (Subir piso se lucro subir)
            // Se lucro atual for maior que o pico registrado desde ativação?
            // Simplificado: se novo lucro for maior que anterior, subir piso
            // Vamos usar peakProfit
            if (state.profit > state.peakProfit) {
                state.peakProfit = state.profit;
                const newFloor = state.peakProfit * config.blindadoProtectPctOfPeak;
                if (newFloor > state.blindadoFloorProfit) {
                    state.blindadoFloorProfit = newFloor;
                    // Log silent ou debug para não spammar
                    this.logger.debug(`[Zeus][${userId}] 🛡️ Piso Blindado ajustado para $${newFloor.toFixed(2)}`);
                }
            }
        }
    }

    /**
     * ✅ LOGIC HELPER: Atualizar Modo e Nível (Core State Machine)
     */
    private updateMode(userId: string, win: boolean): void {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (!config || !state) return;

        // Resetar ou incrementar contadores
        if (win) {
            state.wins++;
            state.consecutiveLosses = 0; // Reset geral
            state.consecutiveLossesOnPrimaryContract = 0;
            state.lastWinProfit = state.lastOpProfit; // Para Soros

            // SOROS LOGIC (Se Modo Principal)
            if (state.analysis === "PRINCIPAL") {
                // Se estava aplicanso Soros, agora reseta
                if (state.sorosPending) {
                    state.sorosPending = false; // Ganhou o Soros, volta base
                    this.saveLog(userId, 'INFO', 'CORE', `💰 SOROS VITORIOSO! Retornando à stake base.`);
                } else {
                    // Se não estava, ativa para próxima
                    state.sorosPending = true;
                    this.saveLog(userId, 'INFO', 'CORE', `🚀 SOROS ARMADO para próxima entrada.`);
                }
            }

            // RECUPERACAO EXIT LOGIC
            // Fim da recuperação APENAS quando bater o alvo exato: perdas + (perdas * extraPct do perfil)
            if (state.analysis === "RECUPERACAO") {
                const recoveryProfit = state.balance - state.recoveryStartBalance;
                const recoveryTarget = state.lossSum + (state.lossSum * config.recoveryExtraProfitPct);

                // Se atingiu o alvo da recuperação
                if (recoveryProfit >= recoveryTarget) {
                    this.saveLog(userId, 'INFO', 'CORE', `✅ RECUPERAÇÃO CONCLUÍDA! Profit: $${recoveryProfit.toFixed(2)} / Target: $${recoveryTarget.toFixed(2)}`);

                    // Pausa Estratégica universal: após recuperar sequência >= 5 losses
                    if (config.strategicPauseEnabled && state.recoveryLossStreak >= 5) {
                        const pauseSeconds = config.strategicPauseSeconds;
                        state.inStrategicPauseUntilTs = Date.now() + (pauseSeconds * 1000);
                        this.saveLog(userId, 'WARN', 'CORE', `⏸️ PAUSA ESTRATÉGICA ativada por ${pauseSeconds}s (Recuperada sequência de ${state.recoveryLossStreak} perdas).`);
                    }

                    // Reset para Principal
                    state.analysis = "PRINCIPAL";
                    state.mode = "NORMAL";
                    state.mgLevel = 0;
                    state.sorosPending = false;
                    state.lossSum = 0;
                    state.currentRecoveryLosses = 0;
                    state.recoveryStartBalance = state.balance;
                } else {
                    // Ainda não recuperou tudo -> Mantém Recuperação
                    // Se ganhou, talvez resetar o nível do Martingale? 
                    // Specs V2: "active until recovery is complete". Usually Martingale resets on win, 
                    // but here we might need to continue if target not reached.
                    // Standard Martingale resets on win. Spec implies custom logic "Martingale to cover accumulated losses".
                    // Let's reset MG level on win, as stake calculation will re-assess based on remaining loss if we were smart, 
                    // but 'computeNextStake' uses 'mgLevel'.
                    // For now, let's keep MG logic simple (reset level on win) but stay in recovery if target not hit?
                    // NO, usually Martingale creates a profit that covers all losses + target in 1 win.
                    // If we didn't hit target, it means Payout was low or Stake was capped.
                    // Let's reset MG level to 0 but stay in Recovery Mode until target is hit.
                    state.mgLevel = 0;
                    this.saveLog(userId, 'INFO', 'CORE', `🔁 Win na Recuperação ($${recoveryProfit.toFixed(2)}), mas alvo ($${recoveryTarget.toFixed(2)}) não atingido. Mantendo modo PRECISO.`);
                }
            }

        } else {
            // LOSS
            state.losses++;
            state.sorosPending = false; // Perdeu, cancela Soros
            state.consecutiveLosses++;

            if (state.analysis === "PRINCIPAL") {
                state.consecutiveLossesOnPrimaryContract++;

                // TRIGGER: 2 Loss seguidos no Principal -> Vai para Recuperação
                if (config.hasContractSwitch && state.consecutiveLossesOnPrimaryContract >= 2) {
                    state.analysis = "RECUPERACAO";
                    state.mode = "PRECISO"; // Modo Rise/Fall
                    state.mgLevel = 0; // Inicia Martingale Cycle
                    state.recoveryStartBalance = state.balance;
                    state.lossSum = 0; // Reset sum
                    state.recoveryLossStreak = state.consecutiveLosses; // Salva tamanho da sequencia atual para checar pausa depois
                    this.saveLog(userId, 'WARN', 'CORE', `⚠️ 2 LOSS no Principal -> Ativando MODO RECUPERAÇÃO (Rise/Fall).`);
                }
            } else {
                // Estamos em RECUPERACAO e perdemos
                state.lossSum += Math.abs(state.lastOpProfit); // Soma prejuizo (lastOpProfit é negativo)
                state.mgLevel++;
                state.currentRecoveryLosses++;

                if (state.mgLevel > config.martingaleMaxLevel) {
                    // Estourou Martingale -> Aceita preju e volta Principal (Stop Loss Parcial)
                    state.analysis = "PRINCIPAL";
                    state.mode = "NORMAL";
                    state.mgLevel = 0;
                    state.consecutiveLossesOnPrimaryContract = 0;
                    this.saveLog(userId, 'ERROR', 'RISK', `🛑 LIMITE DE MARTINGALE (${config.martingaleMaxLevel}) ATINGIDO. Resetando para modo Principal.`);
                } else {
                    this.saveLog(userId, 'WARN', 'CORE', `📉 Loss na Recuperação. Subindo para Nível ${state.mgLevel} | LossSum: $${state.lossSum.toFixed(2)}`);
                }
            }
        }
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

        if (!config || !state) {
            return;
        }

        // ✅ COOLDOWN PÓS-TRADE
        state.isWaitingContract = false;
        state.lastOpTs = Date.now();
        state.cooldownUntilTs = Date.now() + (result.win ? config.cooldownWinSeconds : config.cooldownLossSeconds) * 1000;

        // Priorizar tradeId que veio do closure do buyContract
        const tradeId = tradeIdFromCallback || state.currentTradeId;
        state.currentContractId = null;
        if (state.currentTradeId === tradeId) state.currentTradeId = null;

        // Atualizar Financeiro State
        state.profit += result.profit;
        state.balance += result.profit;
        state.lastOpProfit = result.profit;

        if (state.profit > state.peakProfit) state.peakProfit = state.profit;

        // Compatibilidade Infra
        state.lucroAtual = state.profit;
        state.opsCount++;

        // ✅ Log Trade Result (Orion Format)
        this.logTradeResultV2(userId, {
            status: result.win ? 'WIN' : 'LOSS',
            profit: result.profit,
            stake: result.stake,
            balance: state.balance
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

        // ✅ Lógica Core: Check Blindado, Modes, etc.
        this.updateBlindado(userId, state.profit);
        this.updateMode(userId, result.win);

        // ✅ Persistir State
        await this.updateUserStateInDb(userId, state);

        // ✅ Verificar Fim de Sessão
        this.canOperate(userId, config, state); // Chama apenas para verificar flags e trigger stop se necessário
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
                message = `META DE LUCRO ATINGIDA! daily_profit=${state.lucroAtual.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)}. Encerrando operações.`;
                break;
            case 'STOP_LOSS':
                status = 'stopped_loss';
                message = `STOP LOSS ATINGIDO! daily_loss=${Math.abs(Math.min(0, state.lucroAtual)).toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}. Encerrando operações.`;
                break;
            case 'BLINDADO':
                status = 'stopped_blindado';
                message = `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${((config.initialBalance || 0) + state.lucroAtual).toFixed(2)}. Encerrando operações do dia.`;
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
            currentProfit: state.lucroAtual,
            currentLoss: Math.abs(Math.min(0, state.lucroAtual)),
            operationsCount: state.opsCount,
            mode: state.mode,
            consecutiveWins: state.consecutiveWins,
            consecutiveLosses: state.consecutiveLosses,
        };
    }

    async resetDailySession(userId: string): Promise<void> {
        const state = this.userStates.get(userId);
        if (state) {
            state.lucroAtual = 0;
            state.picoLucro = 0;
            state.consecutiveLosses = 0;
            state.consecutiveWins = 0;
            state.opsCount = 0;
            state.mode = 'PRECISO';
            state.stopBlindadoAtivo = false;
            state.pisoBlindado = 0;
            state.lastProfit = 0;
            state.sorosActive = false;
            state.sorosCount = 0;
            state.totalLossAccumulated = 0;
            state.consecutiveMainLosses = 0;
            state.isPausedStrategy = false;
            state.pauseUntil = 0;
            state.mode = 'NORMAL'; // ✅ Reset to Initial Mode
        }
    }


    // ============================================
    // MÉTODOS DE GERENCIAMENTO DE WEBSOCKET (Pool Interno)
    // Copiados da Orion Strategy
    // ============================================

    /**
     * ✅ Obtém ou cria conexão WebSocket reutilizável por token
     */
    private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
        ws: WebSocket;
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

        // ✅ Criar nova conexão
        this.logger.debug(`[Zeus] 🔌 [${userId || 'SYSTEM'}] Criando nova conexão WebSocket para token`);
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;

        const ws = await new Promise<WebSocket>((resolve, reject) => {
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
                        this.logger.log(`[Zeus] ✅ [${userId || 'SYSTEM'}] Autorizado com sucesso | LoginID: ${msg.authorize?.loginid || 'N/A'}`);

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
        const actionStr = reason ? `⏸️ ENTRADA BLOQUEADA: ${reason}` : 'Aguardando oportunidade...';
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
    }) {
        const profitStr = result.status === 'WIN' ? `+$${result.profit.toFixed(2)}` : `-$${result.stake.toFixed(2)}`;
        const message = `🎯 RESULTADO DA ENTRADA\n` +
            `• Status: ${result.status}\n` +
            `• Lucro/Prejuízo: ${profitStr}\n` +
            `• Saldo Atual: $${result.balance.toFixed(2)}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'EXECUTION', message);
    }

    private logSorosActivation(userId: string, soros: {
        previousProfit: number;
        stakeBase: number;
        level?: number;
    }) {
        const newStake = soros.stakeBase + soros.previousProfit;
        const level = soros.level || 1;
        const message = `🚀 APLICANDO SOROS NÍVEL ${level}\n` +
            `• Lucro Anterior: $${soros.previousProfit.toFixed(2)}\n` +
            `• Nova Stake: $${newStake.toFixed(2)}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
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
            `• Stake Atual: $${streak.currentStake.toFixed(2)}\n` +
            `• Próxima Vitória: Reset para Stake Base`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'RISK', message);
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
    initialCapital: number; // ex: 100
    profitTarget: number; // ex: 100
    stopLoss: number; // ex: 100
    baseStake: number; // ex: 1.00

    // Usuário escolhe só risco
    riskProfile: RiskProfile;

    // Blindado (opcional)
    enableStopLossBlindado: boolean;
    blindadoTriggerPctOfTarget: number; // 0.40 (40% meta)
    blindadoProtectPctOfPeak: number; // 0.50 (50% do pico)

    // Payouts líquidos
    payoutPrimary: number; // ex: 0.56
    payoutRecovery: number; // ex: 0.85

    // Recuperação
    martingaleMaxLevel: number; // M5
    martingaleMultiplier: number; // 2.0
    recoveryExtraProfitPct: number; // 0 / 0.15 / 0.30

    // Troca de contrato
    hasContractSwitch: boolean;

    // Pausa estratégica
    strategicPauseEnabled: boolean;
    strategicPauseSeconds: number;

    // Cooldown
    cooldownWinSeconds: number;
    cooldownLossSeconds: number;

    // Coleta (para logs)
    dataCollectionTicks: number; // ex: 7
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
    profit: number; // balance - initialCapital
    peakProfit: number;

    blindadoActive: boolean;
    blindadoFloorProfit: number;

    inStrategicPauseUntilTs: number;
    sessionEnded: boolean;
    endReason?: "TARGET" | "STOPLOSS" | "BLINDADO";

    // automático
    mode: NegotiationMode;
    analysis: AnalysisType;
    contract: ContractKind;

    // perdas
    consecutiveLosses: number;
    consecutiveLossesOnPrimaryContract: number;

    // martingale
    mgLevel: number; // 0..M5
    lossSum: number; // soma de perdas na RECUPERAÇÃO

    // recuperação tracking correto
    recoveryStartBalance: number;
    recoveryLossStreak: number; // tamanho da sequência que disparou a recuperação (pra pausa >=5)
    currentRecoveryLosses: number;

    // soros N1
    sorosPending: boolean;
    lastWinProfit: number;
    lastOpProfit: number; // Added for V2 Spec tracking

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
    lastContractType?: string; // Mantido para referência rápida
    ticksSinceLastAnalysis: number; // Mantido para infra
    lastDigits: number[]; // Mantido para coleta
    lastRejectionReason?: string; // ✅ Adicionado para transparência de filtros
}

// Alias para manter compatibilidade com nome antigo se necessário, mas preferimos usar ZeusState
interface ZeusUserState extends ZeusState, AutonomousAgentState { }

