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
 * ÔÜí ZEUS Strategy para Agente Aut├┤nomo - Vers├úo 2.1
 * 
 * CORE: Price Action (Trend + Volatility/Delta)
 * - MODO NORMAL: Janela 7 ticks, 4/6 moves, delta >= 0.5. WR esperado ~76%.
 * - MODO LENTO: Janela 8 ticks, 5/7 moves, delta >= 0.7. WR esperado ~90%.
 * - Gest├úo: Soros N├¡vel 1 no Normal, Smart Martingale no Lento.
 * - Prote├º├úo: Stop Blindado (40% meta ativa, prote├º├úo fixa de 50%).
 */

/**
 * ÔÜí ZEUS Strategy Configuration - Vers├úo 2.2 (Manual T├®cnico)
 */
/**
 * ÔÜí ZEUS Strategy Configuration - Vers├úo 2.3 (Aligned with Doc V4.0)
 */
const ZEUS_V4_CONFIGS = {
    // M0: Entrada Principal (Digit Over 3)
    M0_ENTRADA: {
        name: 'ENTRADA',
        contractType: 'DIGITOVER',
        targetDigit: 3, // > 3 (4,5,6,7,8,9)
        payout: 1.56, // ~56%
        // Spec v4.0 Filters
        filterPatternWindow: 6,
        filterPatternCount: 5, // 5+ <= 3
        filterConsecutiveMin: 2, // 2+ <= 3
        filterMomentumWindow: 10,
        filterMomentumCount: 6, // 60%
        filterVolatilityWindow: 6,
        filterVolatilityMinUnique: 3
    },
    // M1+: Recupera├º├úo (Rise/Fall)
    RECOVERY: {
        name: 'RECUPERACAO',
        contractType: 'RISE_FALL', // Special internal type
        payout: 1.85, // ~85%
        // Recovery logic parameters
        momentumWindow: 3,
        minDelta: 0.1, // Reduced slightly to ensure execution
        duration: 1 // Ô£à Corrected to 1 tick as per doc
    }
};

const ZEUS_V4_RISK_MANAGEMENT = {
    CONSERVADOR: {
        maxRecoveryLevel: 5, // Ô£à Doc: Recupera at├® M5
        profitFactor: 1.01,  // Ô£à User: Recupera perdas + 1%
        useStopBlindado: false
    },
    MODERADO: {
        maxRecoveryLevel: 5, // Ô£à Doc implies recovery capability
        profitFactor: 1.15, // Ô£à User: Recupera + 15%
        useStopBlindado: true
    },
    AGRESSIVO: {
        maxRecoveryLevel: 5, // Ô£à Doc implies recovery capability
        profitFactor: 1.30, // Ô£à User: Recupera + 30%
        useStopBlindado: true
    },
};
@Injectable()
export class ZeusStrategy implements IAutonomousAgentStrategy, OnModuleInit {
    name = 'zeus';
    displayName = 'ÔÜí ZEUS';
    description = 'Agente lend├írio com for├ºa de Zeus e precis├úo cir├║rgica';

    private readonly logger = new Logger(ZeusStrategy.name);
    private readonly userConfigs = new Map<string, ZeusUserConfig>();
    private readonly userStates = new Map<string, ZeusUserState>();
    private readonly ticks = new Map<string, Tick[]>();
    private readonly maxTicks = 200;
    private readonly comissaoPlataforma = 0.03; // 3%
    private readonly processingLocks = new Map<string, boolean>(); // Ô£à Lock para evitar processamento simult├óneo
    private readonly appId: string;

