import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';
import { CopyTradingService } from '../../copy-trading/copy-trading.service';

/**
 * ✅ TITAN Strategy Master Blueprint
 * Lógica "Persistência" + Zenix Pro Standards.
 */

class RiskManager {
    private initialBalance: number;
    private stopLossLimit: number;
    private profitTarget: number;
    private riskMode: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
    private useBlindado: boolean;
    private maxBalance: number;
    public consecutiveLosses: number;
    private totalLossAccumulated: number;
    private lastResultWasWin: boolean;
    private _blindadoActive: boolean;

    constructor(
        initialBalance: number,
        stopLossLimit: number,
        profitTarget: number,
        riskMode: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO' = 'CONSERVADOR',
        useBlindado: boolean = true,
    ) {
        this.initialBalance = initialBalance;
        this.stopLossLimit = stopLossLimit;
        this.profitTarget = profitTarget;
        this.riskMode = riskMode.toUpperCase() as 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
        this.useBlindado = useBlindado;
        this.maxBalance = initialBalance;
        this.consecutiveLosses = 0;
        this.totalLossAccumulated = 0.0;
        this.lastResultWasWin = false;
        this._blindadoActive = false;
    }

    updateResult(profit: number, stakeUsed: number): void {
        if (profit < 0) {
            this.consecutiveLosses += 1;
            this.totalLossAccumulated += stakeUsed;
            this.lastResultWasWin = false;
        } else {
            this.consecutiveLosses = 0;
            this.totalLossAccumulated = 0.0;
            this.lastResultWasWin = true;
        }
    }

    get blindadoActive(): boolean {
        return this._blindadoActive;
    }

    get profitAccumulatedAtPeak(): number {
        return this.maxBalance - this.initialBalance;
    }

    get guaranteedProfit(): number {
        if (!this._blindadoActive) return 0;
        return this.profitAccumulatedAtPeak * 0.5;
    }

    calculateStake(
        currentBalance: number,
        baseStake: number,
        lastProfit: number,
        logger?: any,
        vitoriasConsecutivas?: number,
        userId?: string,
        symbol?: string,
        logCallback?: (userId: string, symbol: string, type: string, message: string) => void,
    ): number {
        if (currentBalance > this.maxBalance) {
            this.maxBalance = currentBalance;
        }

        let nextStake = baseStake;
        const PAYOUT_RATE = 0.95;

        if (this.consecutiveLosses > 0) {
            if (this.riskMode === 'CONSERVADOR') {
                if (this.consecutiveLosses <= 5) {
                    nextStake = this.totalLossAccumulated / 0.92;
                } else {
                    this.consecutiveLosses = 0;
                    this.totalLossAccumulated = 0.0;
                    nextStake = baseStake;
                }
            } else if (this.riskMode === 'MODERADO') {
                const targetRecovery = this.totalLossAccumulated * 1.25;
                nextStake = targetRecovery / PAYOUT_RATE;
            } else if (this.riskMode === 'AGRESSIVO') {
                const targetRecovery = this.totalLossAccumulated * 1.50;
                nextStake = targetRecovery / PAYOUT_RATE;
            }
        } else if (this.lastResultWasWin && vitoriasConsecutivas !== undefined && vitoriasConsecutivas > 0 && vitoriasConsecutivas <= 1) {
            nextStake = baseStake + lastProfit;
        }

        nextStake = Math.round(nextStake * 100) / 100;

        const profitAccumulatedAtPeak = this.maxBalance - this.initialBalance;
        const activationTrigger = this.profitTarget * 0.40;
        let minAllowedBalance = 0.0;

        if (this.useBlindado && profitAccumulatedAtPeak >= activationTrigger && !this._blindadoActive) {
            this._blindadoActive = true;
            if (userId && symbol && logCallback) {
                const guaranteedProfit = profitAccumulatedAtPeak * 0.5;
                logCallback(userId, symbol, 'info',
                    `ℹ️🛡️Stop Blindado: Ativado | Lucro atual $${profitAccumulatedAtPeak.toFixed(2)} | Protegendo 50%: $${guaranteedProfit.toFixed(2)}`);
            }
        }

        // ✅ Log de progresso ANTES de ativar (quando lucro < 40% da meta)
        if (this.useBlindado && !this._blindadoActive && profitAccumulatedAtPeak > 0 && profitAccumulatedAtPeak < activationTrigger) {
            const percentualProgresso = (profitAccumulatedAtPeak / activationTrigger) * 100;
            if (userId && symbol && logCallback) {
                logCallback(userId, symbol, 'info',
                    `ℹ️🛡️ Stop Blindado: Lucro $${profitAccumulatedAtPeak.toFixed(2)} | Meta ativação: $${activationTrigger.toFixed(2)} (${percentualProgresso.toFixed(1)}%)`);
            }
        }

        if (this._blindadoActive) {
            const guaranteedProfit = profitAccumulatedAtPeak * 0.5;
            minAllowedBalance = this.initialBalance + guaranteedProfit;
        } else {
            minAllowedBalance = this.initialBalance - this.stopLossLimit;
        }

        const potentialBalanceAfterLoss = currentBalance - nextStake;
        if (potentialBalanceAfterLoss < minAllowedBalance) {
            let adjustedStake = currentBalance - minAllowedBalance;
            adjustedStake = Math.round(adjustedStake * 100) / 100;

            if (userId && symbol && logCallback) {
                const balanceRemaining = (currentBalance - minAllowedBalance).toFixed(2);
                logCallback(userId, symbol, 'alerta',
                    `⚠️ [RISCO] Entrada calculada ($${nextStake.toFixed(2)}) violaria o Stop Loss.\n• Ajuste de Precisão: Stake reduzida para $${adjustedStake.toFixed(2)} (Saldo Restante Permitido: $${balanceRemaining})`);
            }

            if (adjustedStake < 0.35) return 0.0;
            return adjustedStake;
        }

        return Math.round(nextStake * 100) / 100;
    }
}

