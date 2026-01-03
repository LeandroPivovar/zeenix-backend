import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';

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

    calculateStake(
        currentBalance: number,
        baseStake: number,
        lastProfit: number,
        logger?: any,
        vitoriasConsecutivas?: number,
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

        if (this.useBlindado && profitAccumulatedAtPeak >= activationTrigger) {
            this._blindadoActive = true;
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
}

@Injectable()
export class TitanStrategy implements IStrategy {
    name = 'titan';
    private readonly logger = new Logger(TitanStrategy.name);
    private users = new Map<string, TitanUserState>();
    private riskManagers = new Map<string, RiskManager>();
    private ticks: Tick[] = [];
    private symbol = 'R_100';
    private appId = 65543;

    private wsConnections = new Map<string, any>();

    constructor(
        private dataSource: DataSource,
        private tradeEvents: TradeEventsService,
    ) { }

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
        if (riskManager.consecutiveLosses > 0 && state.lastDirection !== null) {
            this.logger.log(`[TITAN][PERSISTÊNCIA] Recuperação ativa (${riskManager.consecutiveLosses}x Loss). Mantendo: ${state.lastDirection}`);
            return state.lastDirection;
        }

        if (riskManager.consecutiveLosses >= 3) {
            if (state.mode !== 'PRECISO') {
                this.logger.log(`🚨 [TITAN][DEFESA ATIVA] Forçando modo PRECISO.`);
                state.mode = 'PRECISO';
            }
        } else if (riskManager.consecutiveLosses === 0) {
            if (state.mode !== state.originalMode) {
                this.logger.log(`✅ [TITAN][RECUPERAÇÃO] Voltando ao modo ${state.originalMode}.`);
                state.mode = state.originalMode;
            }
        }

        let requiredTicks = state.mode === 'VELOZ' ? 10 : state.mode === 'NORMAL' ? 20 : 50;
        if (state.ticksColetados < requiredTicks) return null;

        const window = this.ticks.slice(-requiredTicks).map(t => t.digit);
        let signal: DigitParity | null = null;

        if (state.mode === 'VELOZ') {
            const evens = window.slice(-10).filter(d => d % 2 === 0).length;
            signal = evens > 5 ? 'PAR' : evens < 5 ? 'IMPAR' : null;
        } else if (state.mode === 'NORMAL') {
            const last3 = window.slice(-3).map(d => d % 2);
            if (last3.every(v => v === 0)) signal = 'PAR';
            else if (last3.every(v => v === 1)) signal = 'IMPAR';
        } else if (state.mode === 'PRECISO') {
            const last5 = window.slice(-5).map(d => d % 2);
            if (last5.every(v => v === 0)) signal = 'PAR';
            else if (last5.every(v => v === 1)) signal = 'IMPAR';
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
            vitoriasConsecutivas: 0, ultimoLucro: 0, ticksColetados: 0
        });

        this.riskManagers.set(userId, new RiskManager(
            stakeAmount, lossLimit || 50, profitTarget || 100,
            modoMartingale.toUpperCase(), stopLossBlindado !== false
        ));
        this.logger.log(`[TITAN] ${userId} ativado em ${titanMode}`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.users.delete(userId);
        this.riskManagers.delete(userId);
    }

    getUserState(userId: string) { return this.users.get(userId); }

    private async executeOperation(state: TitanUserState, direction: DigitParity): Promise<void> {
        const riskManager = this.riskManagers.get(state.userId)!;
        const stake = riskManager.calculateStake(state.capital, state.apostaInicial, state.ultimoLucro, this.logger, state.vitoriasConsecutivas);

        if (stake <= 0) {
            this.logger.warn(`[TITAN][${state.userId}] Stop Loss atingido.`);
            await this.deactivateUser(state.userId);
            await this.dataSource.query(`UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_risk' WHERE user_id = ?`, [state.userId]);
            return;
        }

        state.isOperationActive = true;
        try {
            const currentPrice = this.ticks[this.ticks.length - 1].value;
            const tradeId = await this.createTradeRecord(state, direction, stake, currentPrice);

            this.logger.log(`[TITAN][TRADE] Executando: ${direction} $${stake}`);
            const result = await this.executeTradeViaWebSocket(state.derivToken, {
                contract_type: direction === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
                amount: stake,
                currency: state.currency,
            }, state.userId);

            if (result) {
                riskManager.updateResult(result.profit, stake);
                state.capital += result.profit;
                state.ultimoLucro = result.profit;
                const status = result.profit >= 0 ? 'WON' : 'LOST';
                state.vitoriasConsecutivas = status === 'WON' ? state.vitoriasConsecutivas + 1 : 0;

                await this.dataSource.query(`UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`, [status, result.profit, result.exitSpot, tradeId]);
                this.tradeEvents.emit({ userId: state.userId, type: 'updated', tradeId, status, strategy: 'titan', profitLoss: result.profit });
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
            [state.userId, direction, entryPrice, stake, direction === 'PAR' ? 'DIGITEVEN' : 'DIGITODD', JSON.stringify(analysisData), this.symbol, '1t']
        );
        return r.insertId || r[0]?.insertId;
    }

    private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<any> {
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        return new Promise((resolve) => {
            const ws = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });
            let resolved = false;

            const finish = (result: any) => {
                if (resolved) return;
                resolved = true;
                ws.close();
                resolve(result);
            };

            ws.on('open', () => ws.send(JSON.stringify({ authorize: token })));
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.authorize) {
                    ws.send(JSON.stringify({
                        buy: 1, subscribe: 1, price: params.amount,
                        parameters: {
                            amount: params.amount, basis: 'stake', contract_type: params.contract_type,
                            currency: params.currency, duration: 1, duration_unit: 't', symbol: this.symbol
                        }
                    }));
                }
                if (msg.buy) {
                    const contractId = msg.buy.contract_id;
                    ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
                }
                if (msg.proposal_open_contract) {
                    const c = msg.proposal_open_contract;
                    if (c.is_sold) finish({ contractId: c.contract_id, profit: Number(c.profit), exitSpot: c.exit_tick });
                }
                if (msg.error) {
                    this.logger.error(`[TITAN][WS_ERR] ${msg.error.message}`);
                    finish(null);
                }
            });
            setTimeout(() => finish(null), 20000);
        });
    }
}