    // Ô£à Pool de conex├Áes WebSocket por token (reutiliza├º├úo - uma conex├úo por token)
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
        this.logger.log('ÔÜí ZEUS Strategy inicializado');
        await this.initialize();
    }

    async initialize(): Promise<void> {
        await this.syncActiveUsersFromDb();
    }

    /**
     * Sincroniza usu├írios ativos do banco de dados
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

                // Ô£à [RESOLU├ç├âO DE TOKEN CENTRALIZADA]
                // Prioridade: 1. Prefer├¬ncia (user_settings) -> 2. Colunas Espec├¡ficas (users) -> 3. Parsing Raw -> 4. Config Antiga
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
                        // Fallback: Tentar extrair token Real (n├úo-VRTC) do JSON raw
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

                // Log para debug da resolu├º├úo
                if (resolvedToken !== user.config_token) {
                    this.logger.log(`[Zeus][ResolucaoToken] User ${userId}: Token atualizado dinamicamente. Modo=${wantDemo ? 'DEMO' : 'REAL'}.`);
                } else {
                    // Se for igual, ainda assim pode ser que o config_token esteja certo, mas bom logar se estivermos inconsistentes
                    // Mas para n├úo floodar, deixamos quieto se n├úo houve mudan├ºa.
                }

                const config: ZeusUserConfig = {
                    userId: userId,
                    initialStake: parseFloat(user.initial_stake),
                    dailyProfitTarget: parseFloat(user.daily_profit_target),
                    dailyLossLimit: parseFloat(user.daily_loss_limit),
                    derivToken: resolvedToken, // Ô£à Usa o token resolvido
                    currency: user.currency,
                    symbol: 'R_100',
                    initialBalance: parseFloat(user.initial_balance) || 0,
                    stopLossType: 'normal',
                    riskProfile: 'MODERADO',
                };


                this.userConfigs.set(userId, config);
                this.initializeUserState(userId, config);
            }

            this.logger.log(`[Zeus] Sincronizados ${activeUsers.length} usu├írios ativos`);
        } catch (error) {
            this.logger.error('[Zeus] Erro ao sincronizar usu├írios:', error);
        }
    }

    /**
     * Inicializa estado do usu├írio
     */
    private initializeUserState(userId: string, config: ZeusUserConfig): void {
        const state: ZeusUserState = {
            userId,
            isActive: true,
            currentProfit: 0,
            currentLoss: 0,
            operationsCount: 0,
            saldoInicial: config.initialBalance || 0,
            lucroAtual: 0,
            picoLucro: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            opsCount: 0,
            mode: 'VELOZ', // Ô£à Initial mode as per doc
            stopBlindadoAtivo: false,
            pisoBlindado: 0,
            lastProfit: 0,
            martingaleLevel: 0,
            sorosLevel: 0,
            totalLosses: 0,
            recoveryAttempts: 0,
            totalLossAccumulated: 0,
            currentContractId: null,
            currentTradeId: null,
            isWaitingContract: false,
            lastContractType: undefined,
            ticksSinceLastAnalysis: 0,
            consecutiveLosingDigits: 0,
            lastDigits: [],
            sorosActive: false,
            sorosCount: 0,
            consecutiveMainLosses: 0, // Ô£à Track main losses for trigger
            isPausedStrategy: false, // Ô£à Strategic Pause state
            pauseUntil: 0,
        };



        this.userStates.set(userId, state);
        this.ticks.set(userId, []);
    }

    async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
        const ZeusConfig: ZeusUserConfig = {
            userId: config.userId,
            initialStake: config.initialStake,
            dailyProfitTarget: config.dailyProfitTarget,
            dailyLossLimit: config.dailyLossLimit,
            derivToken: config.derivToken,
            currency: config.currency,
            symbol: 'R_100',
            initialBalance: config.initialBalance || 0,
            stopLossType: (config as any).stopLossType || 'normal',
            riskProfile: (config as any).riskProfile || 'MODERADO',
        };


        // Ô£à Prote├º├úo contra reset de estado pelo Sync (5min)
        if (this.userConfigs.has(userId)) {
            this.logger.log(`[Zeus][${userId}] ­ƒöä Atualizando configura├º├úo (Usu├írio j├í ativo).`);
            this.userConfigs.set(userId, ZeusConfig);

            // Apenas garantir que est├í ativo (se n├úo estiver pausado por stop)
            const state = this.userStates.get(userId);
            if (state && !state.isActive) {
                state.isActive = true;
            }

            // Ô£à Log de reativa├º├úo com configs atualizadas
            const mode = state?.mode || 'PRECISO';
            this.logInitialConfigV2(userId, {
                agentName: 'Zeus',
                operationMode: mode,
                riskProfile: ZeusConfig.riskProfile || 'MODERADO',
                profitTarget: ZeusConfig.dailyProfitTarget,

                stopLoss: ZeusConfig.dailyLossLimit,
                stopBlindadoEnabled: ZeusConfig.stopLossType === 'blindado'
            });

            this.logSessionStart(userId, {
                date: new Date(),
                initialBalance: ZeusConfig.initialBalance || 0,
                profitTarget: ZeusConfig.dailyProfitTarget,
                stopLoss: ZeusConfig.dailyLossLimit,
                mode: mode,
                agentName: 'Zeus'
            });


            return;
        }

        this.userConfigs.set(userId, ZeusConfig);
        this.initializeUserState(userId, ZeusConfig);

        // Ô£à PR├ë-AQUECER conex├úo WebSocket para evitar erro "Conex├úo n├úo est├í pronta"
        try {
            this.logger.log(`[Zeus][${userId}] ­ƒöî Pr├®-aquecendo conex├úo WebSocket...`);
            await this.warmUpConnection(ZeusConfig.derivToken);
            this.logger.log(`[Zeus][${userId}] Ô£à Conex├úo WebSocket pr├®-aquecida e pronta`);
        } catch (error: any) {
            this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Erro ao pr├®-aquecer conex├úo (continuando mesmo assim):`, error.message);
        }

        // Ô£à Obter modo do estado (inicializado como 'VELOZ')
        const state = this.userStates.get(userId);
        const mode = state?.mode || 'VELOZ';


        // Ô£à Log de ativa├º├úo no padr├úo Orion
        this.logInitialConfigV2(userId, {
            agentName: 'Zeus',
            operationMode: mode,
            riskProfile: ZeusConfig.riskProfile || 'MODERADO',
            profitTarget: ZeusConfig.dailyProfitTarget,
            stopLoss: ZeusConfig.dailyLossLimit,
            stopBlindadoEnabled: ZeusConfig.stopLossType === 'blindado'
        });

        this.logSessionStart(userId, {
            date: new Date(),
            initialBalance: ZeusConfig.initialBalance,
            profitTarget: ZeusConfig.dailyProfitTarget,
            stopLoss: ZeusConfig.dailyLossLimit,
            mode: mode,
            agentName: 'Zeus'
        });

        this.logger.log(`[Zeus] Ô£à Usu├írio ${userId} ativado | Symbol: ${ZeusConfig.symbol} | Total configs: ${this.userConfigs.size}`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.userConfigs.delete(userId);
        this.userStates.delete(userId);
        this.ticks.delete(userId);
        this.logger.log(`[Zeus] Ô£à Usu├írio ${userId} desativado`);
    }

    /**
     * Verifica se um usu├írio est├í ativo
     */
    isUserActive(userId: string): boolean {
        return this.userConfigs.has(userId) && this.userStates.has(userId);
    }

    /**
     * Processa um tick recebido
     */
    async processTick(tick: Tick, symbol?: string): Promise<void> {
        const promises: Promise<void>[] = [];
        const tickSymbol = symbol || 'R_100'; // Ô£à Todos os agentes aut├┤nomos usam R_100

        // Ô£à Log de debug para verificar se est├í recebendo ticks
        // Ô£à Log de debug para verificar se est├í recebendo ticks (Logar SEMPRE para debug)
        // if (this.userConfigs.size > 0) {
        this.logger.debug(`[Zeus] ­ƒôÑ Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);
        // }

        // Ô£à Processar para todos os usu├írios ativos
        for (const [userId, config] of this.userConfigs.entries()) {
            // Processar se o s├¡mbolo do tick coincidir com o configurado para o usu├írio (ex: R_50)
            if (tickSymbol === config.symbol) {
                promises.push(this.processTickForUser(userId, tick).catch((error) => {
                    this.logger.error(`[Zeus][${userId}] Erro ao processar tick:`, error);
                }));
            }
        }

        await Promise.all(promises);
    }

    /**
     * Processa tick para um usu├írio espec├¡fico
     */
    private async processTickForUser(userId: string, tick: Tick): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || !state.isActive) {
            return;
        }

        // Ô£à Verificar lock de processamento (evitar m├║ltiplas an├ílises simult├óneas)
        if (this.processingLocks.get(userId)) {
            return; // J├í est├í processando, ignorar este tick
        }

        // Ô£à ATUALIZAR SEMPRE O HIST├ôRICO (Mesmo se estiver esperando contrato)
        const userTicks = this.ticks.get(userId) || [];
        userTicks.push(tick);
        if (userTicks.length > this.maxTicks) userTicks.shift();
        this.ticks.set(userId, userTicks);

        // Coletar d├¡gito de forma robusta
        const priceStr = tick.value.toFixed(8).replace(/\.?0+$/, '').replace('.', '');
        const lastDigit = parseInt(priceStr[priceStr.length - 1]);
        state.lastDigits.push(lastDigit);
        if (state.lastDigits.length > 30) state.lastDigits.shift();

        // Se est├í aguardando resultado de contrato, paramos aqui (mas hist├│rico j├í foi atualizado)
        if (state.isWaitingContract) {
            return;
        }

        // Ô£à TICK ADVANCE L├ôGICA (S├│ conta para an├ílise se N├âO houver opera├º├úo)
        state.ticksSinceLastAnalysis = (state.ticksSinceLastAnalysis || 0) + 1;

        // Zeus opera em tempo real baseado em ticks, mas para evitar flood,
        // s├│ analisa a cada 3 ticks (similar ao Falcon)
        const requiredSkip = state.mode === 'PRECISO' ? 2 : (state.mode === 'NORMAL' ? 1 : 0); // Veloce is 0 skip? Keeping logic similar

        if (state.ticksSinceLastAnalysis <= requiredSkip) {
            return; // Pular este tick
        }

        // Ô£à Atualizar contador de d├¡gitos perdedores para o modo atual (Focado na Entrada M0)
        // V4.0: Perdedor ├® d├¡gito <= 3 para entrada Over 3.
        const targetDigit = ZEUS_V4_CONFIGS.M0_ENTRADA.targetDigit;
        const isLoser = lastDigit <= targetDigit;

        if (isLoser) {
            state.consecutiveLosingDigits++;
        } else {
            state.consecutiveLosingDigits = 0;
        }

        // Multi-tick delay conclu├¡do, resetar para pr├│ximo ciclo
        state.ticksSinceLastAnalysis = 0;

        // Zeus v4.0 window analysis
        // Usar maior janela necess├íria (Momentum 10 ticks)
        const requiredTicks = ZEUS_V4_CONFIGS.M0_ENTRADA.filterMomentumWindow + 1;

        if (state.lastDigits.length < requiredTicks) {
            if (state.lastDigits.length % 5 === 0) {
                this.logDataCollection(userId, {
                    targetCount: requiredTicks,
                    currentCount: state.lastDigits.length,
                    mode: state.mode
                });
            }
            this.processingLocks.set(userId, false);
            return;
        }

        // Ô£à Log inicial de an├ílise ou heartbeat a cada X ticks
        // Removido log redundante com o resultado do analyzeMarket para evitar flood

        // Ô£à Verificar novamente ANTES de fazer an├ílise
        if (state.isWaitingContract) {
            this.processingLocks.set(userId, false);
            return;
        }


        // Ô£à Setar lock de processamento ANTES de fazer an├ílise
        this.processingLocks.set(userId, true);

        try {
            // Realizar an├ílise de mercado
            const marketAnalysis = await this.analyzeMarket(userId, userTicks);

            // Ô£à Resetar contador de avan├ºo (usando a info do mercado se disponivel, ou apenas resetando)
            // Se analisou, reseta o contador
            state.ticksSinceLastAnalysis = 0;

            // Ô£à Verificar novamente AP├ôS an├ílise (pode ter mudado durante an├ílise)
            if (state.isWaitingContract) {
                this.processingLocks.set(userId, false); // Liberar lock antes de retornar
                return;
            }

            // Ô£à Log de debug da an├ílise
            if (marketAnalysis) {
                const { signal, probability, details } = marketAnalysis;

                this.logger.debug(`[Zeus][${userId}] An├ílise (${state.mode}): prob=${probability.toFixed(1)}%, signal=${signal}`);

                const message = `­ƒôè AN├üLISE ZEUS v3.7\n` +
                    `ÔÇó Padr├úo: ${details?.digitPattern || details?.info || 'Analisando...'}\n` +
                    `ÔÇó Volatilidade: ${details?.volatility ? Number(details.volatility).toFixed(3) : 'Estabilizando...'}\n` +
                    `ÔÇó Status: ${signal ? `SINAL ENCONTRADO ­ƒƒó (${probability}%)` : 'AGUARDANDO PADR├âO ­ƒƒí'}\n` +
                    `ÔÇó Modo: ${state.mode}`;

                this.saveLog(userId, 'INFO', 'ANALYZER', message);
            }


            if (marketAnalysis && marketAnalysis.signal) {
                // Ô£à Verificar novamente ANTES de processar decis├úo (pode ter mudado durante an├ílise)
                if (state.isWaitingContract) {
                    this.processingLocks.set(userId, false); // Liberar lock antes de retornar
                    return;
                }

                // Processar decis├úo de trade
                const decision = await this.processAgent(userId, marketAnalysis);

                // Ô£à Verificar novamente ANTES de executar (pode ter mudado durante processAgent)
                if (state.isWaitingContract) {
                    this.processingLocks.set(userId, false); // Liberar lock antes de retornar
                    return;
                }

                if (decision.action === 'BUY') {
                    await this.executeTrade(userId, decision, marketAnalysis);
                } else if (decision.action === 'STOP') {
                    await this.handleStopCondition(userId, decision.reason || 'UNKNOWN');
                }
            }
        } finally {
            // Ô£à Sempre liberar lock, mesmo em caso de erro ou retorno antecipado
            this.processingLocks.set(userId, false);
        }
    }

    /**
     * An├ílise de mercado Zeus v4.0 (4 Filtros + Recupera├º├úo Price Action)
     */
    private async analyzeMarket(userId: string, ticks: Tick[]): Promise<MarketAnalysis | null> {
        const state = this.userStates.get(userId);
        if (!state) return null;

        // Se estiver em recupera├º├úo, mudar logica para Rise/Fall
        const cfg = ZEUS_V4_CONFIGS.M0_ENTRADA;
        const recoveryCfg = ZEUS_V4_CONFIGS.RECOVERY;
        const requiredWindow = Math.max(cfg.filterMomentumWindow, cfg.filterPatternWindow);

        if (state.lastDigits.length < requiredWindow) {
            return null;
        }

        const digits = state.lastDigits; // Full history
        const lastDigitsMomentum = digits.slice(-cfg.filterMomentumWindow);
        const lastDigitsPattern = digits.slice(-cfg.filterPatternWindow);

        // --- PAUSA ESTRAT├ëGICA ---
        if (state.isPausedStrategy) {
            if (Date.now() < (state.pauseUntil || 0)) {
                return this.generateHeartbeat({
                    filters: { pattern: 0, reqPattern: 0, momentum: 0, reqMomentum: 0, volatility: 0, reqVolatility: 0 },
                    window: digits,
                    info: 'ÔÅ©´©Å PAUSA ESTRAT├ëGICA (Aguardando Estabiliza├º├úo)'
                });
            } else {
                // Sair da pausa
                state.isPausedStrategy = false;
                this.saveLog(userId, 'INFO', 'CORE', 'ÔûÂ´©Å Fim da Pausa Estrat├®gica. Retornando opera├º├Áes.');
            }
        }

        // --- MODO RECUPERA├ç├âO (M1+ e Gatilho de 2 perdas principais) ---
        // V4 Spec: "Ap├│s 2 perdas consecutivas no contrato principal, ocorre troca para recupera├º├úo"

        const shouldUseRecovery = state.martingaleLevel > 0 || state.consecutiveMainLosses >= 2;

        if (shouldUseRecovery) {
            // L├│gica Rise/Fall (Price Action simplificado)
            // Analisa momentum dos ├║ltimos N ticks para decidir CALL ou PUT
            const momentumWindow = recoveryCfg.momentumWindow;
            const recentTicks = ticks.slice(-momentumWindow - 1);

            if (recentTicks.length < momentumWindow + 1) return null;

            // Calcular Delta Total
            const startPrice = recentTicks[0].value;
            const endPrice = recentTicks[recentTicks.length - 1].value;
            const delta = Math.abs(endPrice - startPrice);

            if (delta < recoveryCfg.minDelta) {
                // Mercado lateralizado/sem for├ºa
                return null;
            }

            const direction = endPrice > startPrice ? 'CALL' : 'PUT';

            return {
                signal: direction, // Ô£à Fixed: Using valid 'CALL' | 'PUT' type
                probability: 95, // Alta probabilidade assumida em Price Action forte
                payout: recoveryCfg.payout,
                confidence: 0.95,
                details: {
                    contractType: 'RISE_FALL', // Internal mapping
                    direction: direction,
                    volatility: delta,
                    info: `Recupera├º├úo Price Action: Delta ${delta.toFixed(3)} | ${direction}`
                }
            };
        }

        // --- MODO NORMAL (M0 - DIGIT OVER 3) ---
        // FILTRO 1: PADR├âO (5+ d├¡gitos <= 3 nos ├║ltimos 6)
        const patternCount = this.countDigitsLeq(lastDigitsPattern, cfg.targetDigit);
        if (patternCount < cfg.filterPatternCount) {
            return this.generateHeartbeat({
                filters: {
                    pattern: patternCount, reqPattern: cfg.filterPatternCount,
                    momentum: 0, reqMomentum: 0,
                    volatility: 0, reqVolatility: 0
                },
                window: digits
            });
        }

        // FILTRO 2: CONSECUTIVOS (2+ d├¡gitos <= 3 consecutivos no final)
        const last2 = digits.slice(-2);
        const consecutiveCount = this.countDigitsLeq(last2, cfg.targetDigit);
        if (consecutiveCount < cfg.filterConsecutiveMin) {
            return this.generateHeartbeat({
                filters: {
                    pattern: patternCount, reqPattern: cfg.filterPatternCount,
                    momentum: 0, reqMomentum: 0,
                    volatility: 0, reqVolatility: 0
                },
                window: digits
            });
        }

        // FILTRO 3: MOMENTUM (60%+ dos ├║ltimos 10 s├úo <= 3)
        const momentumCount = this.countDigitsLeq(lastDigitsMomentum, cfg.targetDigit);
        if (momentumCount < cfg.filterMomentumCount) {
            return this.generateHeartbeat({
                filters: {
                    pattern: patternCount, reqPattern: cfg.filterPatternCount,
                    momentum: momentumCount, reqMomentum: cfg.filterMomentumCount,
                    volatility: 0, reqVolatility: 0
                },
                window: digits
            });
        }

        // FILTRO 4: VOLATILIDADE (3+ d├¡gitos ├║nicos nos ├║ltimos 6)
        const uniqueCount = this.calculateUniqueDigits(lastDigitsPattern);
        if (uniqueCount < cfg.filterVolatilityMinUnique) {
            return this.generateHeartbeat({
                filters: {
                    pattern: patternCount, reqPattern: cfg.filterPatternCount,
                    momentum: momentumCount, reqMomentum: cfg.filterMomentumCount,
                    volatility: uniqueCount, reqVolatility: cfg.filterVolatilityMinUnique
                },
                window: digits
            });
        }

        // TODOS OS FILTROS PASSARAM!
        return {
            signal: 'DIGIT',
            probability: 100,
            payout: cfg.payout,
            confidence: 1.0,
            details: {
                digitPattern: `Pat ${patternCount}/${cfg.filterPatternCount} | Mtm ${momentumCount}/${cfg.filterMomentumCount} | Vol ${uniqueCount}/${cfg.filterVolatilityMinUnique}`,
                volatility: uniqueCount,
                mode: state.mode, // Corrected to use current state mode

                contractType: cfg.contractType,
                targetDigit: cfg.targetDigit,
                symbol: 'R_100'
            }
        };
    }

    private calculateUniqueDigits(window: number[]): number {
        return new Set(window).size;
    }

    private countDigitsLeq(window: number[], target: number): number {
        return window.filter(d => d <= target).length;
    }

    private generateHeartbeat(details: any): MarketAnalysis {
        const prob = 10; // Low probability for heatbeat

        let statusMsg = `Aguardando padr├úo v4.0`;
        if (details.filters) {
            const f = details.filters;
            statusMsg = `Filtros: Pat ${f.pattern}/${f.reqPattern} | Mtm ${f.momentum}/${f.reqMomentum} | Vol ${f.volatility}/${f.reqVolatility}`;
        }

        return {
            signal: null,
            probability: prob,
            payout: 0,
            confidence: prob / 100,
            details: {
                info: details.info || statusMsg,
                mode: 'ZEUS_V4_SCAN',
                lastDigits: details.window ? details.window.slice(-5).join(',') : ''
            }
        };
    }

    private calculateDigitalVolatility(window: number[]): number {
        // Not used in v4.0 directly (replaced by Unique Digits), but kept for legacy compat if needed
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
        const stdDev = Math.sqrt(variance);
        return stdDev / 10;
    }

    private isValidHour(): boolean {
        // Operar 24/7 conforme spec v4.0 (Mercados Sint├®ticos)
        return true;
    }


    // M├®todos antigos removidos (calculateVolatility, calculateEMA, analyzeDigits) pois n├úo s├úo usados na V2.0

    /**
     * Processa agente (chamado via interface)
     */
    async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || !state.isActive) {
            return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
        }

        // Ô£à Verificar se j├í est├í aguardando resultado de contrato
        if (state.isWaitingContract) {
            return { action: 'WAIT', reason: 'WAITING_CONTRACT_RESULT' };
        }

        // A. Verifica├º├Áes de Seguran├ºa (Hard Stops)
        if (state.lucroAtual >= config.dailyProfitTarget) {
            return { action: 'STOP', reason: 'TAKE_PROFIT' };
        }

        // B. Filtro de Precis├úo (v2.2 thresholds simplificados)
        // Ô£à Se a an├ílise retornou 100% de probabilidade, todos os filtros t├®cnicos passaram
        const requiredProb = 90;

        if (marketAnalysis.probability >= requiredProb && marketAnalysis.signal) {
            const stake = this.calculateStake(userId, marketAnalysis.payout);

            if (stake <= 0) {
                return { action: 'WAIT', reason: 'NO_STAKE' };
            }

            const stopLossCheck = await this.checkStopLoss(userId, stake);
            if (stopLossCheck.action === 'STOP') {
                return stopLossCheck;
            }

            const finalStake = stopLossCheck.stake ? stopLossCheck.stake : stake;

            // Log de sinal
            this.logSignalGenerated(userId, {
                mode: state.mode,
                isRecovery: state.mode !== 'PRECISO',
                filters: [marketAnalysis.details?.digitPattern, `Vol: ${marketAnalysis.details?.volatility}`],
                trigger: `Filtros Zeus v3.7 ­ƒøí´©Å (${state.mode})`,
                probability: marketAnalysis.probability,
                contractType: marketAnalysis.details?.contractType,
                direction: marketAnalysis.signal as any
            });

            return {
                action: 'BUY',
                stake: finalStake,
                contractType: marketAnalysis.details?.contractType,
                mode: state.mode,
                reason: 'ZEUS_SIGNAL_CONFIRMED',
            };
        }
        else {
            // Ô£à Log de motivo para n├úo comprar (formato igual ao SENTINEL)
            const missingProb = requiredProb - marketAnalysis.probability;
            const reasonMsg = marketAnalysis.probability < requiredProb
                ? `Score ${marketAnalysis.probability.toFixed(1)}% abaixo do m├¡nimo ${requiredProb}% (faltam ${missingProb.toFixed(1)}%)`
                : 'Sinal indefinido';

            const now = Date.now();
            const lastLogTime = state.lastDeniedLogTime || 0;
            const timeSinceLastLog = now - lastLogTime;
            const lastLogData = state.lastDeniedLogData;

            const probabilityChanged = !lastLogData ||
                Math.abs(lastLogData.probability - marketAnalysis.probability) > 5;
            const directionChanged = !lastLogData ||
                lastLogData.signal !== marketAnalysis.signal;

            const shouldLog = timeSinceLastLog > 30000 || // 30 segundos
                probabilityChanged ||
                directionChanged;

            if (shouldLog) {
                this.logBlockedEntry(userId, {
                    reason: reasonMsg,
                    details: `Score: ${marketAnalysis.probability.toFixed(1)}% | Dir: ${marketAnalysis.signal || 'N/A'}`
                });

                // Ô£à Atualizar estado de ├║ltimo log
                state.lastDeniedLogTime = now;
                state.lastDeniedLogData = {
                    probability: marketAnalysis.probability,
                    signal: marketAnalysis.signal
                };
            }
        }

        return { action: 'WAIT', reason: 'LOW_PROBABILITY' };
    }

    /**
     * Atualiza o modo do agente baseado em vit├│ria/derrota
     */
    private updateMode(userId: string, win: boolean): void {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        if (!state || !config) return;


        if (win) {
            state.consecutiveWins++;
            state.consecutiveLosses = 0;
            state.totalLossAccumulated = 0; // Resetar perdas acumuladas ao vencer
            state.consecutiveMainLosses = 0; // Ô£à Reset main losses

            // Ô£à Reset P├│s-Recupera├º├úo: Retorna ao modo inicial (VELOZ) se estava em recupera├º├úo
            if (state.martingaleLevel > 0) {
                this.logger.log(`[Zeus][${userId}] ­ƒöä Reset P├│s-Recupera├º├úo: ${state.mode} -> VELOZ`);
                state.mode = 'VELOZ';
            }

            state.martingaleLevel = 0;
            state.sorosLevel = 0; // Reset Soros when returning from recovery or finishing cycle

            // L├│gica de Soros N├¡vel 1 (Apenas no modo Normal M0 - Entrada, e se n├úo estava em recupera├º├úo)
            if (state.martingaleLevel === 0 && config.riskProfile !== 'CONSERVADOR') { // Conservador is flat bet usually? check doc. Doc says Soros Level 1 for all.
                if (state.sorosLevel === 0) {
                    // Win 1 -> Ativar Soros para a pr├│xima
                    state.sorosLevel = 1;
                    this.logger.log(`[Zeus][${userId}] Ô£à WIN (M0) -> Ativando SOROS N├ìVEL 1 para pr├│xima entrada`);
                } else {
                    // Win 2 (Soros) -> Cycle Complete, Reset
                    state.sorosLevel = 0;
                    this.logger.log(`[Zeus][${userId}] Ô£à WIN (SOROS) -> Ciclo completado! Retornando a stake inicial.`);
                }
            } else {
                state.sorosLevel = 0;
            }

            if (state.lastContractType?.includes('RISE_FALL') || state.lastContractType === 'CALL' || state.lastContractType === 'PUT') {
                // Log de fim de recupera├º├úo
            }

        } else {
            state.consecutiveWins = 0;
            state.consecutiveLosses++;

            // Se perdeu na Entrada Principal (M0)
            if (state.martingaleLevel === 0) {
                state.consecutiveMainLosses++;

                // Ô£à Regras Universais de Troca de Modo
                // VELOZ -> ap├│s 2 perdas seguidas -> NORMAL
                if (state.mode === 'VELOZ' && state.consecutiveMainLosses >= 2) {
                    this.logger.log(`[Zeus][${userId}] ­ƒö╗ Downgrade de Modo: VELOZ -> NORMAL (2 Losses)`);
                    state.mode = 'NORMAL';
                    // Ô£à N├úo resetar perdas aqui para permitir que a l├│gica de recupera├º├úo (M1) seja ativada logo em seguida
                }
                // NORMAL -> ap├│s 4 perdas seguidas -> PRECISO
                else if (state.mode === 'NORMAL' && state.consecutiveMainLosses >= 4) {
                    this.logger.log(`[Zeus][${userId}] ­ƒö╗ Downgrade de Modo: NORMAL -> PRECISO (4 Losses)`);
                    state.mode = 'PRECISO';
                    state.consecutiveMainLosses = 0;
                }
            }

            // Resetar Soros em caso de Loss
            state.sorosLevel = 0;

            // Incrementar n├¡vel de recupera├º├úo (Se j├í estamos em recupera├º├úo ou se atingimos o gatilho)
            // O gatilho ├® 2 losses. Ent├úo no segundo loss, a PR├ôXIMA entrada ├® recupera├º├úo.
            // Aqui estamos processando o RESULTADO da entrada anterior.

            // Se eu acabei de perder a segunda (consecutiveMainLosses = 2), a pr├│xima deve ser RECOVERY.
            // Ent├úo eu n├úo aumento martingaleLevel AGORA se ainda estou em M0?
            // "Ap├│s 2 perdas... ocorre troca".
            // Se martingaleLevel=0, e perdi. 
            // Se consecutiveMainLosses >= 2 (acabei de tomar a segunda), ent├úo a proxima an├ílise vai ver isso e disparar Recovery.
            // O martingaleLevel ├® o contador de "n├¡vel da aposta". M0 ├® base. M1 ├® recupera├º├úo 1.
            // Se eu vou entrar em recupera├º├úo, a pr├│xima ├® M1.

            // L├│gica antiga incrementava martingale direto. 
            // V4: "Ap├│s 2 perdas... troca para contrato de recupera├º├úo".
            // Isso significa que continuamos tentando DIGITOVER por 2 vezes.
            // Se fallhar a 2a, vamos para RISE_FALL (M1).

            // Increment logic:
            if (state.martingaleLevel > 0) {
                state.martingaleLevel++;
            } else if (state.consecutiveMainLosses >= 2) {
                // A pr├│xima ser├í a primeira de recupera├º├úo (M1).
                // Mas martingaleLevel controla o calculo de stake.
                // Vou setar martingaleLevel = 1 aqui para indicar que ESTAMOS entrando em recupera├º├úo?
                // Ou deixamos analyzeMarket detectar? 
                // Melhor deixar analyzeMarket usar consecutiveMainLosses para decidir o SINAL.
                // Mas calculateStake usa martingaleLevel.
                // Vamos setar aqui se o gatilho foi atingido.
                state.martingaleLevel = 1;
            }

            if (state.lastProfit < 0) {
                state.totalLossAccumulated += Math.abs(state.lastProfit);
            }

            // check pause condition for Recovery
            // "Ap├│s uma recupera├º├úo igual ou superior a 5 perdas seguidas... PAUSA"
            // Se martingaleLevel chegar a 6 (perdeu M5), ou se count > 5.
            // Assuming maxRecoveryLevel caps the bets.

            const configRisk = ZEUS_V4_RISK_MANAGEMENT[config.riskProfile as keyof typeof ZEUS_V4_RISK_MANAGEMENT] || ZEUS_V4_RISK_MANAGEMENT.MODERADO;

            if (state.martingaleLevel > configRisk.maxRecoveryLevel) {
                this.logger.warn(`[Zeus][${userId}] ­ƒøæ Limite de Recupera├º├úo Atingido (${state.martingaleLevel - 1}/${configRisk.maxRecoveryLevel})`);

                // Ô£à PAUSA ESTRAT├ëGICA
                state.isPausedStrategy = true;
                // Pause for X minutes (e.g. 10 min) or ticks. Doc: "Aguardar estabiliza├º├úo".
                // Vamos usar 5 minutos.
                state.pauseUntil = Date.now() + (5 * 60 * 1000);

                this.logger.warn(`[Zeus][${userId}] ÔÅ©´©Å ESTRAT├ëGIA PAUSADA por 5 minutos.`);
                this.saveLog(userId, 'WARN', 'RISK', `Limite de recupera├º├úo excedido. Estrat├®gia pausada para estabiliza├º├úo (5 min).`);

                // Reset levels logic typically happens here too or after pause?
                // Doc: "O retorno ocorre quando as condi├º├Áes m├¡nimas... atendidas"
                // Reset counters so when we come back we start fresh?
                state.martingaleLevel = 0;
                state.consecutiveMainLosses = 0;
                state.totalLossAccumulated = 0;
                // Mode stays (?) "Reset P├│s-Recupera├º├úo... modo retorna ao inicial".
                // If we failed recovery, complete reset implies going back to base.
                state.mode = 'VELOZ';
            }
        }
    }

    /**
     * Calcula o stake baseado no modo e situa├º├úo
     */
    /**
     * Calcula o stake baseado no modo e situa├º├úo (Zeus v4.0)
     */
    private calculateStake(userId: string, marketPayoutPercent: number): number {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state) return 0;

        // M0: Entrada Normal (Com suporte a Soros N├¡vel 1)
        if (state.martingaleLevel === 0) {
            if (state.sorosLevel === 1) {
                // Soros: Stake Inicial + Lucro da Anterior
                // Lucro da anterior est├í em state.lastProfit (positivo)
                // Se por algum motivo for <=0, fallback para initialStake
                const sorosStake = config.initialStake + (state.lastProfit > 0 ? state.lastProfit : 0);
                this.logger.log(`[Zeus][${userId}] ­ƒÜÇ CALCULANDO SOROS: ${config.initialStake.toFixed(2)} + ${state.lastProfit.toFixed(2)} = ${sorosStake.toFixed(2)}`);
                return Math.round(sorosStake * 100) / 100;
            }
            return config.initialStake;
        }

        // M1+: Recupera├º├úo (Martingale Controlado)
        const riskProfile = config.riskProfile || 'MODERADO';
        // Mapear string para chave (fallback to MODERADO)
        const riskKey = (ZEUS_V4_RISK_MANAGEMENT as any)[riskProfile] ? riskProfile : 'MODERADO';
        const riskSettings = (ZEUS_V4_RISK_MANAGEMENT as any)[riskKey];

        // Verificar limite de n├¡veis (ex: Conservador para no M3)
        // Se maxRecoveryLevel < 0, ├® infinito (ex: Moderado/Agressivo na l├│gica antiga, mas aqui definimos limites na v4 spec se necess├írio, ou -1)
        if (riskSettings.maxRecoveryLevel > 0 && state.martingaleLevel > riskSettings.maxRecoveryLevel) {
            this.logger.warn(`[Zeus][${userId}] ­ƒøæ Limite Recupera├º├úo ${riskProfile} (M${riskSettings.maxRecoveryLevel}) atingido.`);
            this.saveLog(userId, 'WARN', 'RISK', `Limite M${riskSettings.maxRecoveryLevel} atingido. Aceitando perda de $${state.totalLossAccumulated.toFixed(2)}.`);

            // Reset for├ºado
            state.martingaleLevel = 0;
            state.sorosLevel = 0;
            state.totalLossAccumulated = 0;
            state.consecutiveLosses = 0;
            return config.initialStake;
        }

        const lossToRecover = state.totalLossAccumulated;

        // Fator de Lucro na Recupera├º├úo (0% Cons, 25% Mod, 50% Agr) - Sobre o LUCRO ESPERADO ou sobre a PERDA?
        // Spec v4.0: "Recuperar todas as perdas anteriores + um lucro adicional"
        // F├│rmula b├ísica: pr├│xima_aposta = (perdas_totais x fator_lucro) / (payout / 100)
        // Onde "fator_lucro" na tabela ├® 1.0 (Cons), 1.25 (Mod), 1.50 (Agr).

        // O payout de recupera├º├úo ├® o do contrato de recupera├º├úo (Rise/Fall ~85%)
        // Como 'marketPayoutPercent' vem da an├ílise, ele deve ser ~1.85 (para Rise/Fall) ou vindo da config
        const payoutRate = ZEUS_V4_CONFIGS.RECOVERY.payout - 1; // 1.85 - 1 = 0.85 (85%)

        // F├│rmula Spec: next = (loss * factor) / payout%
        // Ex: Loss $1.00, Mod (1.25), Payout 85% -> (1.00 * 1.25) / 0.85 = 1.25 / 0.85 = $1.47

        const nextStake = (lossToRecover * riskSettings.profitFactor) / payoutRate;

        return Math.max(0.35, Math.round(nextStake * 100) / 100);
    }


    /**
     * Verifica Stop Loss (Normal ou Blindado)
     * Unifica a l├│gica de stop loss normal e o stop loss blindado (Catraca do Zeus)
     */
    private async checkStopLoss(userId: string, nextStake?: number): Promise<TradeDecision> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state) {
            return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
        }

        const stake = nextStake || 0;
        const initialBalance = config.initialBalance || 0;

        // 1. Stop Loss Normal

        const currentDrawdown = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;

        // Verifica├º├úo de limite simples (j├í estourou?)
        if (currentDrawdown >= config.dailyLossLimit) {
            return { action: 'STOP', reason: 'STOP_LOSS' };
        }

        // Verifica├º├úo com a pr├│xima stake
        if (currentDrawdown + stake > config.dailyLossLimit) {
            const remaining = config.dailyLossLimit - currentDrawdown;
            // Arredondar para 2 casas e garantir m├¡nimo da Deriv (0.35)
            const adjustedStake = Math.round(remaining * 100) / 100;

            if (adjustedStake < 0.35) {
                this.logger.log(`[Zeus][${userId}] ­ƒøæ STOP LOSS ATINGIDO POR AJUSTE DE ENTRADA!`);
                await this.saveLog(userId, 'WARN', 'RISK', `­ƒøæ STOP LOSS ATINGIDO POR AJUSTE DE ENTRADA!\nÔÇó Motivo: Limite de perda di├íria alcan├ºado.\nÔÇó A├º├úo: Encerrando opera├º├Áes imediatamente.`);
                return { action: 'STOP', reason: 'STOP_LOSS_LIMIT' };
            }

            this.logger.log(`[Zeus][${userId}] Ôøö STAKE AJUSTADA PELO STOP: De ${stake.toFixed(2)} para ${adjustedStake.toFixed(2)}`);
            await this.saveLog(userId, 'WARN', 'RISK',
                `Risco de ultrapassar Stop Loss! perdas=${currentDrawdown.toFixed(2)}, stake=${stake.toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}. Ajustando para ${adjustedStake.toFixed(2)}`);

            return {
                action: 'BUY',
                stake: adjustedStake,
                reason: 'STOP_LOSS_ADJUSTED'
            };
        }

        // 2. Stop Loss Blindado (Efeito Catraca - L├│gica Zeus Preservada)
        // Ô£à Verifica se o tipo de Stop Loss ├® 'blindado' antes de aplicar a l├│gica
        if (config.stopLossType === 'blindado') {
            if (!state.stopBlindadoAtivo) {
                // Ativa├º├úo (40% da Meta)
                if (state.lucroAtual >= config.dailyProfitTarget * 0.40) {
                    state.stopBlindadoAtivo = true;
                    state.picoLucro = state.lucroAtual;
                    state.pisoBlindado = state.picoLucro * 0.50; // Piso ├® 50% do pico

                    this.logger.log(`[Zeus][${userId}] ­ƒöÆ STOP BLINDADO ATIVADO! Piso: ${state.pisoBlindado.toFixed(2)}`);
                    await this.saveLog(userId, 'INFO', 'RISK',
                        `Lucro atual: $${state.lucroAtual.toFixed(2)}. Ativando Stop Loss Blindado em $${state.pisoBlindado.toFixed(2)}.`);
                }
            } else {
                // Atualiza├º├úo Din├ómica (Trailing Stop)
                if (state.lucroAtual > state.picoLucro) {
                    state.picoLucro = state.lucroAtual;
                    state.pisoBlindado = state.picoLucro * 0.50;

                    this.logger.log(`[Zeus][${userId}] ­ƒöÆ BLINDAGEM SUBIU! Novo Piso: ${state.pisoBlindado.toFixed(2)}`);
                }

                // Gatilho de Sa├¡da
                if (state.lucroAtual <= state.pisoBlindado) {
                    this.logger.log(`[Zeus][${userId}] ­ƒøæ STOP BLINDADO ATINGIDO. Encerrando opera├º├Áes.`);

                    await this.saveLog(userId, 'WARN', 'RISK',
                        `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${((config.initialBalance || 0) + state.lucroAtual).toFixed(2)}. Encerrando opera├º├Áes do dia.`);


                    // Ô£à Pausar opera├º├Áes no banco de dados (Status Pausado/Blindado)
                    // Mant├®m is_active = TRUE para permitir reset autom├ítico no dia seguinte
                    state.isActive = false; // Pausa em mem├│ria
                    await this.dataSource.query(
                        `UPDATE autonomous_agent_config SET session_status = 'stopped_blindado', is_active = TRUE WHERE user_id = ?`,
                        [userId],
                    );

                    return { action: 'STOP', reason: 'BLINDADO' };
                }
            }
        }

        // Se passou por todas as verifica├º├Áes, pode comprar
        return {
            action: 'BUY',
            stake: stake,
            reason: 'RiskCheckOK'
        };
    }

    /**
     * Executa trade (Zeus v4.0)
     */
    private async executeTrade(userId: string, decision: TradeDecision, marketAnalysis: MarketAnalysis): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || decision.action !== 'BUY') {
            return;
        }

        if (state.isWaitingContract) {
            this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Tentativa de compra bloqueada: j├í aguardando resultado de contrato anterior`);
            return;
        }

        const stopLossCheck = await this.checkStopLoss(userId, decision.stake);
        if (stopLossCheck.action === 'STOP') {
            return;
        }

        // Determinar tipo de contrato para API
        // Decis├úo j├í deve vir com 'CALL', 'PUT' ou 'DIGITOVER'
        let contractType = decision.contractType;
        let barrier: string | undefined;
        let duration = 1;

        // Se for RECOVERY_SIGNAL do analyzeMarket, details.direction tem CALL/PUT
        if (marketAnalysis.details?.contractType === 'RISE_FALL') {
            contractType = marketAnalysis.details.direction as 'CALL' | 'PUT';
            duration = ZEUS_V4_CONFIGS.RECOVERY.duration; // Ô£à Corrected to V4 config (1 tick)
            barrier = undefined;
        } else if (contractType === 'DIGITOVER') {
            // M0 Entrada Padr├úo
            duration = 1;
            barrier = ZEUS_V4_CONFIGS.M0_ENTRADA.targetDigit.toString();
        } else {
            // Fallback
            contractType = marketAnalysis.signal === 'CALL' ? 'CALL' : 'PUT';
        }

        // Ô£à IMPORTANTE: Setar isWaitingContract ANTES de comprar
        state.isWaitingContract = true;

        // Payout esperado para registro (n├úo enviado para API, apenas hist├│rico)
        const payoutRate = state.martingaleLevel === 0
            ? ZEUS_V4_CONFIGS.M0_ENTRADA.payout - 1
            : ZEUS_V4_CONFIGS.RECOVERY.payout - 1;

        const userTicks = this.ticks.get(userId) || [];
        const currentPrice = userTicks.length > 0
            ? userTicks[userTicks.length - 1].value
            : marketAnalysis.details?.currentPrice || 0;

        try {
            state.lastContractType = contractType;

            const tradeId = await this.createTradeRecord(
                userId,
                {
                    contractType: contractType || 'UNKNOWN',
                    stakeAmount: decision.stake || config.initialStake,
                    duration: duration,
                    marketAnalysis: marketAnalysis,
                    payout: payoutRate,
                    entryPrice: currentPrice,
                },
            );

            let lastErrorMsg = 'Falha ao comprar contrato';
            const contractId = await this.buyContract(
                userId,
                config.derivToken,
                contractType || 'CALL',
                config.symbol,
                decision.stake || config.initialStake,
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
                state.currentTradeId = tradeId;

                this.logger.log(`[Zeus][${userId}] ­ƒÄ½ Trade VINCLULADO: TradeId=${tradeId}, ContractId=${contractId}`);

                await this.saveLog(
                    userId,
                    'INFO',
                    'TRADER',
                    `ÔÜí ENTRADA CONFIRMADA: ${contractType} | Valor: $${(decision.stake || config.initialStake).toFixed(2)} | N├¡vel: M${state.martingaleLevel}`,
                );

                await this.updateTradeRecord(tradeId, {
                    contractId: contractId,
                    status: 'ACTIVE',
                });
            } else {
                state.isWaitingContract = false;
                await this.updateTradeRecord(tradeId, {
                    status: 'ERROR',
                    errorMessage: lastErrorMsg,
                });
                await this.saveLog(userId, 'ERROR', 'API', `Erro na Corretora: ${lastErrorMsg}`);
            }
        } catch (error: any) {
            state.isWaitingContract = false;
            this.logger.error(`[Zeus][${userId}] Erro ao executar trade:`, error);
            await this.saveLog(userId, 'ERROR', 'API', `Erro ao executar trade: ${error.message}`);
        }
    }

    /**
     * Obt├®m payout de um contrato via Deriv API
     */
    private async getPayout(token: string, contractType: string, symbol: string, duration: number): Promise<number> {
        try {
            // Ô£à Obter conex├úo do pool interno
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

            throw new Error('Resposta de proposal inv├ílida');
        } catch (error) {
            this.logger.error(`[Zeus] Erro ao obter payout:`, error);
            // Retornar valores padr├úo em caso de erro
            return 0.95; // 95% para Rise/Fall
        }
    }

    /**
     * Pr├®-aquece conex├úo WebSocket para garantir que esteja pronta
     * Envia um ping simples para for├ºar cria├º├úo e autoriza├º├úo da conex├úo
     */
    async warmUpConnection(token: string): Promise<void> {
        try {
            await this.getOrCreateWebSocketConnection(token, 'warmup');
        } catch (error: any) {
            this.logger.warn(`[Zeus] Falha no warm-up: ${error.message}`);
        }
    }

    /**
     * Compra contrato na Deriv via WebSocket Pool Interno com retry autom├ítico
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
        tradeId: number = 0, // Ô£à Adicionado tradeId
    ): Promise<string | null> {
        const roundedStake = Math.round(stake * 100) / 100;
        let lastError: Error | null = null;

        // Ô£à CORRE├ç├âO: Delay inicial de 3000ms antes da primeira tentativa
        // Isso d├í tempo para a conex├úo WebSocket se estabilizar e AUTORIZAR
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ô£à Retry com backoff exponencial
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    // Ô£à Backoff exponencial: 1s, 2s, 4s...
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    this.logger.warn(`[Zeus][${userId}] ­ƒöä Tentativa ${attempt + 1}/${maxRetries + 1} ap├│s ${delayMs}ms | Erro anterior: ${lastError?.message}`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }

                // Ô£à Obter conex├úo do pool interno
                const connection = await this.getOrCreateWebSocketConnection(token, userId);

                // Ô£à Primeiro, obter proposta (usando timeout de 60s como Orion)
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

                // Ô£à Verificar erros na resposta (pode estar em error ou proposal.error) - igual Orion
                const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
                if (errorObj) {
                    const errorCode = errorObj?.code || '';
                    const errorMessage = errorObj?.message || JSON.stringify(errorObj);

                    // Ô£à Alguns erros n├úo devem ser retentados (ex: saldo insuficiente, par├ómetros inv├ílidos)
                    const nonRetryableErrors = ['InvalidAmount', 'InsufficientBalance', 'InvalidContract', 'InvalidSymbol'];
                    if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
                        this.logger.error(`[Zeus][${userId}] ÔØî Erro n├úo retent├ível na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
                        throw new Error(errorMessage);
                    }

                    // Ô£à Erros retent├íveis: tentar novamente
                    lastError = new Error(errorMessage);
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Erro retent├ível na proposta (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                        continue;
                    }

                    this.logger.error(`[Zeus][${userId}] ÔØî Erro na proposta ap├│s ${maxRetries + 1} tentativas: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
                    throw lastError;
                }

                const proposalId = proposalResponse.proposal?.id;
                const proposalPrice = Number(proposalResponse.proposal?.ask_price || 0);

                if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
                    lastError = new Error('Resposta de proposta inv├ílida');
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Proposta inv├ílida (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(proposalResponse)}`);
                        continue;
                    }
                    this.logger.error(`[Zeus][${userId}] ÔØî Proposta inv├ílida recebida ap├│s ${maxRetries + 1} tentativas: ${JSON.stringify(proposalResponse)}`);
                    throw lastError;
                }

                // Ô£à Enviar compra (usando timeout de 60s como Orion)
                const buyResponse = await connection.sendRequest(
                    {
                        buy: proposalId,
                        price: proposalPrice,
                    },
                    60000, // timeout 60s (igual Orion)
                );

                // Ô£à Verificar erros na resposta - igual Orion
                const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
                if (buyErrorObj) {
                    const errorCode = buyErrorObj?.code || '';
                    const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);

                    // Ô£à Alguns erros n├úo devem ser retentados
                    const nonRetryableErrors = ['InvalidProposal', 'ProposalExpired', 'InsufficientBalance'];
                    if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
                        this.logger.error(`[Zeus][${userId}] ÔØî Erro n├úo retent├ível ao comprar: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
                        throw new Error(errorMessage);
                    }

                    // Ô£à Erros retent├íveis: tentar novamente (mas precisa obter nova proposta)
                    lastError = new Error(errorMessage);
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Erro retent├ível ao comprar (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                        continue;
                    }

                    this.logger.error(`[Zeus][${userId}] ÔØî Erro ao comprar contrato ap├│s ${maxRetries + 1} tentativas: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
                    throw lastError;
                }

                const contractId = buyResponse.buy?.contract_id;
                if (!contractId) {
                    lastError = new Error('Resposta de compra inv├ílida - sem contract_id');
                    if (attempt < maxRetries) {
                        this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Contrato sem contract_id (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(buyResponse)}`);
                        continue;
                    }
                    this.logger.error(`[Zeus][${userId}] ÔØî Contrato criado mas sem contract_id ap├│s ${maxRetries + 1} tentativas: ${JSON.stringify(buyResponse)}`);
                    throw lastError;
                }

                // Ô£à Inscrever para monitorar contrato usando pool interno
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

                            // Ô£à Log de debug para rastrear atualiza├º├Áes do contrato
                            this.logger.debug(`[Zeus][${userId}] ­ƒôè Atualiza├º├úo do contrato ${contractId}: is_sold=${contract.is_sold}, status=${contract.status}, profit=${contract.profit}`);

                            // Ô£à Atualizar entry_price quando dispon├¡vel - USANDO tradeId DO CLOSURE
                            if (contract.entry_spot && tradeId) {
                                this.updateTradeRecord(tradeId, {
                                    entryPrice: Number(contract.entry_spot),
                                }).catch((error) => {
                                    this.logger.error(`[Zeus][${userId}] Erro ao atualizar entry_price:`, error);
                                });
                            }

                            // Ô£à Verificar se contrato foi rejeitado, cancelado ou expirado
                            if (contract.status === 'rejected' || contract.status === 'cancelled' || contract.status === 'expired') {
                                const errorMsg = `Contrato ${contract.status}: ${contract.error_message || 'Sem mensagem de erro'}`;
                                this.logger.error(`[Zeus][${userId}] ÔØî Contrato ${contractId} foi ${contract.status}: ${errorMsg}`);

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

                            // Ô£à Verificar se contrato foi finalizado
                            const isFinalized = contract.is_sold === 1 || contract.is_sold === true ||
                                contract.status === 'won' || contract.status === 'lost' || contract.status === 'sold';

                            if (isFinalized) {
                                const profit = Number(contract.profit || 0);
                                const win = profit > 0;
                                const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);

                                this.logger.log(`[Zeus][${userId}] Ô£à Contrato ${contractId} finalizado: ${win ? 'WIN' : 'LOSS'} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Exit: ${exitPrice}`);

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

                // Ô£à Se chegou aqui, sucesso!
                return contractId;
            } catch (error: any) {
                lastError = error;
                const errorMessage = error?.message || JSON.stringify(error);

                // Ô£à Verificar se ├® erro de timeout ou conex├úo (retent├ível)
                const isRetryableError = errorMessage.includes('Timeout') ||
                    errorMessage.includes('WebSocket') ||
                    errorMessage.includes('Conex├úo') ||
                    errorMessage.includes('not ready') ||
                    errorMessage.includes('not open');

                if (isRetryableError && attempt < maxRetries) {
                    this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å Erro retent├ível (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
                    continue;
                }

                // Ô£à Se n├úo ├® retent├ível ou esgotou tentativas, logar e retornar null
                if (attempt >= maxRetries) {
                    this.logger.error(`[Zeus][${userId}] ÔØî Erro ao comprar contrato ap├│s ${maxRetries + 1} tentativas: ${errorMessage}`, error?.stack);
                } else {
                    this.logger.error(`[Zeus][${userId}] ÔØî Erro n├úo retent├ível ao comprar contrato: ${errorMessage}`, error?.stack);
                }
                return null;
            }
        }

        // Ô£à Se chegou aqui, todas as tentativas falharam
        this.logger.error(`[Zeus][${userId}] ÔØî Falha ao comprar contrato ap├│s ${maxRetries + 1} tentativas: ${lastError?.message || 'Erro desconhecido'}`);
        return null;
    }

    /**
     * Processa resultado de contrato finalizado
     */
    async onContractFinish(
        userId: string,
        result: { win: boolean; profit: number; contractId: string; exitPrice?: number; stake: number },
        tradeIdFromCallback?: number, // Ô£à Adicionado par├ómetro opcional
    ): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state) {
            this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å onContractFinish chamado mas config ou state n├úo encontrado`);
            return;
        }

        // Ô£à COOLDOWN P├ôS-TRADE: Resetar ticksSinceLastAnalysis para um valor negativo
        // Isso obriga o rob├┤ a esperar que o padr├úo antigo seja "limpado" pelo tempo
        state.ticksSinceLastAnalysis = -15; // Esperar 15 ticks (aprox 15-30s) antes de reanalisar
        state.isWaitingContract = false;

        // Priorizar tradeId que veio do closure do buyContract
        const tradeId = tradeIdFromCallback || state.currentTradeId;

        state.currentContractId = null;
        if (state.currentTradeId === tradeId) {
            state.currentTradeId = null;
        }

        this.logger.log(`[Zeus][${userId}] ­ƒôï Processando resultado do contrato ${result.contractId} | TradeId: ${tradeId} | Win: ${result.win} | Profit: ${result.profit}`);

        // Ô£à Atualizar trade no banco com resultado
        if (tradeId) {
            try {
                await this.updateTradeRecord(tradeId, {
                    status: result.win ? 'WON' : 'LOST',
                    exitPrice: result.exitPrice || 0,
                    profitLoss: result.profit,
                    closedAt: new Date(),
                });
                this.logger.log(`[Zeus][${userId}] Ô£à Trade ${tradeId} atualizado no banco de dados`);
            } catch (error) {
                this.logger.error(`[Zeus][${userId}] ÔØî Erro ao atualizar trade ${tradeId} no banco:`, error);
            }
        } else {
            this.logger.warn(`[Zeus][${userId}] ÔÜá´©Å onContractFinish chamado mas tradeId ├® null/undefined`);
        }

        // Atualizar estado
        state.opsCount++;
        state.operationsCount++;
        state.lastProfit = result.profit;
        state.lucroAtual += result.profit;
        state.currentProfit = state.lucroAtual > 0 ? state.lucroAtual : 0;
        state.currentLoss = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;


        // Atualizar modo (PRECISO ou ALTA_PRECISAO)
        this.updateMode(userId, result.win);

        // Ô£à Atualizar banco de dados PRIMEIRO (antes dos logs)
        await this.updateUserStateInDb(userId, state);

        // Ô£à Logs detalhados do resultado (formato igual ├á Orion)
        const status = result.win ? 'WON' : 'LOST';
        const contractType = state.lastContractType || 'CALL'; // Usar ├║ltimo tipo de contrato executado
        const pnl = result.profit >= 0 ? `+$${result.profit.toFixed(2)}` : `-$${Math.abs(result.profit).toFixed(2)}`;

        // Ô£à Log de resultado no padr├úo Orion
        this.logTradeResultV2(userId, {
            status: result.win ? 'WIN' : 'LOSS',
            profit: result.profit,
            stake: result.stake,
            balance: (config.initialBalance || 0) + state.lucroAtual
        });


        // Verificar se atingiu meta ou stop
        if (state.lucroAtual >= config.dailyProfitTarget) {
            await this.handleStopCondition(userId, 'TAKE_PROFIT');
        } else if (state.lucroAtual <= -config.dailyLossLimit) {
            await this.handleStopCondition(userId, 'STOP_LOSS');
        }
    }

    /**
     * Trata condi├º├Áes de parada
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
                message = `META DE LUCRO ATINGIDA! daily_profit=${state.lucroAtual.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)}. Encerrando opera├º├Áes.`;
                break;
            case 'STOP_LOSS':
                status = 'stopped_loss';
                message = `STOP LOSS ATINGIDO! daily_loss=${Math.abs(Math.min(0, state.lucroAtual)).toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}. Encerrando opera├º├Áes.`;
                break;
            case 'BLINDADO':
                status = 'stopped_blindado';
                message = `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${((config.initialBalance || 0) + state.lucroAtual).toFixed(2)}. Encerrando opera├º├Áes do dia.`;
                break;

        }

        await this.saveLog(userId, 'WARN', 'RISK', message);

        // Desativar agente (apenas em mem├│ria para parar hoje)
        // Ô£à MANTER NO BANCO COMO ATIVO (is_active = TRUE) para que o scheduler reinicie amanh├ú
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

        const analysisReasoning = `An├ílise Zeus: Probabilidade ${trade.marketAnalysis.probability.toFixed(1)}%, ` +
            `Dire├º├úo ${trade.marketAnalysis.signal}, ` +
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
                    state.mode === 'VELOZ' ? 'M0' : (state.mode === 'NORMAL' ? 'M1' : 'M2'), // Ô£à Fixed lint and mapping
                    trade.payout * 100, // Converter para percentual
                    config.symbol || 'R_100',
                ],

            );

            const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;

            if (!insertId) {
                this.logger.error(`[Zeus][${userId}] ÔØî INSERT falhou - Sem ID gerado. Result: ${JSON.stringify(result)}`);
            } else {
                this.logger.log(`[Zeus][${userId}] ­ƒÆ¥ Registro de trade criado: ID ${insertId}`);
            }

            return insertId || 0;
        } catch (error: any) {
            this.logger.error(`[Zeus][${userId}] ÔØî ERRO CR├ìTICO no Banco de Dados (INSERT): ${error.message}`);
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
            this.logger.warn(`[Zeus] ÔÜá´©Å Tentativa de atualizar trade ${tradeId} sem campos para atualizar`);
            return;
        }

        updateValues.push(tradeId);

        try {
            this.logger.debug(`[Zeus] ­ƒôØ Atualizando trade ${tradeId}: ${updateFields.join(', ')}`);
            await this.dataSource.query(
                `UPDATE autonomous_agent_trades SET ${updateFields.join(', ')} WHERE id = ?`,
                updateValues,
            );
            this.logger.debug(`[Zeus] Ô£à Trade ${tradeId} atualizado com sucesso`);
        } catch (error) {
            this.logger.error(`[Zeus] ÔØî Erro ao atualizar trade ${tradeId}:`, error);
            throw error; // Ô£à Re-throw para que o erro seja vis├¡vel
        }
    }

    /**
     * Atualiza estado do usu├írio no banco de dados
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
     * Ô£à Evita duplica├º├úo: salva apenas uma vez via LogQueueService
     */
    private async saveLog(userId: string, level: string, module: string, message: string): Promise<void> {
        // Ô£à Formatar mensagem sem duplicar prefixo do m├│dulo
        let formattedMessage = message;
        // Remover prefixos duplicados se existirem (ex: [CORE] - mensagem)
        formattedMessage = formattedMessage.replace(/^\[.*?\]\s*-\s*/g, '');

        // Ô£à Salvar APENAS via LogQueueService (evita duplica├º├úo)
        // O LogQueueService j├í salva no banco de dados automaticamente
        if (this.logQueueService) {
            // Normalizar m├│dulo para tipo v├ílido
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
                return '­ƒÜ½';
            case 'WARN':
                return 'ÔÜá´©Å';
            case 'INFO':
                return 'Ôä╣´©Å';
            case 'DEBUG':
                return '­ƒöì';
            default:
                return 'Ôä╣´©Å';
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
            state.mode = 'VELOZ'; // Ô£à Reset to Initial Mode
        }
    }


    // ============================================
    // M├ëTODOS DE GERENCIAMENTO DE WEBSOCKET (Pool Interno)
    // Copiados da Orion Strategy
    // ============================================

    /**
     * Ô£à Obt├®m ou cria conex├úo WebSocket reutiliz├ível por token
     */
    private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
        ws: WebSocket;
        sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
        subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
        removeSubscription: (subId: string) => void;
    }> {
        // Ô£à Verificar se j├í existe conex├úo para este token
        const existing = this.wsConnections.get(token);
        if (existing) {
            const readyState = existing.ws.readyState;
            const readyStateText = readyState === WebSocket.OPEN ? 'OPEN' :
                readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                    readyState === WebSocket.CLOSING ? 'CLOSING' :
                        readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN';

            this.logger.debug(`[Zeus] ­ƒöì [${userId || 'SYSTEM'}] Conex├úo encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);

            if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
                this.logger.debug(`[Zeus] ÔÖ╗´©Å [${userId || 'SYSTEM'}] Ô£à Reutilizando conex├úo WebSocket existente`);

                return {
                    ws: existing.ws,
                    sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
                    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
                        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
                    removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
                };
            } else {
                this.logger.warn(`[Zeus] ÔÜá´©Å [${userId || 'SYSTEM'}] Conex├úo existente n├úo est├í pronta (readyState=${readyStateText}, authorized=${existing.authorized}). Fechando e recriando.`);
                if (existing.keepAliveInterval) {
                    clearInterval(existing.keepAliveInterval);
                }
                existing.ws.close();
                this.wsConnections.delete(token);
            }
        } else {
            this.logger.debug(`[Zeus] ­ƒöì [${userId || 'SYSTEM'}] Nenhuma conex├úo existente encontrada para token ${token.substring(0, 8)}`);
        }

        // Ô£à Criar nova conex├úo
        this.logger.debug(`[Zeus] ­ƒöî [${userId || 'SYSTEM'}] Criando nova conex├úo WebSocket para token`);
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;

        const ws = await new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(endpoint, {
                headers: { Origin: 'https://app.deriv.com' },
            });

            let authResolved = false;
            const connectionTimeout = setTimeout(() => {
                if (!authResolved) {
                    this.logger.error(`[Zeus] ÔØî [${userId || 'SYSTEM'}] Timeout na autoriza├º├úo ap├│s 20s. Estado: readyState=${socket.readyState}`);
                    socket.close();
                    this.wsConnections.delete(token);
                    reject(new Error('Timeout ao conectar e autorizar WebSocket (20s)'));
                }
            }, 20000);

            // Ô£à Listener de mensagens para capturar autoriza├º├úo e outras respostas
            socket.on('message', (data: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Ô£à Ignorar ping/pong
                    if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
                        return;
                    }

                    const conn = this.wsConnections.get(token);
                    if (!conn) {
                        this.logger.warn(`[Zeus] ÔÜá´©Å [${userId || 'SYSTEM'}] Mensagem recebida mas conex├úo n├úo encontrada no pool para token ${token.substring(0, 8)}`);
                        return;
                    }

                    // Ô£à Processar autoriza├º├úo (apenas durante inicializa├º├úo)
                    if (msg.msg_type === 'authorize' && !authResolved) {
                        this.logger.debug(`[Zeus] ­ƒöÉ [${userId || 'SYSTEM'}] Processando resposta de autoriza├º├úo...`);
                        authResolved = true;
                        clearTimeout(connectionTimeout);

                        if (msg.error || (msg.authorize && msg.authorize.error)) {
                            const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autoriza├º├úo';
                            this.logger.error(`[Zeus] ÔØî [${userId || 'SYSTEM'}] Erro na autoriza├º├úo: ${errorMsg}`);
                            socket.close();
                            this.wsConnections.delete(token);
                            reject(new Error(`Erro na autoriza├º├úo: ${errorMsg}`));
                            return;
                        }

                        conn.authorized = true;
                        this.logger.log(`[Zeus] Ô£à [${userId || 'SYSTEM'}] Autorizado com sucesso | LoginID: ${msg.authorize?.loginid || 'N/A'}`);

                        // Ô£à Iniciar keep-alive
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

                    // Ô£à Processar mensagens de subscription (proposal_open_contract) - PRIORIDADE 1
                    if (msg.proposal_open_contract) {
                        const contractId = msg.proposal_open_contract.contract_id;
                        if (contractId && conn.subscriptions.has(contractId)) {
                            const callback = conn.subscriptions.get(contractId)!;
                            callback(msg);
                            return;
                        }
                    }

                    // Ô£à Processar respostas de requisi├º├Áes (proposal, buy, etc.) - PRIORIDADE 2
                    if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
                        // Processar primeira requisi├º├úo pendente (FIFO)
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
                this.logger.log(`[Zeus] Ô£à [${userId || 'SYSTEM'}] WebSocket conectado, enviando autoriza├º├úo...`);

                // Ô£à Criar entrada no pool
                const conn = {
                    ws: socket,
                    authorized: false,
                    keepAliveInterval: null,
                    requestIdCounter: 0,
                    pendingRequests: new Map(),
                    subscriptions: new Map(),
                };
                this.wsConnections.set(token, conn);

                // Ô£à Enviar autoriza├º├úo
                const authPayload = { authorize: token };
                this.logger.debug(`[Zeus] ­ƒôñ [${userId || 'SYSTEM'}] Enviando autoriza├º├úo: ${JSON.stringify({ authorize: token.substring(0, 8) + '...' })}`);
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
                this.logger.debug(`[Zeus] ­ƒöî [${userId || 'SYSTEM'}] WebSocket fechado`);
                const conn = this.wsConnections.get(token);
                if (conn) {
                    if (conn.keepAliveInterval) {
                        clearInterval(conn.keepAliveInterval);
                    }
                    // Rejeitar todas as requisi├º├Áes pendentes
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
                    reject(new Error('WebSocket fechado antes da autoriza├º├úo'));
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
     * Ô£à Envia requisi├º├úo via conex├úo existente
     */
    private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
        const conn = this.wsConnections.get(token);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
            throw new Error('Conex├úo WebSocket n├úo est├í dispon├¡vel ou autorizada');
        }

        return new Promise((resolve, reject) => {
            const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
            const timeout = setTimeout(() => {
                conn.pendingRequests.delete(requestId);
                reject(new Error(`Timeout ap├│s ${timeoutMs}ms`));
            }, timeoutMs);

            conn.pendingRequests.set(requestId, { resolve, reject, timeout });
            conn.ws.send(JSON.stringify(payload));
        });
    }

    /**
     * Ô£à Inscreve-se para atualiza├º├Áes via conex├úo existente
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
            throw new Error('Conex├úo WebSocket n├úo est├í dispon├¡vel ou autorizada');
        }

        // Ô£à Aguardar primeira resposta para confirmar subscription
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                conn.subscriptions.delete(subId);
                reject(new Error(`Timeout ao inscrever ${subId}`));
            }, timeoutMs);

            // Ô£à Callback wrapper que confirma subscription na primeira mensagem
            const wrappedCallback = (msg: any) => {
                // Ô£à Primeira mensagem confirma subscription
                if (msg.proposal_open_contract || msg.error) {
                    clearTimeout(timeout);
                    if (msg.error) {
                        conn.subscriptions.delete(subId);
                        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                        return;
                    }
                    // Ô£à Subscription confirmada, substituir por callback original
                    conn.subscriptions.set(subId, callback);
                    resolve();
                    // Ô£à Chamar callback original com primeira mensagem
                    callback(msg);
                    return;
                }
                // Ô£à Se n├úo for primeira mensagem, j├í deve estar usando callback original
                callback(msg);
            };

            conn.subscriptions.set(subId, wrappedCallback);
            conn.ws.send(JSON.stringify(payload));
        });
    }

    /**
     * Ô£à Remove subscription da conex├úo
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

    // --- CATEGORIA 1: CONFIGURA├ç├âO E MONITORAMENTO ---

    private logInitialConfigV2(userId: string, config: {
        agentName: string;
        operationMode: string;
        riskProfile: string;
        profitTarget: number;
        stopLoss: number;
        stopBlindadoEnabled: boolean;
    }) {
        const message = `ÔÜÖ´©Å CONFIGURA├ç├âO INICIAL\n` +
            `ÔÇó Agente: ${config.agentName}\n` +
            `ÔÇó Modo: ${config.operationMode}\n` +
            `ÔÇó Perfil: ${config.riskProfile}\n` +
            `ÔÇó Meta Lucro: $${config.profitTarget.toFixed(2)}\n` +
            `ÔÇó Stop Loss: $${config.stopLoss.toFixed(2)}\n` +
            `ÔÇó Stop Blindado: ${config.stopBlindadoEnabled ? 'ATIVO ­ƒøí´©Å' : 'INATIVO ÔØî'}`;

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
        const message = `­ƒÜÇ INICIANDO SESS├âO DE OPERA├ç├òES\n` +
            `ÔÇó Banca Inicial: $${session.initialBalance.toFixed(2)}\n` +
            `ÔÇó Meta do Dia: +$${session.profitTarget.toFixed(2)}\n` +
            `ÔÇó Stop Loss: -$${session.stopLoss.toFixed(2)}\n` +
            `ÔÇó Modo: ${session.mode}\n` +
            `ÔÇó Agente: ${session.agentName}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'CORE', message);
    }

    // --- CATEGORIA 2: COLETA E AN├üLISE ---

    private logDataCollection(userId: string, data: {
        targetCount: number;
        currentCount: number;
        mode?: string;
    }) {
        const modeStr = data.mode ? ` (${data.mode})` : '';
        const message = `­ƒôí COLETANDO DADOS...\n` +
            `ÔÇó META DE COLETA: ${data.targetCount} TICKS${modeStr}\n` +
            `ÔÇó CONTAGEM: ${data.currentCount}/${data.targetCount}`;

        this.saveLog(userId, 'INFO', 'ANALYZER', message);
    }

    private logAnalysisStarted(userId: string, mode: string, tickCount?: number) {
        const countStr = tickCount ? ` (Ticks: ${tickCount})` : '';
        const message = `­ƒºá AN├üLISE DO MERCADO\n` +
            `ÔÇó MODO: ${mode}\n` +
            `ÔÇó STATUS: Monitorando padr├Áes${countStr}\n` +
            `ÔÇó A├ç├âO: Aguardando oportunidade...`;

        this.saveLog(userId, 'INFO', 'ANALYZER', message);
    }

    private logBlockedEntry(userId: string, blocked: {
        reason: string;
        details?: string;
    }) {
        // ÔÅ©´©Å ENTRADA BLOQUEADA
        const message = `ÔÅ©´©Å ENTRADA BLOQUEADA\n` +
            `ÔÇó Motivo: ${blocked.reason}\n` +
            (blocked.details ? `ÔÇó Detalhes: ${blocked.details}` : '');

        // Log debug only
        // this.logger.debug(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        // Throttled log logic handled by caller usually, but here we just save
        this.saveLog(userId, 'INFO', 'ANALYZER', message);
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
        let message = `­ƒöì AN├üLISE: MODO ${signal.mode}${signal.isRecovery ? ' (RECUPERA├ç├âO)' : ''}\n`;
        signal.filters.forEach((filter, index) => {
            message += `Ô£à FILTRO ${index + 1}: ${filter}\n`;
        });
        message += `Ô£à GATILHO: ${signal.trigger}\n`;
        message += `­ƒÆ¬ CONFIAN├çA T├ëCNICA: ${signal.probability}% (Filtros Atendidos)\n`;
        message += `ÔÜá´©Å Nota: 100% indica que todas as regras de entrada foram cumpridas. O mercado ainda pode variar.`;

        if (signal.direction) {
            message += `­ƒôè ENTRADA: ${signal.contractType} ${signal.direction}`;
        } else {
            message += `­ƒôè ENTRADA: ${signal.contractType}`;
        }

        this.logger.log(`[Zeus][${userId}] SINAL: ${signal.trigger} | ${signal.direction}`);
        this.saveLog(userId, 'INFO', 'DECISION', message);
    }

    // --- CATEGORIA 3: EXECU├ç├âO E RESULTADO ---

    private logTradeResultV2(userId: string, result: {
        status: 'WIN' | 'LOSS';
        profit: number;
        stake: number;
        balance: number;
    }) {
        const profitStr = result.status === 'WIN' ? `+$${result.profit.toFixed(2)}` : `-$${result.stake.toFixed(2)}`;
        const message = `­ƒÄ» RESULTADO DA ENTRADA\n` +
            `ÔÇó Status: ${result.status}\n` +
            `ÔÇó Lucro/Preju├¡zo: ${profitStr}\n` +
            `ÔÇó Saldo Atual: $${result.balance.toFixed(2)}`;

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
        const message = `­ƒÜÇ APLICANDO SOROS N├ìVEL ${level}\n` +
            `ÔÇó Lucro Anterior: $${soros.previousProfit.toFixed(2)}\n` +
            `ÔÇó Nova Stake: $${newStake.toFixed(2)}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'RISK', message);
    }

    private logWinStreak(userId: string, streak: {
        consecutiveWins: number;
        accumulatedProfit: number;
        currentStake: number;
    }) {
        const message = `­ƒöÑ SEQU├èNCIA DE VIT├ôRIAS!\n` +
            `ÔÇó Vit├│rias Consecutivas: ${streak.consecutiveWins}\n` +
            `ÔÇó Lucro Acumulado: $${streak.accumulatedProfit.toFixed(2)}\n` +
            `ÔÇó Stake Atual: $${streak.currentStake.toFixed(2)}\n` +
            `ÔÇó Pr├│xima Vit├│ria: Reset para Stake Base`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'RISK', message);
    }

    // --- CATEGORIA 4: RECUPERA├ç├âO E RISCO ---

    private logMartingaleLevelV2(userId: string, martingale: {
        level: number;
        lossNumber: number;
        accumulatedLoss: number;
        calculatedStake: number;
        profitPercentage: number;
        maxLevel: number; // Ô£à Adicionado em 2.1
        contractType: string;
    }) {
        const message = `­ƒôè N├ìVEL DE RECUPERA├ç├âO\n` +
            `ÔÇó N├¡vel Atual: M${martingale.level} (${martingale.lossNumber}┬¬ perda)\n` +
            `ÔÇó Perdas Acumuladas: $${martingale.accumulatedLoss.toFixed(2)}\n` +
            `ÔÇó Stake Calculada: $${martingale.calculatedStake.toFixed(2)}\n` +
            `ÔÇó Objetivo: Recuperar + ${martingale.profitPercentage}%\n` +
            `ÔÇó Limite M├íximo: M${martingale.maxLevel}\n` +
            `ÔÇó Contrato: ${martingale.contractType}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'WARN', 'RISK', message);
    }

    private logSuccessfulRecoveryV2(userId: string, recovery: {
        recoveredLoss: number;
        additionalProfit: number;
        profitPercentage: number;
        stakeBase: number;
    }) {
        const message = `Ô£à RECUPERA├ç├âO BEM-SUCEDIDA!\n` +
            `ÔÇó Perdas Recuperadas: $${recovery.recoveredLoss.toFixed(2)}\n` +
            `ÔÇó Lucro Adicional: $${recovery.additionalProfit.toFixed(2)} (${recovery.profitPercentage}%)\n` +
            `ÔÇó A├º├úo: Resetando sistema e voltando ├á entrada principal\n` +
            `ÔÇó Pr├│xima Opera├º├úo: Entrada Normal (Stake Base: $${recovery.stakeBase.toFixed(2)})`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'INFO', 'RISK', message);
    }

    private logStopLossAdjustmentV2(userId: string, adjustment: {
        calculatedStake: number;
        remainingUntilStop: number;
        adjustedStake: number;
    }) {
        const message = `ÔÜá´©Å AJUSTE DE RISCO (STOP LOSS)\n` +
            `ÔÇó Stake Calculada: $${adjustment.calculatedStake.toFixed(2)}\n` +
            `ÔÇó Saldo Restante at├® Stop: $${adjustment.remainingUntilStop.toFixed(2)}\n` +
            `ÔÇó A├º├úo: Reduzindo para $${adjustment.adjustedStake.toFixed(2)}`;

        this.logger.log(`[Zeus][${userId}] ${message.replace(/\n/g, ' | ')}`);
        this.saveLog(userId, 'WARN', 'RISK', message);
    }

}