interface TitanUserState {
    userId: string;
    derivToken: string;
    currency: string;
    capital: number;
    apostaInicial: number;
    modoMartingale: ModoMartingale;
    mode: 'VELOZ' | 'NORMAL' | 'PRECISO';
    originalMode: 'VELOZ' | 'NORMAL' | 'PRECISO';
    lastDirection: DigitParity | null;
    isOperationActive: boolean;
    vitoriasConsecutivas: number;
    ultimoLucro: number;
    ticksColetados: number;
    sorosActive: boolean;
    sorosStake: number;
    capitalInicial: number;
    defesaAtivaLogged?: boolean; // ✅ Flag para evitar log repetido de defesa ativa
}

@Injectable()
export class TitanStrategy implements IStrategy {
    name = 'titan';
    private readonly logger = new Logger(TitanStrategy.name);
    private users = new Map<string, TitanUserState>();
    private riskManagers = new Map<string, RiskManager>();
    private ticks: Tick[] = [];
    private symbol = 'R_100';
    private appId: string;

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

    // ✅ Sistema de logs (Titan)
    private logQueue: Array<{
        userId: string;
        symbol: string;
        type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
        message: string;
        details?: any;
    }> = [];
    private logProcessing = false;

    // ✅ Stop Loss Blindado: Track users que já foram notificados da ativação
    private blindadoActivatedUsers = new Set<string>();

    constructor(
        private dataSource: DataSource,
        private tradeEvents: TradeEventsService,
        private copyTradingService: CopyTradingService,
    ) {
        this.appId = process.env.DERIV_APP_ID || '111346';
    }

    async initialize(): Promise<void> {
        this.logger.log('[TITAN] Estratégia TITAN Master inicializada');
    }

    async processTick(tick: Tick, symbol?: string): Promise<void> {
        if (symbol && symbol !== this.symbol) return;
        this.ticks.push(tick);
        if (this.ticks.length > 100) this.ticks.shift();

        for (const state of this.users.values()) {
            state.ticksColetados++;
            await this.processUser(state);
        }
    }

    private async processUser(state: TitanUserState): Promise<void> {
        if (state.isOperationActive) return;
        const riskManager = this.riskManagers.get(state.userId);
        if (!riskManager) return;

        const signal = this.check_signal(state, riskManager);
        if (!signal) return;

        await this.executeOperation(state, signal);
    }

    private check_signal(state: TitanUserState, riskManager: RiskManager): DigitParity | null {
        // ✅ 1. Defesa Automática (Auto-Defense) - Cópia da Orion
        // Se tiver 3 ou mais losses, força o modo PRECISO temporariamente (sem alterar o state.mode original de forma permanente)
        let effectiveMode = state.mode;

        if (riskManager.consecutiveLosses >= 3) {
            effectiveMode = 'PRECISO';

            // ✅ Logar apenas uma vez quando a defesa é ativada
            if (!state.defesaAtivaLogged) {
                this.logger.log(`🚨 [TITAN][DEFESA ATIVA] ${riskManager.consecutiveLosses} Losses seguidos. Forçando modo PRECISO.`);
                this.saveTitanLog(state.userId, this.symbol, 'alerta', `🚨 [TITAN][DEFESA ATIVA] ${riskManager.consecutiveLosses} Losses seguidos. Forçando modo PRECISO.`);
                state.defesaAtivaLogged = true;
            }
        } else {
            // ✅ Resetar flag quando a defesa não está mais ativa
            if (state.defesaAtivaLogged) {
                this.logger.log(`✅ [TITAN][RECUPERAÇÃO] Voltando ao modo ${state.originalMode}.`);
                state.defesaAtivaLogged = false;
            }
            // Garante que volta ao modo configurado (pode ter sido alterado manualmente, então usamos state.mode)
            effectiveMode = state.mode;
        }

        // ✅ 2. Definição de Ticks Necessários baseada no Modo Efetivo
        let requiredTicks = effectiveMode === 'VELOZ' ? 10 : effectiveMode === 'NORMAL' ? 20 : 50;
        if (state.ticksColetados < requiredTicks) return null;

        const window = this.ticks.slice(-requiredTicks).map(t => t.digit);
        let signal: DigitParity | null = null;

        // ✅ 3. Lógica de Análise baseada no Modo Efetivo
        if (effectiveMode === 'VELOZ') {
            const evens = window.slice(-10).filter(d => d % 2 === 0).length;
            signal = evens > 5 ? 'PAR' : evens < 5 ? 'IMPAR' : null;
            if (signal) {
                const criterio = signal === 'PAR' ? `Maioria PAR (${evens}/10)` : `Maioria ÍMPAR (${10 - evens}/10)`;
                this.saveTitanLog(state.userId, this.symbol, 'analise', `🔍 [ANÁLISE VELOZ]\n• Critério: ${criterio}`);
            }
        } else if (effectiveMode === 'NORMAL') {
            const last3 = window.slice(-3).map(d => d % 2);
            if (last3.every(v => v === 0)) signal = 'PAR';
            else if (last3.every(v => v === 1)) signal = 'IMPAR';
            if (signal) {
                const tipo = signal === 'PAR' ? 'PAR' : 'ÍMPAR';
                this.saveTitanLog(state.userId, this.symbol, 'analise', `🔍 [ANÁLISE NORMAL]\n• Critério: Sequência 3x ${tipo} detectada`);
            }
        } else if (effectiveMode === 'PRECISO') {
            const last5 = window.slice(-5).map(d => d % 2);
            if (last5.every(v => v === 0)) signal = 'PAR';
            else if (last5.every(v => v === 1)) signal = 'IMPAR';
            if (signal) {
                const tipo = signal === 'PAR' ? 'PAR' : 'ÍMPAR';
                this.saveTitanLog(state.userId, this.symbol, 'analise', `🔍 [ANÁLISE PRECISO]\n• Critério: Sequência 5x ${tipo} detectada`);
            }
        }

        if (signal) state.lastDirection = signal;
        return signal;
    }

