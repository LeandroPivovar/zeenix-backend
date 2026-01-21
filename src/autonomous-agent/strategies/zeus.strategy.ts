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
 * ⚡ ZEUS Strategy para Agente Autônomo - Versão 1.0 (Baseada em Falcon 2.1)
 * 
 * CORE: Price Action (Trend + Volatility/Delta)
 * - MODO NORMAL: Janela 7 ticks, 4/6 moves, delta >= 0.5. WR esperado ~76%.
 * - MODO LENTO: Janela 8 ticks, 5/7 moves, delta >= 0.7. WR esperado ~90%.
 * - Gestão: Soros Nível 1 no Normal, Smart Martingale no Lento.
 * - Proteção: Stop Blindado (40% meta ativa, proteção fixa de 50%).
 */

const ZEUS_SETTINGS = {
    NORMAL: {
        windowSize: 7,
        requiredMovements: 4,
        totalMovements: 6,
        minDelta: 0.5,
    },
    LENTO: {
        windowSize: 8,
        requiredMovements: 5,
        totalMovements: 7,
        minDelta: 0.7,
    },
};

const ZEUS_RISK = {
    CONSERVADOR: { profitFactor: 1.0, maxMartingale: 5 },
    MODERADO: { profitFactor: 1.15, maxMartingale: -1 }, // Sem limite
    AGRESSIVO: { profitFactor: 1.30, maxMartingale: -1 }, // Sem limite
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
           AND c.agent_type = 'zeus'
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
                            this.logger.warn(`[Zeus][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token: ${e.message}`);
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
                            this.logger.warn(`[Zeus][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token (Real): ${e.message}`);
                        }
                    }
                }

                if (resolvedToken !== user.config_token) {
                    this.logger.log(`[Zeus][ResolucaoToken] User ${userId}: Token atualizado dinamicamente. Modo=${wantDemo ? 'DEMO' : 'REAL'}.`);
                }

                const config: ZeusUserConfig = {
                    userId: userId,
                    initialStake: parseFloat(user.initial_stake),
                    dailyProfitTarget: parseFloat(user.daily_profit_target),
                    dailyLossLimit: parseFloat(user.daily_loss_limit),
                    derivToken: resolvedToken,
                    currency: user.currency,
                    symbol: 'R_100',
                    initialBalance: parseFloat(user.initial_balance) || 0,
                    stopLossType: 'normal',
                    riskProfile: 'MODERADO',
                };

                this.userConfigs.set(userId, config);
                this.initializeUserState(userId, config);
            }

            this.logger.log(`[Zeus] Sincronizados ${activeUsers.length} usuários ativos`);
        } catch (error) {
            this.logger.error('[Zeus] Erro ao sincronizar usuários:', error);
        }
    }

    private initializeUserState(userId: string, config: ZeusUserConfig): void {
        const state: ZeusUserState = {
            userId,
            isActive: true,
            saldoInicial: config.initialBalance,
            lucroAtual: 0,
            picoLucro: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            opsCount: 0,
            mode: 'NORMAL',
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
        };

        this.userStates.set(userId, state);
        this.ticks.set(userId, []);
    }

    async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
        const zeusConfig: ZeusUserConfig = {
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

        if (this.userConfigs.has(userId)) {
            this.logger.log(`[Zeus][${userId}] 🔄 Atualizando configuração (Usuário já ativo).`);
            this.userConfigs.set(userId, zeusConfig);
            const state = this.userStates.get(userId);
            if (state && !state.isActive) {
                state.isActive = true;
            }
            return;
        }

        this.userConfigs.set(userId, zeusConfig);
        this.initializeUserState(userId, zeusConfig);

        try {
            this.logger.log(`[Zeus][${userId}] 🔌 Pré-aquecendo conexão WebSocket...`);
            await this.warmUpConnection(zeusConfig.derivToken);
            this.logger.log(`[Zeus][${userId}] ✅ Conexão WebSocket pré-aquecida e pronta`);
        } catch (error: any) {
            this.logger.warn(`[Zeus][${userId}] ⚠️ Erro ao pré-aquecer conexão:`, error.message);
        }

        const state = this.userStates.get(userId);
        const mode = state?.mode || 'NORMAL';

        this.logInitialConfigV2(userId, {
            agentName: 'ZEUS',
            operationMode: mode,
            riskProfile: zeusConfig.riskProfile || 'MODERADO',
            profitTarget: zeusConfig.dailyProfitTarget,
            stopLoss: zeusConfig.dailyLossLimit,
            stopBlindadoEnabled: zeusConfig.stopLossType === 'blindado'
        });

        this.logSessionStart(userId, {
            date: new Date(),
            initialBalance: zeusConfig.initialBalance,
            profitTarget: zeusConfig.dailyProfitTarget,
            stopLoss: zeusConfig.dailyLossLimit,
            mode: mode,
            agentName: 'ZEUS'
        });

        this.logger.log(`[Zeus] ✅ Usuário ${userId} ativado | Symbol: ${zeusConfig.symbol} | Total configs: ${this.userConfigs.size}`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.userConfigs.delete(userId);
        this.userStates.delete(userId);
        this.ticks.delete(userId);
        this.logger.log(`[Zeus] ✅ Usuário ${userId} desativado`);
    }

    async processTick(tick: Tick, symbol?: string): Promise<void> {
        const promises: Promise<void>[] = [];
        const tickSymbol = symbol || 'R_100';

        this.logger.debug(`[Zeus] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);

        for (const [userId, config] of this.userConfigs.entries()) {
            if (tickSymbol === 'R_100') {
                promises.push(this.processTickForUser(userId, tick).catch((error) => {
                    this.logger.error(`[Zeus][${userId}] Erro ao processar tick:`, error);
                }));
            }
        }

        await Promise.all(promises);
    }

    private async processTickForUser(userId: string, tick: Tick): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || !state.isActive) return;
        if (this.processingLocks.get(userId)) return;
        if (state.isWaitingContract) return;

        const userTicks = this.ticks.get(userId) || [];
        userTicks.push(tick);

        if (userTicks.length > this.maxTicks) userTicks.shift();
        this.ticks.set(userId, userTicks);

        if (state.isWaitingContract) return;

        state.ticksSinceLastAnalysis = (state.ticksSinceLastAnalysis || 0) + 1;
        const requiredSkip = state.mode === 'NORMAL' ? 2 : 3;

        if (state.ticksSinceLastAnalysis <= requiredSkip) return;

        const settings = state.mode === 'NORMAL' ? ZEUS_SETTINGS.NORMAL : ZEUS_SETTINGS.LENTO;
        const requiredTicks = settings.windowSize;

        if (userTicks.length < requiredTicks) {
            if (userTicks.length % 2 === 0) {
                this.logDataCollection(userId, {
                    targetCount: requiredTicks,
                    currentCount: userTicks.length,
                    mode: state.mode
                });
            }
            return;
        }

        if (userTicks.length === requiredTicks || userTicks.length % 50 === 0) {
            this.logAnalysisStarted(userId, state.mode, userTicks.length);
        }

        if (state.isWaitingContract) return;
        this.processingLocks.set(userId, true);

        try {
            const marketAnalysis = await this.analyzeMarket(userId, userTicks);
            state.ticksSinceLastAnalysis = 0;
            if (state.isWaitingContract) {
                this.processingLocks.set(userId, false);
                return;
            }

            if (marketAnalysis) {
                const { signal, probability, details } = marketAnalysis;
                const ups = details?.ups || 0;
                const downs = details?.downs || 0;
                const total = details?.totalMoves || 0;

                this.logger.debug(`[Zeus][${userId}] Análise (${state.mode}): prob=${probability.toFixed(1)}%, signal=${signal}, moves=${ups}^/${downs}v`);

                const message = `📊 ANÁLISE COMPLETA [ZEUS]\n` +
                    `• Padrão: ${ups} altas / ${downs} baixas (de ${total})\n` +
                    `• Status: ${signal ? 'SINAL ENCONTRADO ✅' : 'SEM PADRÃO CLARO ❌'}\n` +
                    `• Probabilidade: ${probability}% (Cutoff: ${state.mode === 'NORMAL' ? 67 : 85}%)`;

                this.saveLog(userId, signal ? 'INFO' : 'INFO', 'ANALYZER', message);
            }

            if (marketAnalysis && marketAnalysis.signal) {
                if (state.isWaitingContract) {
                    this.processingLocks.set(userId, false);
                    return;
                }

                const decision = await this.processAgent(userId, marketAnalysis);
                if (state.isWaitingContract) {
                    this.processingLocks.set(userId, false);
                    return;
                }

                if (decision.action === 'BUY') {
                    await this.executeTrade(userId, decision, marketAnalysis);
                } else if (decision.action === 'STOP') {
                    await this.handleStopCondition(userId, decision.reason || 'UNKNOWN');
                }
            }
        } finally {
            this.processingLocks.set(userId, false);
        }
    }

    private async analyzeMarket(userId: string, ticks: Tick[]): Promise<MarketAnalysis | null> {
        const state = this.userStates.get(userId);
        if (!state) return null;

        const settings = state.mode === 'NORMAL' ? ZEUS_SETTINGS.NORMAL : ZEUS_SETTINGS.LENTO;
        const windowSize = settings.windowSize;

        if (ticks.length < windowSize) return null;

        const recent = ticks.slice(-windowSize);
        const recentValues = recent.map(t => t.value);

        let ups = 0;
        let downs = 0;
        const lastMoves = recentValues.slice(-(settings.totalMovements + 1));
        for (let i = 1; i < lastMoves.length; i++) {
            if (lastMoves[i] > lastMoves[i - 1]) ups++;
            if (lastMoves[i] < lastMoves[i - 1]) downs++;
        }

        const firstTick = recentValues[0];
        const lastTick = recentValues[recentValues.length - 1];
        const delta = Math.abs(lastTick - firstTick);

        let signal: 'CALL' | 'PUT' | null = null;
        let blockReason: string | null = null;

        const isUpSignal = ups >= settings.requiredMovements && delta >= settings.minDelta;
        const isDownSignal = downs >= settings.requiredMovements && delta >= settings.minDelta;

        if (isUpSignal) signal = 'CALL';
        else if (isDownSignal) signal = 'PUT';
        else {
            if (delta < settings.minDelta) {
                blockReason = `Delta insuficiente (${delta.toFixed(2)} < ${settings.minDelta})`;
            } else {
                const maxMoves = Math.max(ups, downs);
                blockReason = `Movimentos insuficientes (${maxMoves}/${settings.totalMovements})`;
            }
        }

        const moveScore = (Math.max(ups, downs) / settings.totalMovements) * 50;
        const deltaScore = Math.min((delta / settings.minDelta) * 50, 50);
        const probability = Math.round(moveScore + deltaScore);

        if (!signal) {
            this.logBlockedEntry(userId, {
                reason: delta < settings.minDelta ? 'delta' : 'filter',
                details: blockReason || 'Filtros não atingidos'
            });
        }

        return {
            probability,
            signal,
            payout: 0.92,
            confidence: probability / 100,
            details: {
                trend: signal || 'NEUTRAL',
                trendStrength: probability / 100,
                ups,
                downs,
                delta,
                totalMoves: settings.totalMovements
            },
        };
    }

    async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);

        if (!config || !state || !state.isActive) {
            return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
        }

        if (state.isWaitingContract) {
            return { action: 'WAIT', reason: 'WAITING_CONTRACT_RESULT' };
        }

        if (state.lucroAtual >= config.dailyProfitTarget) {
            return { action: 'STOP', reason: 'TAKE_PROFIT' };
        }

        const requiredProb = state.mode === 'LENTO' ? 85 : 70;

        if (marketAnalysis.probability >= requiredProb && marketAnalysis.signal) {
            const stake = this.calculateStake(userId, marketAnalysis.payout);
            if (stake <= 0) return { action: 'WAIT', reason: 'NO_STAKE' };

            const stopLossCheck = await this.checkStopLoss(userId, stake);
            if (stopLossCheck.action === 'STOP') return stopLossCheck;

            const finalStake = stopLossCheck.stake ? stopLossCheck.stake : stake;

            this.logSignalGenerated(userId, {
                mode: state.mode,
                isRecovery: state.mode === 'LENTO',
                filters: [
                    `Janela: ${ZEUS_SETTINGS[state.mode].windowSize} ticks`,
                    `Delta: ${marketAnalysis.details?.delta?.toFixed(2)}`,
                    `Moves: ${Math.max(marketAnalysis.details?.ups || 0, marketAnalysis.details?.downs || 0)}`
                ],
                trigger: 'Olimpo Confirmado ⚡',
                probability: marketAnalysis.probability,
                contractType: 'RISE/FALL',
                direction: marketAnalysis.signal as 'CALL' | 'PUT'
            });

            return {
                action: 'BUY',
                stake: finalStake,
                contractType: marketAnalysis.signal === 'CALL' ? 'CALL' : 'PUT',
                mode: state.mode,
                reason: 'HIGH_PROBABILITY',
            };
        } else {
            const now = Date.now();
            if (now - (state.lastDeniedLogTime || 0) > 30000) {
                const reasonMsg = marketAnalysis.probability < requiredProb
                    ? `Score ${marketAnalysis.probability.toFixed(1)}% abaixo do mínimo ${requiredProb}%`
                    : 'Sinal indefinido';

                this.logBlockedEntry(userId, {
                    reason: reasonMsg,
                    details: `Score: ${marketAnalysis.probability.toFixed(1)}%`
                });
                state.lastDeniedLogTime = now;
            }
        }

        return { action: 'WAIT', reason: 'LOW_PROBABILITY' };
    }

    private updateMode(userId: string, win: boolean): void {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        if (!state || !config) return;

        if (win) {
            state.consecutiveWins++;
            state.consecutiveLosses = 0;

            if (state.mode === 'LENTO') {
                state.mode = 'NORMAL';
                const recoveredLoss = state.totalLossAccumulated;
                state.totalLossAccumulated = 0;
                state.consecutiveWins = 0;

                this.logger.debug(`[Zeus][${userId}] ⚡ RECUPERAÇÃO OLÍMPICA! Resetando estado. Mode=NORMAL, Wins=0, AccumLoss=0.`);

                this.logSuccessfulRecoveryV2(userId, {
                    recoveredLoss: recoveredLoss,
                    additionalProfit: state.lastProfit,
                    profitPercentage: 0,
                    stakeBase: config.initialStake
                });
            }

            if (state.consecutiveWins >= 3) state.consecutiveWins = 0;
        } else {
            state.consecutiveWins = 0;
            state.consecutiveLosses++;

            if (state.mode === 'NORMAL') {
                state.mode = 'LENTO';
                this.logger.log(`[Zeus][${userId}] ⚠️ LOSS (Normal) -> Mudando para LENTO (Recuperação)`);
            }

            if (state.lastProfit < 0) {
                state.totalLossAccumulated += Math.abs(state.lastProfit);
            }
        }
    }

    private calculateStake(userId: string, marketPayoutPercent: number): number {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (!config || !state) return 0;

        let stake = config.initialStake;
        const realPayout = (marketPayoutPercent - marketPayoutPercent * this.comissaoPlataforma);

        if (state.mode === 'LENTO') {
            const riskSettings = ZEUS_RISK[config.riskProfile as keyof typeof ZEUS_RISK] || ZEUS_RISK.MODERADO;
            const profitFactor = riskSettings.profitFactor;
            const lossToRecover = state.totalLossAccumulated > 0 ? state.totalLossAccumulated : Math.abs(Math.min(0, state.lucroAtual));

            if (lossToRecover > 0) {
                const targetAmount = lossToRecover * profitFactor;
                stake = targetAmount / realPayout;

                if (riskSettings.maxMartingale !== -1 && state.consecutiveLosses > riskSettings.maxMartingale) {
                    this.logger.log(`[Zeus] ⚠️ Limite M${riskSettings.maxMartingale} atingido. Voltando para base.`);
                    state.mode = 'NORMAL';
                    state.totalLossAccumulated = 0;
                    return config.initialStake;
                }

                stake = Math.round(stake * 100) / 100;

                this.logMartingaleLevelV2(userId, {
                    level: state.consecutiveLosses,
                    lossNumber: state.consecutiveLosses,
                    accumulatedLoss: lossToRecover,
                    calculatedStake: stake,
                    profitPercentage: Math.round((profitFactor - 1) * 100),
                    maxLevel: riskSettings.maxMartingale,
                    contractType: state.lastContractType || 'RISE/FALL'
                });
            }
        } else {
            if (state.consecutiveWins === 1) {
                stake = config.initialStake + state.lastProfit;
                this.logSorosActivation(userId, {
                    previousProfit: state.lastProfit,
                    stakeBase: config.initialStake,
                    level: 1
                });
            }
        }

        return Math.round(stake * 100) / 100;
    }

    private async checkStopLoss(userId: string, nextStake?: number): Promise<TradeDecision> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (!config || !state) return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };

        const stake = nextStake || 0;
        const currentDrawdown = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;

        if (currentDrawdown >= config.dailyLossLimit) return { action: 'STOP', reason: 'STOP_LOSS' };

        if (currentDrawdown + stake > config.dailyLossLimit) {
            const remaining = config.dailyLossLimit - currentDrawdown;
            const adjustedStake = Math.round(remaining * 100) / 100;
            if (adjustedStake < 0.35) return { action: 'STOP', reason: 'STOP_LOSS_LIMIT' };
            return { action: 'BUY', stake: adjustedStake, reason: 'STOP_LOSS_ADJUSTED' };
        }

        if (config.stopLossType === 'blindado') {
            if (!state.stopBlindadoAtivo) {
                if (state.lucroAtual >= config.dailyProfitTarget * 0.40) {
                    state.stopBlindadoAtivo = true;
                    state.picoLucro = state.lucroAtual;
                    state.pisoBlindado = state.picoLucro * 0.50;
                    this.saveLog(userId, 'INFO', 'RISK', `⚡ ZEUS: Blindagem Ativada em $${state.pisoBlindado.toFixed(2)}.`);
                }
            } else {
                if (state.lucroAtual > state.picoLucro) {
                    state.picoLucro = state.lucroAtual;
                    state.pisoBlindado = state.picoLucro * 0.50;
                }
                if (state.lucroAtual <= state.pisoBlindado) {
                    state.isActive = false;
                    await this.dataSource.query(
                        `UPDATE autonomous_agent_config SET session_status = 'stopped_blindado', is_active = TRUE WHERE user_id = ? AND agent_type = 'zeus'`,
                        [userId],
                    );
                    return { action: 'STOP', reason: 'BLINDADO' };
                }
            }
        }

        return { action: 'BUY', stake: stake, reason: 'RiskCheckOK' };
    }

    private async executeTrade(userId: string, decision: TradeDecision, marketAnalysis: MarketAnalysis): Promise<void> {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (!config || !state || state.isWaitingContract) return;

        state.isWaitingContract = true;
        const userTicks = this.ticks.get(userId) || [];
        const currentPrice = userTicks.length > 0 ? userTicks[userTicks.length - 1].value : 0;
        const contractType = decision.contractType || (marketAnalysis.signal === 'CALL' ? 'CALL' : 'PUT');

        try {
            state.lastContractType = contractType;
            const tradeId = await this.createTradeRecord(userId, {
                contractType,
                stakeAmount: decision.stake || config.initialStake,
                duration: 5,
                marketAnalysis,
                payout: 0.9215,
                entryPrice: currentPrice,
            });

            const contractId = await this.buyContract(userId, config.derivToken, contractType, config.symbol, decision.stake || config.initialStake, 5);
            if (contractId) {
                state.currentContractId = contractId;
                state.currentTradeId = tradeId;
                await this.saveLog(userId, 'INFO', 'TRADER', `⚡ ZEUS: RAIO DISPARADO! Entrou em ${contractType} | $${(decision.stake || config.initialStake).toFixed(2)}`);
                await this.updateTradeRecord(tradeId, { contractId, status: 'ACTIVE' });
            } else {
                state.isWaitingContract = false;
            }
        } catch (error) {
            state.isWaitingContract = false;
            this.logger.error(`[Zeus][${userId}] Erro Trade:`, error);
        }
    }

    // ✅ Métodos auxiliares para satisfazer a interface se necessário (lint fix)
    private async getOrCreateWebSocketConnectionFix(token: string, userId: string) { return await this.getOrCreateWebSocketConnection(token, userId); }
    private async sendRequestViaConnectionFix(token: string, payload: any, timeoutMs: number) { return await this.sendRequestViaConnection(token, payload, timeoutMs); }
    private async subscribeViaConnectionFix(token: string, payload: any, callback: any, subId: string, timeoutMs: number) { return await this.subscribeViaConnection(token, payload, callback, subId, timeoutMs); }

    private async getOrCreateWebSocketConnection(token: string, userId?: string) {
        const existing = this.wsConnections.get(token);
        if (existing && existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
            return {
                ws: existing.ws,
                sendRequest: (p, t) => this.sendRequestViaConnection(token, p, t || 60000),
                subscribe: (p, c, s, t) => this.subscribeViaConnection(token, p, c, s, t || 90000),
                removeSubscription: (s) => this.removeSubscriptionFromConnection(token, s),
            };
        }
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        const ws = await new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });
            let authResolved = false;
            const timeout = setTimeout(() => { if (!authResolved) { socket.close(); reject(new Error('Auth Timeout')); } }, 20000);

            socket.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                const conn = this.wsConnections.get(token);
                if (!conn) return;

                if (msg.msg_type === 'authorize' && !authResolved) {
                    authResolved = true; clearTimeout(timeout);
                    if (msg.error) { socket.close(); reject(new Error('Auth Error')); return; }
                    conn.authorized = true;
                    conn.keepAliveInterval = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 })); }, 90000);
                    resolve(socket);
                } else if (msg.proposal_open_contract) {
                    const cid = msg.proposal_open_contract.contract_id;
                    if (cid && conn.subscriptions.has(cid)) conn.subscriptions.get(cid)!(msg);
                } else if (msg.proposal || msg.buy || msg.error) {
                    const firstKey = conn.pendingRequests.keys().next().value;
                    if (firstKey) {
                        const pending = conn.pendingRequests.get(firstKey);
                        if (pending) {
                            clearTimeout(pending.timeout);
                            conn.pendingRequests.delete(firstKey);
                            if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg);
                        }
                    }
                }
            });
            socket.on('open', () => {
                this.wsConnections.set(token, { ws: socket, authorized: false, keepAliveInterval: null, requestIdCounter: 0, pendingRequests: new Map(), subscriptions: new Map() });
                socket.send(JSON.stringify({ authorize: token }));
            });
            socket.on('close', () => { this.wsConnections.delete(token); });
        });
        const conn = this.wsConnections.get(token)!;
        return {
            ws: conn.ws,
            sendRequest: (p, t) => this.sendRequestViaConnection(token, p, t || 60000),
            subscribe: (p, c, s, t) => this.subscribeViaConnection(token, p, c, s, t || 90000),
            removeSubscription: (s) => this.removeSubscriptionFromConnection(token, s),
        };
    }

    private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
        const conn = this.wsConnections.get(token);
        if (!conn) throw new Error('No connection');
        return new Promise((resolve, reject) => {
            const id = `req_${++conn.requestIdCounter}`;
            const timeout = setTimeout(() => { conn.pendingRequests.delete(id); reject(new Error('Timeout')); }, timeoutMs);
            conn.pendingRequests.set(id, { resolve, reject, timeout });
            conn.ws.send(JSON.stringify(payload));
        });
    }

    private async subscribeViaConnection(token: string, payload: any, callback: (msg: any) => void, subId: string, timeoutMs: number): Promise<void> {
        const conn = this.wsConnections.get(token);
        if (!conn) throw new Error('No connection');
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { conn.subscriptions.delete(subId); reject(new Error('Sub Timeout')); }, timeoutMs);
            const wrapped = (msg: any) => {
                if (msg.proposal_open_contract || msg.error) {
                    clearTimeout(timeout);
                    if (msg.error) { conn.subscriptions.delete(subId); reject(new Error(msg.error.message)); return; }
                    conn.subscriptions.set(subId, callback);
                    resolve();
                    callback(msg);
                }
            };
            conn.subscriptions.set(subId, wrapped);
            conn.ws.send(JSON.stringify(payload));
        });
    }

    private removeSubscriptionFromConnection(token: string, subId: string): void {
        const conn = this.wsConnections.get(token);
        if (conn) conn.subscriptions.delete(subId);
    }

    private async buyContract(userId: string, token: string, contractType: string, symbol: string, stake: number, duration: number): Promise<string | null> {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const conn = await this.getOrCreateWebSocketConnection(token, userId);
            const proposal = await conn.sendRequest({ proposal: 1, amount: stake, basis: 'stake', contract_type: contractType, currency: 'USD', duration, duration_unit: 't', symbol });
            if (proposal.error) throw new Error(proposal.error.message);
            const buy = await conn.sendRequest({ buy: proposal.proposal.id, price: proposal.proposal.ask_price });
            if (buy.error) throw new Error(buy.error.message);
            const contractId = buy.buy.contract_id;
            await conn.subscribe({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }, (msg) => {
                const c = msg.proposal_open_contract;
                if (!c) return;
                if (c.is_sold || c.status === 'won' || c.status === 'lost') {
                    this.onContractFinish(userId, { win: c.status === 'won', profit: Number(c.profit), contractId, exitPrice: Number(c.exit_spot), stake }).catch(e => this.logger.error(e));
                    conn.removeSubscription(contractId);
                }
            }, contractId);
            return contractId;
        } catch (e) {
            this.logger.error(`[Zeus] Buy Error: ${e.message}`);
            return null;
        }
    }

    async onContractFinish(userId: string, result: { win: boolean; profit: number; contractId: string; exitPrice?: number; stake: number }) {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        if (!state || !config) return;
        state.isWaitingContract = false;
        const tid = state.currentTradeId;
        state.currentContractId = null;
        state.currentTradeId = null;

        if (tid) await this.updateTradeRecord(tid, { status: result.win ? 'WON' : 'LOST', profitLoss: result.profit, exitPrice: result.exitPrice });
        state.opsCount++;
        state.lastProfit = result.profit;
        state.lucroAtual += result.profit;
        this.updateMode(userId, result.win);
        await this.updateUserStateInDb(userId, state);
        this.logTradeResultV2(userId, { status: result.win ? 'WIN' : 'LOSS', profit: result.profit, stake: result.stake, balance: config.initialBalance + state.lucroAtual });

        if (state.lucroAtual >= config.dailyProfitTarget) await this.handleStopCondition(userId, 'TAKE_PROFIT');
        else if (state.lucroAtual <= -config.dailyLossLimit) await this.handleStopCondition(userId, 'STOP_LOSS');
    }

    private async handleStopCondition(userId: string, reason: string) {
        const config = this.userConfigs.get(userId);
        const state = this.userStates.get(userId);
        if (!config || !state) return;
        state.isActive = false;
        const status = reason === 'TAKE_PROFIT' ? 'stopped_profit' : reason === 'STOP_LOSS' ? 'stopped_loss' : 'stopped_blindado';
        await this.dataSource.query(`UPDATE autonomous_agent_config SET session_status = ?, is_active = TRUE WHERE user_id = ? AND agent_type = 'zeus'`, [status, userId]);
        this.saveLog(userId, 'WARN', 'RISK', `🏁 ZEUS FINALIZADO: ${reason}`);
    }

    private async createTradeRecord(userId: string, trade: any) {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        const result = await this.dataSource.query(`INSERT INTO autonomous_agent_trades (user_id, analysis_data, contract_type, contract_duration, entry_price, stake_amount, martingale_level, symbol, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())`,
            [userId, JSON.stringify({ strategy: 'zeus', mode: state?.mode }), trade.contractType, trade.duration, trade.entryPrice, trade.stakeAmount, state?.mode === 'LENTO' ? 'M1' : 'M0', config?.symbol]);
        return result.insertId;
    }

    private async updateTradeRecord(id: number, updates: any) {
        const fields = Object.entries(updates).map(([k, v]) => `${k.replace(/[A-Z]/g, l => `_${l.toLowerCase()}`)} = ?`);
        await this.dataSource.query(`UPDATE autonomous_agent_trades SET ${fields.join(', ')} WHERE id = ?`, [...Object.values(updates), id]);
    }

    private async updateUserStateInDb(userId: string, state: ZeusUserState) {
        await this.dataSource.query(`UPDATE autonomous_agent_config SET daily_profit = ?, daily_loss = ?, total_trades = ? WHERE user_id = ? AND agent_type = 'zeus'`, [Math.max(0, state.lucroAtual), Math.abs(Math.min(0, state.lucroAtual)), state.opsCount, userId]);
    }

    private async saveLog(userId: string, level: string, module: string, message: string) {
        if (this.logQueueService) this.logQueueService.saveLogAsync({ userId, level: level as any, module: module as any, message, icon: '⚡', tableName: 'autonomous_agent_logs' });
        this.logger.log(`[Zeus][${module}] ${message}`);
    }

    async warmUpConnection(token: string) { await this.getOrCreateWebSocketConnection(token); }

    // Logs Portados
    private logInitialConfigV2(u, c) { this.saveLog(u, 'INFO', 'CORE', `⚡ ZEUS: Perfil ${c.riskProfile}, Meta $${c.profitTarget}, Stop $${c.stopLoss}`); }
    private logSessionStart(u, s) { this.saveLog(u, 'INFO', 'CORE', `⚡ ZEUS: Iniciando com $${s.initialBalance}`); }
    private logDataCollection(u, d) { this.saveLog(u, 'INFO', 'ANALYZER', `⚡ ZEUS: Coletando ${d.currentCount}/${d.targetCount}`); }
    private logAnalysisStarted(u, m, c) { this.saveLog(u, 'INFO', 'ANALYZER', `⚡ ZEUS: Analisando em ${m}`); }
    private logBlockedEntry(u, b) { this.saveLog(u, 'INFO', 'ANALYZER', `⚡ ZEUS: Bloqueado (${b.reason})`); }
    private logSignalGenerated(u, s) { this.saveLog(u, 'INFO', 'DECISION', `⚡ ZEUS: Sinal de ${s.direction} (${s.probability}%)`); }
    private logTradeResultV2(u, r) { this.saveLog(u, 'INFO', 'EXECUTION', `⚡ ZEUS: ${r.status} | Profit $${r.profit} | Saldo $${r.balance}`); }
    private logSorosActivation(u, s) { this.saveLog(u, 'INFO', 'RISK', `⚡ ZEUS: Soros Nível ${s.level} | Stake $${s.stakeBase + s.previousProfit}`); }
    private logMartingaleLevelV2(u, m) { this.saveLog(u, 'WARN', 'RISK', `⚡ ZEUS: Recuperação M${m.level} | Perda $${m.accumulatedLoss}`); }
    private logSuccessfulRecoveryV2(u, r) { this.saveLog(u, 'INFO', 'RISK', `⚡ ZEUS: Recuperado $${r.recoveredLoss}!`); }

    async getUserState(u) { return null; }
    async resetDailySession(u) { }
}

interface ZeusUserConfig {
    userId: string; initialStake: number; dailyProfitTarget: number; dailyLossLimit: number; derivToken: string; currency: string; symbol: 'R_100'; initialBalance: number; stopLossType?: 'normal' | 'blindado'; riskProfile?: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
}

interface ZeusUserState {
    userId: string; isActive: boolean; saldoInicial: number; lucroAtual: number; picoLucro: number; consecutiveLosses: number; consecutiveWins: number; opsCount: number; mode: 'NORMAL' | 'LENTO'; stopBlindadoAtivo: boolean; pisoBlindado: number; lastProfit: number; currentContractId: string | null; currentTradeId: number | null; isWaitingContract: boolean; lastContractType?: string; martingaleLevel: number; sorosLevel: number; totalLosses: number; recoveryAttempts: number; totalLossAccumulated: number; ticksSinceLastAnalysis: number; lastDeniedLogTime?: number; lastDeniedLogData?: { probability: number; signal: string | null };
}
