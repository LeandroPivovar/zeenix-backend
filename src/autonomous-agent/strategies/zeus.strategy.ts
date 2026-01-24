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
import { Tick } from '../../ai/ai.service';
import { LogQueueService } from '../../utils/log-queue.service';

/**
 * ⚡ ZEUS Strategy v4.0
 */

interface ZeusUserConfig {
    userId: string;
    initialStake: number;
    dailyProfitTarget: number;
    dailyLossLimit: number;
    derivToken: string;
    currency: string;
    symbol: string;
    initialBalance: number;
    riskProfile: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
    stopLossType: 'normal' | 'blindado';
}

interface ZeusUserState extends AutonomousAgentState {
    // Financial State (Inherited: currentProfit, currentLoss)
    saldoInicial: number;
    lucroAtual: number;
    picoLucro: number;

    // Strategy State
    consecutiveLosses: number;
    consecutiveWins: number;
    martingaleLevel: number;
    totalLossAccumulated: number;

    // Trade Control
    isWaitingContract: boolean;
    currentContractId: string | null;
    currentTradeId: number | null;
    lastContractType?: string;

    // History
    lastDigits: number[];
    lastPrices: number[];

    // Stop Blindado
    stopBlindadoAtivo: boolean;
    pisoBlindado: number;

    // Stats (Inherited: operationsCount)
    opsCount: number;
}

const ZEUS_V4_CONFIG = {
    SYMBOL: 'R_100',
    DIGIT_TARGET: 3,
    PAYOUT_M0: 0.56,
    PAYOUT_M1: 0.85,
    FILTERS: {
        PATTERN_WINDOW: 6,
        PATTERN_THRESHOLD: 5,
        CONSECUTIVE_MIN: 2,
        MOMENTUM_WINDOW: 10,
        MOMENTUM_THRESHOLD: 6,
        VOLATILITY_WINDOW: 6,
        UNIQUE_DIGITS_MIN: 3
    }
};

const RISK_PROFILES = {
    CONSERVADOR: { id: 'CONSERVADOR', maxRecovery: 5, profitTargetPct: 0.00 },
    MODERADO: { id: 'MODERADO', maxRecovery: 100, profitTargetPct: 0.15 },
    AGRESSIVO: { id: 'AGRESSIVO', maxRecovery: 100, profitTargetPct: 0.30 }
};

@Injectable()
export class ZeusStrategy implements IAutonomousAgentStrategy, OnModuleInit {
    name = 'zeus';
    displayName = '⚡ ZEUS v4.0';
    description = 'Estratégia Probabilística v4.0 (Digit Over + Rise/Fall Recovery)';

    private readonly logger = new Logger(ZeusStrategy.name);
    private readonly userConfigs = new Map<string, ZeusUserConfig>();
    private readonly userStates = new Map<string, ZeusUserState>();
    private readonly ticks = new Map<string, Tick[]>();
    private readonly maxTicks = 200;
    private readonly processingLocks = new Map<string, boolean>();
    private readonly appId = process.env.DERIV_APP_ID || '111346';