    async activateUser(userId: string, config: any): Promise<void> {
        const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, stopLossBlindado, profitTarget, lossLimit } = config;
        const titanMode = (mode || 'VELOZ').toUpperCase() as any;

        this.users.set(userId, {
            userId, derivToken, currency: currency || 'USD',
            capital: stakeAmount, apostaInicial: entryValue || 0.35,
            modoMartingale: modoMartingale || 'conservador',
            mode: titanMode, originalMode: titanMode,
            lastDirection: null, isOperationActive: false,
            vitoriasConsecutivas: 0, ultimoLucro: 0, ticksColetados: 0,
            sorosActive: false, sorosStake: 0,
            capitalInicial: stakeAmount,
            defesaAtivaLogged: false
        });

        this.riskManagers.set(userId, new RiskManager(
            stakeAmount, lossLimit || 50, profitTarget || 100,
            modoMartingale.toUpperCase(), stopLossBlindado !== false
        ));

        this.logger.log(`[TITAN] ${userId} ativado em ${titanMode}`);

        // ✅ Log: Usuário ativado
        this.saveTitanLog(userId, 'SISTEMA', 'info',
            `Usuário ATIVADO | Modo: ${titanMode} | Capital: $${stakeAmount.toFixed(2)} | Martingale: ${modoMartingale || 'conservador'}`);

        // ✅ Log imediato: Status de coleta de ticks
        let requiredTicks = titanMode === 'VELOZ' ? 10 : titanMode === 'NORMAL' ? 20 : 50;
        this.saveTitanLog(userId, this.symbol, 'info',
            `📊 Aguardando ${requiredTicks} ticks para análise | Modo: ${titanMode} | Coleta inicial iniciada.`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.users.delete(userId);
        this.riskManagers.delete(userId);
    }

    getUserState(userId: string) { return this.users.get(userId); }