/**
 * Configura├º├úo do usu├írio para Zeus v3.7
 */
interface ZeusUserConfig extends AutonomousAgentConfig {
    initialBalance: number;
    stopLossType: string;
    riskProfile: string;
}

/**
 * Estado interno do Zeus v3.7 (Updated v4.0)
 */
interface ZeusUserState extends AutonomousAgentState {
    mode: 'VELOZ' | 'NORMAL' | 'PRECISO';
    saldoInicial: number;
    lucroAtual: number;
    picoLucro: number;
    consecutiveLosses: number;
    consecutiveWins: number;
    opsCount: number;
    stopBlindadoAtivo: boolean;
    pisoBlindado: number;
    lastProfit: number;
    currentContractId: string | null;
    currentTradeId: number | null;
    isWaitingContract: boolean;
    lastContractType?: string;

    // Digit-specific state
    consecutiveLosingDigits: number;
    lastDigits: number[];

    // Recovery state
    totalLossAccumulated: number;
    martingaleLevel: number;
    sorosLevel: number;
    totalLosses: number;
    recoveryAttempts: number;
    ticksSinceLastAnalysis: number;

    // Ô£à New Fields for V4.0
    consecutiveMainLosses: number;
    isPausedStrategy: boolean;
    pauseUntil?: number;

    // Throttling
    lastDeniedLogTime?: number;
    lastDeniedLogData?: { probability: number; signal: string | null };

    // Soros v2.2
    sorosActive: boolean;
    sorosCount: number;
}