    private wsConnections = new Map<string, {
        ws: WebSocket;
        authorized: boolean;
        keepAliveInterval: NodeJS.Timeout | null;
        pendingRequests: Map<string, { resolve: Function, reject: Function }>;
        subscriptions: Map<string, Function>;
    }>();

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @Inject(forwardRef(() => LogQueueService))
        private readonly logQueueService?: LogQueueService,
    ) { }

    async onModuleInit() {
        this.logger.log('⚡ ZEUS Strategy v4.0 Initialized');
        await this.initialize();
    }

    async initialize(): Promise<void> {
        await this.syncActiveUsersFromDb();
    }

    // --- Interface Implementation ---

    async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
        const zeusConfig: ZeusUserConfig = {
            userId: config.userId,
            initialStake: config.initialStake,
            dailyProfitTarget: config.dailyProfitTarget,
            dailyLossLimit: config.dailyLossLimit,
            derivToken: config.derivToken,
            currency: config.currency,
            symbol: ZEUS_V4_CONFIG.SYMBOL,
            initialBalance: config.initialBalance || 0,
            riskProfile: (config as any).riskProfile || 'MODERADO',
            stopLossType: (config as any).stopLossType || 'blindado'
        };

        this.userConfigs.set(userId, zeusConfig);
        if (!this.userStates.has(userId)) this.initializeUserState(userId, zeusConfig);

        await this.syncActiveUsersFromDb();
        this.saveLog(userId, 'INFO', 'SYSTEM', `Zeus v4.0 Activated (${zeusConfig.riskProfile})`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.userConfigs.delete(userId);
        this.userStates.delete(userId);
    }

    isUserActive(userId: string): boolean {
        return this.userConfigs.has(userId);
    }

    async getUserState(userId: string): Promise<AutonomousAgentState | null> {
        return this.userStates.get(userId) || null;
    }

    async resetDailySession(userId: string): Promise<void> {
        const state = this.userStates.get(userId);
        if (state) {
            state.lucroAtual = 0;
            state.picoLucro = 0;
            state.currentProfit = 0;
            state.currentLoss = 0;
            state.stopBlindadoAtivo = false;
            state.pisoBlindado = 0;
            state.isActive = true;
            this.saveLog(userId, 'INFO', 'SYSTEM', 'Sessão diária resetada.');
        }
    }

    async processAgent(userId: string, analysis: MarketAnalysis): Promise<TradeDecision> {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        if (!state || !config) return { action: 'WAIT' };

        const stake = this.calculateStake(state, config);

        const stopCheck = await this.checkStopLoss(userId, state, config, stake);
        if (stopCheck.action === 'STOP') return stopCheck;

        const finalStake = stopCheck.stake !== undefined ? stopCheck.stake : stake;
        if (finalStake < 0.35) return { action: 'STOP', reason: 'Insufficient Margin' };

        return {
            action: 'BUY',
            stake: finalStake,
            contractType: analysis.details?.contractType,
            reason: 'SIGNAL_VALID'
        };
    }

    async onContractFinish(userId: string, result: { win: boolean; profit: number; contractId: string }) {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        if (!state || !config) return;

        state.isWaitingContract = false;
        state.currentContractId = null;

        state.lucroAtual += result.profit;
        state.currentProfit = Math.max(0, state.lucroAtual);
        state.currentLoss = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;
        if (state.lucroAtual < 0) state.totalLossAccumulated += Math.abs(result.profit);

        if (result.win) {
            state.consecutiveWins++;
            state.consecutiveLosses = 0;
            state.martingaleLevel = 0;
            state.totalLossAccumulated = 0;
            state.operationsCount++;
            state.opsCount++;
            this.saveLog(userId, 'SUCCESS', 'WIN', `VITÓRIA! +$${result.profit.toFixed(2)}`);
        } else {
            state.consecutiveWins = 0;
            state.consecutiveLosses++;
            state.martingaleLevel++;
            state.operationsCount++;
            this.saveLog(userId, 'ERROR', 'LOSS', `DERROTA! -$${Math.abs(result.profit).toFixed(2)} [M${state.martingaleLevel}]`);
        }

        if (state.lucroAtual >= config.dailyProfitTarget) this.handleStopCondition(userId, 'TAKE_PROFIT');
        else if (Math.abs(state.currentLoss) >= config.dailyLossLimit) this.handleStopCondition(userId, 'STOP_LOSS');
    }

    // --- Internal Logic ---

    async processTick(tick: Tick, symbol?: string): Promise<void> {
        if (symbol && symbol !== ZEUS_V4_CONFIG.SYMBOL) return;
        const promises = Array.from(this.userConfigs.keys()).map(userId =>
            this.processTickForUser(userId, tick).catch(e => this.logger.error(e))
        );
        await Promise.all(promises);
    }

    private async processTickForUser(userId: string, tick: Tick): Promise<void> {
        const state = this.userStates.get(userId);
        if (!state || !state.isActive) return;
        if (this.processingLocks.get(userId)) return;

        // Histórico
        this.ticks.get(userId)?.push(tick);

        const rawPrice = tick.value.toString();
        const lastDigit = parseInt(rawPrice.charAt(rawPrice.length - 1));
        if (!isNaN(lastDigit)) {
            state.lastDigits.push(lastDigit);
            if (state.lastDigits.length > 50) state.lastDigits.shift();
        }
        state.lastPrices.push(tick.value);
        if (state.lastPrices.length > 50) state.lastPrices.shift();

        if (state.isWaitingContract) return;

        this.processingLocks.set(userId, true);
        try {
            const analysis = await this.analyzeMarket(state);
            if (analysis && analysis.signal) {
                const decision = await this.processAgent(userId, analysis);
                if (decision.action === 'BUY') {
                    await this.executeTrade(userId, decision, analysis);
                } else if (decision.action === 'STOP') {
                    await this.handleStopCondition(userId, decision.reason || 'Stop');
                }
            }
        } finally {
            this.processingLocks.set(userId, false);
        }
    }

    private async analyzeMarket(state: ZeusUserState): Promise<MarketAnalysis | null> {
        const isRecovery = state.consecutiveLosses > 0;

        // M1+
        if (isRecovery) {
            if (state.lastPrices.length < 2) return null;
            const current = state.lastPrices[state.lastPrices.length - 1];
            const prev = state.lastPrices[state.lastPrices.length - 2];
            const signal = current >= prev ? 'CALL' : 'PUT';

            return {
                signal,
                probability: 80,
                payout: ZEUS_V4_CONFIG.PAYOUT_M1,
                confidence: 0.8,
                details: { contractType: 'Rise/Fall', info: `Recovery M${state.martingaleLevel}` }
            };
        }

        // M0
        if (state.lastDigits.length < 10) return null;
        const digits = state.lastDigits;
        const last6 = digits.slice(-6);
        const last10 = digits.slice(-10);

        const patternCount = last6.filter(d => d <= ZEUS_V4_CONFIG.DIGIT_TARGET).length;
        if (patternCount < ZEUS_V4_CONFIG.FILTERS.PATTERN_THRESHOLD) return null;

        const last1 = digits[digits.length - 1];
        const last2 = digits[digits.length - 2];
        if (last1 > ZEUS_V4_CONFIG.DIGIT_TARGET || last2 > ZEUS_V4_CONFIG.DIGIT_TARGET) return null;

        const momCount = last10.filter(d => d <= ZEUS_V4_CONFIG.DIGIT_TARGET).length;
        if (momCount < ZEUS_V4_CONFIG.FILTERS.MOMENTUM_THRESHOLD) return null;

        const unique = new Set(last6).size;
        if (unique < ZEUS_V4_CONFIG.FILTERS.UNIQUE_DIGITS_MIN) return null;

        return {
            signal: 'DIGIT', // Use valid signal from common.types
            probability: 95,
            payout: ZEUS_V4_CONFIG.PAYOUT_M0,
            confidence: 0.95,
            details: { contractType: 'DIGITOVER', info: 'Zeus v4 Filters Passed' }
        };
    }

    private calculateStake(state: ZeusUserState, config: ZeusUserConfig): number {
        if (state.consecutiveLosses === 0) return config.initialStake;

        // Recuperação
        // Use Type Assertion if direct access flags error, but we fixed RISK_PROFILES structure so it should be fine.
        const profileKey = config.riskProfile || 'MODERADO';
        const profile = RISK_PROFILES[profileKey];

        if (profile.id === 'CONSERVADOR' && state.consecutiveLosses >= profile.maxRecovery) {
            return config.initialStake;
        }

        const payout = ZEUS_V4_CONFIG.PAYOUT_M1;
        const loss = state.totalLossAccumulated;
        const targetProfit = config.initialStake * profile.profitTargetPct;
        const nextStake = (loss + targetProfit) / payout;

        return Math.round(nextStake * 100) / 100;
    }

    private async checkStopLoss(userId: string, state: ZeusUserState, config: ZeusUserConfig, nextStake: number): Promise<TradeDecision> {
        const currentDrawdown = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;

        // Stop Loss
        if (currentDrawdown + nextStake > config.dailyLossLimit) {
            const remaining = config.dailyLossLimit - currentDrawdown;
            if (remaining < 0.35) return { action: 'STOP', reason: 'Daily Stop Loss' };
            return { action: 'BUY', stake: remaining };
        }

        // Blindado
        if (config.stopLossType === 'blindado') {
            const activation = config.dailyProfitTarget * 0.40;
            if (!state.stopBlindadoAtivo && state.lucroAtual >= activation) {
                state.stopBlindadoAtivo = true;
                state.picoLucro = state.lucroAtual;
                state.pisoBlindado = state.picoLucro * 0.50;
                this.saveLog(userId, 'INFO', 'RISK', `🛡️ Stop Blindado Activated @ $${state.pisoBlindado.toFixed(2)}`);
            }
            if (state.stopBlindadoAtivo) {
                if (state.lucroAtual > state.picoLucro) {
                    state.picoLucro = state.lucroAtual;
                    state.pisoBlindado = state.picoLucro * 0.50;
                }
                if (state.lucroAtual <= state.pisoBlindado) {
                    return { action: 'STOP', reason: 'Stop Loss Blindado' };
                }
            }
        }
        return { action: 'BUY', stake: nextStake };
    }

    private async executeTrade(userId: string, decision: TradeDecision, analysis: MarketAnalysis) {
        const state = this.userStates.get(userId);
        const config = this.userConfigs.get(userId);
        if (!state || !config || !decision.stake) return;

        state.isWaitingContract = true;
        const contractType = decision.contractType || (analysis.signal === 'DIGIT' ? 'DIGITOVER' : analysis.signal || 'CALL');
        const duration = 1;
        const barrier = contractType === 'DIGITOVER' ? String(ZEUS_V4_CONFIG.DIGIT_TARGET) : undefined;

        this.saveLog(userId, 'INFO', 'TRADE', `Placing ${contractType} | $${decision.stake.toFixed(2)}`);

        try {
            const contractId = await this.buyContract(userId, config.derivToken, contractType, config.symbol, decision.stake, duration, barrier);
            if (contractId) {
                state.currentContractId = contractId;
            } else {
                state.isWaitingContract = false;
                this.saveLog(userId, 'ERROR', 'TRADE', 'Failed to buy contract');
            }
        } catch (e) {
            state.isWaitingContract = false;
            this.logger.error(`[Zeus] Execute Error: ${e}`);
        }
    }

    private async buyContract(userId: string, token: string, type: string, symbol: string, stake: number, duration: number, barrier?: string): Promise<string | null> {
        try {
            const conn = await this.getSocket(token);
            const propRes = await this.sendRequest(conn, {
                proposal: 1, amount: stake, basis: 'stake',
                contract_type: type, currency: 'USD',
                duration: duration, duration_unit: 't',
                symbol: symbol, barrier: barrier
            });
            if (propRes.error) throw new Error(propRes.error.message);

            const buyRes = await this.sendRequest(conn, { buy: propRes.proposal.id, price: Number(propRes.proposal.ask_price) });
            if (buyRes.error) throw new Error(buyRes.error.message);

            const contractId = buyRes.buy.contract_id;

            // Subscribe
            conn.ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
            conn.subscriptions.set(contractId.toString(), (msg: any) => this.handleContractUpdate(userId, contractId, msg));

            return contractId;
        } catch (e: any) {
            this.logger.error(`[Zeus] API Error: ${e.message}`);
            return null;
        }
    }

    private handleContractUpdate(userId: string, contractId: string, msg: any) {
        if (msg.error) return;
        const contract = msg.proposal_open_contract;
        if (!contract) return;

        if (contract.is_sold) {
            const profit = Number(contract.profit);
            const win = profit >= 0;
            const conn = this.wsConnections.get(this.userConfigs.get(userId)?.derivToken || '');
            if (conn) {
                conn.ws.send(JSON.stringify({ forget: contract.proposal_open_contract_id || contractId }));
                conn.subscriptions.delete(contractId.toString());
            }
            this.onContractFinish(userId, { win, profit, contractId });
        }
    }

    private async handleStopCondition(userId: string, reason: string) {
        const state = this.userStates.get(userId);
        if (state) state.isActive = false;
        await this.dataSource.query(`UPDATE autonomous_agent_config SET session_status = ?, is_active = FALSE WHERE user_id = ?`, [reason.toLowerCase(), userId]);
        this.saveLog(userId, 'WARN', 'STOP', `STOPPED: ${reason}`);
    }

    private initializeUserState(userId: string, config: ZeusUserConfig): void {
        this.userStates.set(userId, {
            userId,
            isActive: true,
            saldoInicial: config.initialBalance || 0,
            lucroAtual: 0,
            picoLucro: 0,
            currentProfit: 0,
            currentLoss: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            martingaleLevel: 0,
            totalLossAccumulated: 0,
            isWaitingContract: false,
            currentContractId: null,
            currentTradeId: null,
            lastDigits: [],
            lastPrices: [],
            stopBlindadoAtivo: false,
            pisoBlindado: 0,
            opsCount: 0,
            operationsCount: 0
        });
        this.ticks.set(userId, []);
        this.warmUpConnection(config.derivToken).catch(() => { });
    }

    private async syncActiveUsersFromDb(): Promise<void> {
        try {
            const activeUsers = await this.dataSource.query(
                `SELECT c.user_id, c.initial_stake, c.daily_profit_target, c.daily_loss_limit, 
                        c.initial_balance, c.deriv_token, c.currency, u.token_demo, u.token_real, 
                        s.trade_currency
                 FROM autonomous_agent_config c
                 JOIN users u ON c.user_id = u.id
                 LEFT JOIN user_settings s ON c.user_id = s.user_id
                 WHERE c.is_active = TRUE AND c.agent_type = 'Zeus'`
            );
            for (const user of activeUsers) {
                const userId = user.user_id.toString();
                let token = user.deriv_token;
                if (user.trade_currency === 'DEMO') token = user.token_demo || token;
                else token = user.token_real || token;

                const zeusConfig: ZeusUserConfig = {
                    userId,
                    initialStake: parseFloat(user.initial_stake),
                    dailyProfitTarget: parseFloat(user.daily_profit_target),
                    dailyLossLimit: parseFloat(user.daily_loss_limit),
                    derivToken: token,
                    currency: user.currency,
                    symbol: ZEUS_V4_CONFIG.SYMBOL,
                    initialBalance: parseFloat(user.initial_balance) || 0,
                    riskProfile: 'MODERADO',
                    stopLossType: 'blindado'
                };
                this.userConfigs.set(userId, zeusConfig);
                if (!this.userStates.has(userId)) this.initializeUserState(userId, zeusConfig);
            }
        } catch (e) { this.logger.error(e); }
    }

    private saveLog(userId: string, level: any, module: any, message: string) {
        this.logQueueService?.saveLogAsync({
            userId,
            level: level,
            module: module,
            message: message,
            tableName: 'autonomous_agent_logs'
        });
    }

    private async getSocket(token: string) {
        if (this.wsConnections.has(token)) {
            const conn = this.wsConnections.get(token)!;
            if (conn.ws.readyState === WebSocket.OPEN && conn.authorized) return conn;
        }
        return new Promise<any>((resolve, reject) => {
            const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=' + this.appId);
            const pending = new Map<string, { resolve: Function, reject: Function }>();
            const subs = new Map<string, Function>();
            ws.on('open', () => ws.send(JSON.stringify({ authorize: token })));
            ws.on('message', (data: WebSocket.Data) => {
                const msg = JSON.parse(data.toString());
                if (msg.msg_type === 'authorize') {
                    if (msg.error) return reject(new Error(msg.error.message));
                    const connObj = {
                        ws, authorized: true,
                        keepAliveInterval: setInterval(() => ws.send(JSON.stringify({ ping: 1 })), 30000),
                        pendingRequests: pending, subscriptions: subs
                    };
                    this.wsConnections.set(token, connObj);
                    resolve(connObj);
                }
                if (msg.msg_type === 'proposal_open_contract') {
                    const cid = msg.proposal_open_contract?.contract_id;
                    if (cid && subs.has(cid.toString())) subs.get(cid.toString())!(msg);
                }
                if (msg.req_id && pending.has(msg.req_id.toString())) {
                    pending.get(msg.req_id.toString())!.resolve(msg);
                    pending.delete(msg.req_id.toString());
                }
            });
            ws.on('error', (e) => reject(e));
        });
    }

    private async sendRequest(conn: any, req: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const reqId = Math.floor(Math.random() * 1000000);
            req.req_id = reqId;
            conn.pendingRequests.set(reqId.toString(), { resolve, reject });
            conn.ws.send(JSON.stringify(req));
            setTimeout(() => {
                if (conn.pendingRequests.has(reqId.toString())) {
                    conn.pendingRequests.delete(reqId.toString());
                    reject(new Error('Timeout'));
                }
            }, 10000);
        });
    }

    private async warmUpConnection(token: string) {
        try { await this.getSocket(token); } catch { }
    }
}