    private async executeOperation(state: TitanUserState, direction: DigitParity): Promise<void> {
        const riskManager = this.riskManagers.get(state.userId)!;
        const saveTitanLogCallback = (userId: string, symbol: string, type: string, message: string) => {
            this.saveTitanLog(userId, symbol, type as any, message);
        };
        const stake = riskManager.calculateStake(
            state.capital,
            state.apostaInicial,
            state.ultimoLucro,
            this.logger,
            state.vitoriasConsecutivas,
            state.userId,
            this.symbol,
            saveTitanLogCallback
        );

        if (stake <= 0) {
            const blindadoMsg = riskManager.blindadoActive
                ? `💰✅Stoploss blindado atingido, o sistema parou as operações com um lucro de $${riskManager.guaranteedProfit.toFixed(2)} para proteger o seu capital.`
                : `🛑 [STOP LOSS ATINGIDO] Limite de perda atingido.\n• Sessão Encerrada para proteção do capital.`;

            this.saveTitanLog(state.userId, this.symbol, 'alerta', blindadoMsg);

            // Emit event for frontend modal
            const sessionStatus = riskManager.blindadoActive ? 'stopped_blindado' : 'stopped_loss';
            this.tradeEvents.emit({
                userId: state.userId,
                type: sessionStatus,
                strategy: 'titan',
                profitProtected: riskManager.blindadoActive ? riskManager.guaranteedProfit : undefined
            });

            await this.deactivateUser(state.userId);
            await this.dataSource.query(`UPDATE ai_user_config SET is_active = 0, session_status = ? WHERE user_id = ?`, [sessionStatus, state.userId]);
            return;
        }

        // ✅ VERIFICAR STOP LOSS BLINDADO (antes de executar trade)
        try {
            const blindadoConfig = await this.dataSource.query(
                `SELECT profit_peak, stop_blindado_percent, profit_target,
                        stake_amount as capitalInicial, session_balance
                 FROM ai_user_config WHERE user_id = ? AND is_active = 1
                 LIMIT 1`,
                [state.userId]
            );

            if (blindadoConfig && blindadoConfig.length > 0) {
                const config = blindadoConfig[0];
                const sessionBalance = parseFloat(config.session_balance) || 0;
                const capitalInicial = parseFloat(config.capitalInicial) || 0;
                const profitTarget = parseFloat(config.profit_target) || 0;
                const capitalSessao = capitalInicial + sessionBalance;
                const lucroAtual = sessionBalance;

                // ✅ VERIFICAR STOP WIN (profit target)
                if (profitTarget > 0 && lucroAtual >= profitTarget) {
                    this.logger.log(`[TITAN][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - BLOQUEANDO OPERAÇÃO`);

                    this.saveTitanLog(state.userId, this.symbol, 'info',
                        `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);

                    // Desativar a IA
                    await this.dataSource.query(
                        `UPDATE ai_user_config 
                         SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
                         WHERE user_id = ? AND is_active = 1`,
                        [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} >= Meta +$${profitTarget.toFixed(2)}`, state.userId]
                    );

                    // Emitir evento para o frontend
                    this.tradeEvents.emit({
                        userId: state.userId,
                        type: 'stopped_profit',
                        strategy: 'titan',
                        profitLoss: lucroAtual
                    });

                    await this.deactivateUser(state.userId);
                    return; // NÃO EXECUTAR OPERAÇÃO
                }

                // Update profit peak if current profit is higher
                let profitPeak = parseFloat(config.profit_peak) || 0;
                if (lucroAtual > profitPeak) {
                    profitPeak = lucroAtual;
                    // Update in background
                    this.dataSource.query(
                        `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
                        [profitPeak, state.userId]
                    ).catch(err => this.logger.error(`[TITAN] Erro ao atualizar profit_peak:`, err));
                }

                // Check if Blindado should activate (40% of profit target reached)
                if (config.stop_blindado_percent !== null && config.stop_blindado_percent !== undefined) {
                    if (profitPeak >= profitTarget * 0.40) {
                        const stopBlindadoPercent = parseFloat(config.stop_blindado_percent) || 50.0;
                        const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
                        const stopBlindado = capitalInicial + protectedAmount;

                        // Log activation (only once per user)
                        if (!this.blindadoActivatedUsers.has(state.userId)) {
                            this.blindadoActivatedUsers.add(state.userId);

                            this.saveTitanLog(state.userId, this.symbol, 'info',
                                `ℹ️🛡️Stop Blindado: Ativado | Lucro atual $${profitPeak.toFixed(2)} | Protegendo 50%: $${protectedAmount.toFixed(2)}`);

                            // Emit event for frontend
                            this.tradeEvents.emit({
                                userId: state.userId,
                                type: 'blindado_activated',
                                strategy: 'titan',
                                profitPeak,
                                protectedAmount
                            });
                        }

                        // ✅ Log de progresso ANTES de ativar (quando lucro < 40% da meta)
                        if (!this.blindadoActivatedUsers.has(state.userId) && lucroAtual > 0 && lucroAtual < (profitTarget * 0.40)) {
                            const activationTrigger = profitTarget * 0.40;
                            const percentualProgresso = (lucroAtual / activationTrigger) * 100;
                            this.saveTitanLog(state.userId, this.symbol, 'info',
                                `ℹ️🛡️ Stop Blindado: Lucro $${lucroAtual.toFixed(2)} | Meta ativação: $${activationTrigger.toFixed(2)} (${percentualProgresso.toFixed(1)}%)`);
                        }

                        // Log profit peak update (if already activated and peak increased)
                        if (this.blindadoActivatedUsers.has(state.userId) && lucroAtual > (parseFloat(config.profit_peak) || 0)) {
                            this.saveTitanLog(state.userId, this.symbol, 'info',
                                `ℹ️🛡️Stop Blindado: Ativado | Lucro atual $${profitPeak.toFixed(2)} | Protegendo 50%: $${protectedAmount.toFixed(2)}`);
                        }

                        // Check if capital fell below protected level -> TRIGGER BLINDADO
                        if (capitalSessao <= stopBlindado) {
                            const lucroProtegido = capitalSessao - capitalInicial;

                            this.logger.warn(
                                `[TITAN][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
                                `Capital Sessão: $${capitalSessao.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | ` +
                                `Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%) - BLOQUEANDO OPERAÇÃO`
                            );

                            this.saveTitanLog(state.userId, this.symbol, 'alerta',
                                `💰✅Stoploss blindado atingido, o sistema parou as operações com um lucro de $${lucroProtegido.toFixed(2)} para proteger o seu capital.`);

                            const deactivationReason =
                                `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
                                `(${stopBlindadoPercent}% do pico de $${profitPeak.toFixed(2)})`;

                            // Deactivate AI
                            await this.dataSource.query(
                                `UPDATE ai_user_config 
                                 SET is_active = 0, session_status = 'stopped_blindado', 
                                     deactivation_reason = ?, deactivated_at = NOW()
                                 WHERE user_id = ? AND is_active = 1`,
                                [deactivationReason, state.userId]
                            );

                            // Emit event for frontend modal
                            this.tradeEvents.emit({
                                userId: state.userId,
                                type: 'stopped_blindado',
                                strategy: 'titan',
                                profitProtected: lucroProtegido
                            });

                            // Deactivate user
                            await this.deactivateUser(state.userId);
                            return; // NÃO EXECUTAR OPERAÇÃO
                        }
                    }
                }
            }
        } catch (error) {
            this.logger.error(`[TITAN][${state.userId}] Erro ao verificar Stop Loss Blindado:`, error);
            // Continue even if there's an error (fail-open)
        }

        // ⚔️ Log: Persistência antes da entrada (se ativo)
        if (riskManager.consecutiveLosses > 0 && state.lastDirection !== null) {
            const stakeIndicator = riskManager.consecutiveLosses > 1 ? ' - Martingale' : '';
            this.saveTitanLog(state.userId, this.symbol, 'sinal',
                `⚔️ [PERSISTÊNCIA] Recuperação ativa (${riskManager.consecutiveLosses}x Loss).\n• Mantendo direção anterior: ${direction} 🔒 (Stake: $${stake.toFixed(2)}${stakeIndicator})`);
        }

        // ⚔️ Log: Entrada Confirmada
        let stakeIndicator = '';
        if (state.sorosActive && state.vitoriasConsecutivas > 0) {
            stakeIndicator = ' - SOROS';
        } else if (riskManager.consecutiveLosses > 0) {
            stakeIndicator = ' - Martingale';
        }

        const directionDisplay = direction === 'PAR' ? 'EVEN' : 'ODD';
        this.saveTitanLog(state.userId, this.symbol, 'sinal',
            `⚔️ [TITAN] Entrada Confirmada: ${directionDisplay} (Stake: $${stake.toFixed(2)}${stakeIndicator})`);

        state.isOperationActive = true;
        try {
            const currentPrice = this.ticks[this.ticks.length - 1].value;
            const tradeId = await this.createTradeRecord(state, direction, stake, currentPrice);

            const result = await this.executeTradeViaWebSocket(state.derivToken, {
                contract_type: direction === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
                amount: stake,
                currency: state.currency,
            }, state.userId);

            if (result) {
                const previousConsecutiveLosses = riskManager.consecutiveLosses;
                riskManager.updateResult(result.profit, stake);
                state.capital += result.profit;
                state.ultimoLucro = result.profit;

                // ✅ Atualizar session_balance no banco de dados para sincronia com o frontend e RiskManager
                const lucroSessao = state.capital - state.capitalInicial;
                await this.dataSource.query(
                    `UPDATE ai_user_config SET session_balance = ? WHERE user_id = ? AND is_active = 1`,
                    [lucroSessao, state.userId]
                ).catch(err => this.logger.error(`[TITAN] Erro ao atualizar session_balance:`, err));

                const status = result.profit >= 0 ? 'WON' : 'LOST';
                const previousWins = state.vitoriasConsecutivas;

                // ✅ FIX: Se venceu uma operação de recuperação (Martingale), reseta o ciclo 
                // para não ativar Soros com o lucro alto da recuperação.
                if (status === 'WON') {
                    if (previousConsecutiveLosses > 0) {
                        state.vitoriasConsecutivas = 0; // Reset total após recuperação
                    } else {
                        state.vitoriasConsecutivas++;
                    }
                } else {
                    state.vitoriasConsecutivas = 0;
                }

                // Extract exit digit from result
                const exitDigit = result.exitSpot ? result.exitSpot.toString().slice(-1) : '?';
                const resultType = direction === 'PAR' ? 'PAR' : 'ÍMPAR';

                // 📊 Log: Resultado Detalhado
                if (status === 'WON') {
                    this.saveTitanLog(state.userId, this.symbol, 'resultado',
                        `✅ [WIN] Resultado: ${resultType} (${exitDigit}). Lucro: +$${result.profit.toFixed(2)}\n• Saldo Atual: $${state.capital.toFixed(2)}`);

                    // Soros Logic
                    if (state.vitoriasConsecutivas === 1 && !state.sorosActive) {
                        // First win, activate Soros
                        state.sorosActive = true;
                        state.sorosStake = state.apostaInicial + result.profit;
                        this.saveTitanLog(state.userId, this.symbol, 'info',
                            `🚀 [SOROS] Ativado! Próxima entrada potencializada: $${state.sorosStake.toFixed(2)}`);
                    } else if (state.vitoriasConsecutivas >= 2 && state.sorosActive) {
                        // Soros cycle completed (won with Soros stake)
                        state.sorosActive = false;
                        state.sorosStake = 0;
                        state.vitoriasConsecutivas = 0; // ✅ RESET PARA REINICIAR CICLO SOROS
                        this.saveTitanLog(state.userId, this.symbol, 'info',
                            `🔄 [SOROS] Ciclo Nível 1 Concluído. Retornando à Stake Base ($${state.apostaInicial.toFixed(2)}).`);
                    }

                    // Recuperação completa
                    if (previousConsecutiveLosses > 0) {
                        this.saveTitanLog(state.userId, this.symbol, 'info',
                            `✅ [RECUPERAÇÃO] Ciclo zerado. Retornando ao modo original (${state.originalMode}).`);
                    }
                } else {
                    this.saveTitanLog(state.userId, this.symbol, 'resultado',
                        `📉 [LOSS] Perda de $${Math.abs(result.profit).toFixed(2)}. Iniciando/Continuando Recuperação.`);

                    // Reset Soros on loss
                    if (state.sorosActive) {
                        state.sorosActive = false;
                        state.sorosStake = 0;
                    }
                }

                await this.dataSource.query(`UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`, [status, result.profit, result.exitSpot, tradeId]);

                // ✅ COPY TRADING: Atualizar resultado para copiadores (assíncrono, não bloqueia)
                if (this.copyTradingService) {
                    const tradeData = await this.dataSource.query(
                        `SELECT user_id, contract_id, stake_amount FROM ai_trades WHERE id = ?`,
                        [tradeId]
                    );

                    if (tradeData && tradeData.length > 0) {
                        const trade = tradeData[0];
                        const contractId = trade.contract_id || result.contractId;

                        if (contractId) {
                            this.copyTradingService.updateCopyTradingOperationsResult(
                                trade.user_id,
                                contractId,
                                status === 'WON' ? 'win' : 'loss',
                                result.profit,
                                parseFloat(trade.stake_amount) || 0,
                            ).catch((error: any) => {
                                this.logger.error(`[Titan][CopyTrading] Erro ao atualizar copiadores: ${error.message}`);
                            });
                        }
                    }
                }

                this.tradeEvents.emit({ userId: state.userId, type: 'updated', tradeId, status, strategy: 'titan', profitLoss: result.profit });
            } else {
                // Se falhou ao executar, marcar como falha ou remover o trade pendente
                this.logger.warn(`[TITAN][${state.userId}] Trade ${tradeId} falhou na execução.`);
                await this.dataSource.query(`UPDATE ai_trades SET status = 'ERROR' WHERE id = ?`, [tradeId]);
            }
        } catch (e) {
            this.logger.error(`[TITAN][ERR] ${e.message}`);
        } finally {
            state.isOperationActive = false;
        }
    }

    private async createTradeRecord(state: TitanUserState, direction: DigitParity, stake: number, entryPrice: number): Promise<number> {
        const analysisData = { strategy: 'titan', mode: state.mode, direction };
        const r = await this.dataSource.query(
            `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, contract_type, created_at, analysis_data, symbol, gemini_duration)
       VALUES (?, ?, ?, ?, 'PENDING', ?, NOW(), ?, ?, ?)`,
            [state.userId, direction, entryPrice, stake, direction === 'PAR' ? 'DIGITEVEN' : 'DIGITODD', JSON.stringify(analysisData), this.symbol, 1]
        );
        const tradeId = r.insertId || r[0]?.insertId;

        // ✅ COPY TRADING: Replicar operação para copiadores (assíncrono, não bloqueia)
        if (tradeId && this.copyTradingService) {
            this.copyTradingService.replicateAIOperation(
                state.userId,
                {
                    tradeId: tradeId,
                    contractId: '',
                    contractType: direction === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
                    symbol: this.symbol,
                    duration: 1,
                    stakeAmount: stake,
                    entrySpot: entryPrice,
                    entryTime: Math.floor(Date.now() / 1000),
                }
            ).catch(error => {
                this.logger.error(`[Titan][CopyTrading] Erro ao replicar operação: ${error.message}`);
            });
        }

        return tradeId;
    }

    /**
     * ✅ TITAN: Executa trade via WebSocket REUTILIZÁVEL (pool por token) E monitora resultado
     */
    private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<any> {
        try {
            // ✅ PASSO 1: Obter ou criar conexão WebSocket reutilizável
            const connection = await this.getOrCreateWebSocketConnection(token, userId);

            // ✅ PASSO 2: Solicitar proposta
            const proposalStartTime = Date.now();
            this.logger.debug(`[TITAN] 📤 [${userId || 'SYSTEM'}] Solicitando proposta | Tipo: ${params.contract_type} | Valor: $${params.amount}`);

            const proposalResponse: any = await connection.sendRequest({
                proposal: 1,
                amount: params.amount,
                basis: 'stake',
                contract_type: params.contract_type,
                currency: params.currency || 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.symbol,
            }, 60000);

            if (proposalResponse.error) {
                const errorMsg = proposalResponse.error.message || JSON.stringify(proposalResponse.error);
                this.logger.error(`[TITAN] ❌ Erro na proposta: ${errorMsg}`);
                if (userId) this.saveTitanLog(userId, this.symbol, 'erro', `❌ Erro na proposta: ${errorMsg}`);
                return null;
            }

            const proposalId = proposalResponse.proposal?.id;
            const proposalPrice = Number(proposalResponse.proposal?.ask_price);

            if (!proposalId) return null;

            const buyStartTime = Date.now();
            this.logger.debug(`[TITAN] 💰 [${userId || 'SYSTEM'}] Comprando contrato | ProposalId: ${proposalId}`);

            // ✅ PASSO 3: Comprar contrato
            let buyResponse: any;
            try {
                buyResponse = await connection.sendRequest({
                    buy: proposalId,
                    price: proposalPrice
                }, 60000);
            } catch (error: any) {
                const errorMessage = error?.message || JSON.stringify(error);
                this.logger.error(`[TITAN] ❌ Erro ao comprar contrato: ${errorMessage}`);
                if (userId) this.saveTitanLog(userId, this.symbol, 'erro', `❌ Erro ao comprar contrato: ${errorMessage}`);
                return null;
            }

            if (buyResponse.error) {
                const errorMsg = buyResponse.error.message || JSON.stringify(buyResponse.error);
                this.logger.error(`[TITAN] ❌ Erro na compra: ${errorMsg}`);
                if (userId) this.saveTitanLog(userId, this.symbol, 'erro', `❌ Erro na compra: ${errorMsg}`);
                return null;
            }

            const contractId = buyResponse.buy?.contract_id;
            if (!contractId) return null;

            this.logger.log(`[TITAN] ✅ [${userId || 'SYSTEM'}] Contrato criado | ContractId: ${contractId}`);
            if (userId) this.saveTitanLog(userId, this.symbol, 'operacao', `✅ Contrato criado: ${contractId}`);

            // ✅ PASSO 4: Monitorar contrato
            return new Promise((resolve) => {
                let hasResolved = false;
                const timeout = setTimeout(() => {
                    if (!hasResolved) {
                        hasResolved = true;
                        connection.removeSubscription(contractId);
                        resolve(null);
                    }
                }, 90000);

                connection.subscribe(
                    { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
                    (msg: any) => {
                        if (msg.error) {
                            if (!hasResolved) {
                                hasResolved = true;
                                clearTimeout(timeout);
                                connection.removeSubscription(contractId);
                                resolve(null);
                            }
                            return;
                        }

                        const c = msg.proposal_open_contract;
                        if (c && c.is_sold) {
                            if (!hasResolved) {
                                hasResolved = true;
                                clearTimeout(timeout);
                                connection.removeSubscription(contractId);
                                const profit = Number(c.profit);
                                const exitSpot = c.exit_tick;
                                this.logger.log(`[TITAN] ✅ Resultado: $${profit}`);
                                if (userId) this.saveTitanLog(userId, this.symbol, 'resultado', `✅ Resultado: $${profit}`);
                                resolve({ contractId: c.contract_id, profit, exitSpot });
                            }
                        }
                    },
                    contractId
                ).catch(() => {
                    if (!hasResolved) {
                        hasResolved = true;
                        clearTimeout(timeout);
                        resolve(null);
                    }
                });
            });

        } catch (error) {
            this.logger.error(`[TITAN] ❌ Erro ao executar trade via WS: ${error.message}`);
            return null;
        }
    }

    /**
     * ✅ Obtém ou cria conexão WebSocket reutilizável por token
     */
    private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
        ws: WebSocket;
        sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
        subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
        removeSubscription: (subId: string) => void;
    }> {
        const existing = this.wsConnections.get(token);

        if (existing) {
            if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
                return {
                    ws: existing.ws,
                    sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
                    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
                        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
                    removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
                };
            } else {
                if (existing.keepAliveInterval) clearInterval(existing.keepAliveInterval);
                existing.ws.close();
                this.wsConnections.delete(token);
            }
        }

        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        const ws = await new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });
            let authResolved = false;

            const connectionTimeout = setTimeout(() => {
                if (!authResolved) {
                    socket.close();
                    this.wsConnections.delete(token);
                    reject(new Error('Timeout ao conectar (20s)'));
                }
            }, 20000);

            socket.on('message', (data: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) return;

                    const conn = this.wsConnections.get(token);
                    if (!conn) return;

                    if (msg.msg_type === 'authorize' && !authResolved) {
                        authResolved = true;
                        clearTimeout(connectionTimeout);

                        if (msg.error) {
                            socket.close();
                            this.wsConnections.delete(token);
                            reject(new Error(msg.error.message));
                            return;
                        }

                        conn.authorized = true;
                        conn.keepAliveInterval = setInterval(() => {
                            if (socket.readyState === WebSocket.OPEN) {
                                try { socket.send(JSON.stringify({ ping: 1 })); } catch (e) { }
                            }
                        }, 90000);

                        resolve(socket);
                        return;
                    }

                    if (msg.proposal_open_contract) {
                        const contractId = msg.proposal_open_contract.contract_id;
                        if (contractId && conn.subscriptions.has(contractId)) {
                            conn.subscriptions.get(contractId)!(msg);
                            return;
                        }
                    }

                    if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
                        const firstKey = conn.pendingRequests.keys().next().value;
                        if (firstKey) {
                            const pending = conn.pendingRequests.get(firstKey);
                            if (pending) {
                                clearTimeout(pending.timeout);
                                conn.pendingRequests.delete(firstKey);
                                if (msg.error) pending.reject(new Error(msg.error.message));
                                else pending.resolve(msg);
                            }
                        }
                    }
                } catch (e) { }
            });

            socket.on('open', () => {
                const conn = {
                    ws: socket,
                    authorized: false,
                    keepAliveInterval: null,
                    requestIdCounter: 0,
                    pendingRequests: new Map(),
                    subscriptions: new Map(),
                };
                this.wsConnections.set(token, conn);
                socket.send(JSON.stringify({ authorize: token }));
            });

            socket.on('error', (err) => {
                if (!authResolved) {
                    clearTimeout(connectionTimeout);
                    authResolved = true;
                    this.wsConnections.delete(token);
                    reject(err);
                }
            });

            socket.on('close', () => {
                const conn = this.wsConnections.get(token);
                if (conn) {
                    if (conn.keepAliveInterval) clearInterval(conn.keepAliveInterval);
                    conn.pendingRequests.forEach(p => { clearTimeout(p.timeout); p.reject(new Error('WS closed')); });
                    conn.subscriptions.clear();
                }
                this.wsConnections.delete(token);
                if (!authResolved) {
                    clearTimeout(connectionTimeout);
                    reject(new Error('WS closed before auth'));
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

    private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
        const conn = this.wsConnections.get(token);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
            throw new Error('Conexão WebSocket indisponível');
        }

        return new Promise((resolve, reject) => {
            const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
            const timeout = setTimeout(() => {
                conn.pendingRequests.delete(requestId);
                reject(new Error(`Timeout ${timeoutMs}ms`));
            }, timeoutMs);
            conn.pendingRequests.set(requestId, { resolve, reject, timeout });
            conn.ws.send(JSON.stringify(payload));
        });
    }

    private async subscribeViaConnection(token: string, payload: any, callback: (msg: any) => void, subId: string, timeoutMs: number): Promise<void> {
        const conn = this.wsConnections.get(token);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
            throw new Error('Conexão WebSocket indisponível');
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
                        reject(new Error(msg.error.message));
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

    private removeSubscriptionFromConnection(token: string, subId: string): void {
        const conn = this.wsConnections.get(token);
        if (conn) conn.subscriptions.delete(subId);
    }

    /**
     * ✅ TITAN: Sistema de Logs Detalhados
     */
    private saveTitanLog(
        userId: string,
        symbol: string,
        type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro',
        message: string,
        details?: any,
    ): void {
        if (!userId || !type || !message || message.trim() === '') return;

        const symbolToUse = symbol === 'SISTEMA' ? 'SISTEMA' : this.symbol;
        this.logQueue.push({ userId, symbol: symbolToUse, type, message, details });
        this.processTitanLogQueue().catch(error => {
            this.logger.error(`[TITAN][SaveLog] Erro ao processar fila de logs:`, error);
        });
    }

    private async processTitanLogQueue(): Promise<void> {
        if (this.logProcessing || this.logQueue.length === 0) return;
        this.logProcessing = true;

        try {
            const batch = this.logQueue.splice(0, 50);
            if (batch.length === 0) {
                this.logProcessing = false;
                return;
            }

            const logsByUser = new Map<string, typeof batch>();
            for (const log of batch) {
                if (!logsByUser.has(log.userId)) logsByUser.set(log.userId, []);
                logsByUser.get(log.userId)!.push(log);
            }

            for (const [userId, logs] of logsByUser.entries()) {
                await this.saveTitanLogsBatch(userId, logs);
            }
        } catch (error) {
            this.logger.error(`[TITAN][ProcessLogQueue] Erro ao processar logs:`, error);
        } finally {
            this.logProcessing = false;
            if (this.logQueue.length > 0) {
                setTimeout(() => this.processTitanLogQueue(), 0);
            }
        }
    }

    private async saveTitanLogsBatch(userId: string, logs: typeof this.logQueue): Promise<void> {
        if (logs.length === 0) return;

        try {
            const icons: Record<string, string> = {
                'info': 'ℹ️', 'tick': '📊', 'analise': '🔍', 'sinal': '🎯',
                'operacao': '⚡', 'resultado': '💰', 'alerta': '⚠️', 'erro': '❌',
            };

            const placeholders = logs.map(() => '(?, ?, ?, ?, ?, NOW())').join(', ');
            const flatValues: any[] = [];

            for (const log of logs) {
                const icon = icons[log.type] || 'ℹ️';
                const detailsJson = log.details ? JSON.stringify(log.details) : JSON.stringify({ symbol: log.symbol });
                flatValues.push(userId, log.type, icon, log.message, detailsJson);
            }

            await this.dataSource.query(
                `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES ${placeholders}`,
                flatValues,
            );

            this.tradeEvents.emit({ userId, type: 'updated', strategy: 'titan', status: 'LOG' });
        } catch (error) {
            this.logger.error(`[TITAN][SaveLogsBatch][${userId}] Erro ao salvar logs:`, error);
        }
    }
}
