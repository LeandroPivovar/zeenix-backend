import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { CopyTradingService } from '../../copy-trading/copy-trading.service';
import { formatCurrency } from '../../utils/currency.utils';
import { TradeEventsService } from '../trade-events.service';


/**
 * ✅ NEXUS Strategy Master
 * Price Action + Dynamic Barriers + Zenix Pro Standards.
 */

/**
 * ✅ Interface para Conexão WebSocket reutilizável
 */
interface WsConnection {
    ws: WebSocket;
    authorized: boolean;
    keepAliveInterval: NodeJS.Timeout | null;
    requestIdCounter: number;
    pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: any) => void; timeout: NodeJS.Timeout }>;
    subscriptions: Map<string, (msg: any) => void>;
}

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

    getInitialBalance(): number {
        return this.initialBalance;
    }

    getProfitTarget(): number {
        return this.profitTarget;
    }

    getStopLossLimit(): number {
        return this.stopLossLimit;
    }

    get totalLoss(): number {
        return this.totalLossAccumulated;
    }

    calculateStake(
        currentBalance: number,
        baseStake: number,
        lastProfit: number,
        logger?: any,
        vitoriasConsecutivas?: number,
        userId?: string,
        symbol?: string,
        logCallback?: (userId: string, symbol: string, type: any, message: string) => void,
    ): number {
        if (currentBalance > this.maxBalance) {
            this.maxBalance = currentBalance;
        }

        let nextStake = baseStake;
        // ✅ [ZENIX PRO] Payout Dinâmico
        // < 2 perdas: Barrier (Payout ~56%)
        // >= 2 perdas: Rise/Fall (Payout ~85%) - Solicitado pelo usuário
        const PAYOUT_RATE = this.consecutiveLosses >= 2 ? 0.85 : 0.56;

        if (this.consecutiveLosses > 0) {
            if (this.riskMode === 'CONSERVADOR') {
                if (this.consecutiveLosses <= 5) {
                    // Recupera 100% da perda + 2% de lucro
                    nextStake = (this.totalLossAccumulated * 1.02) / PAYOUT_RATE;
                } else {
                    this.consecutiveLosses = 0;
                    this.totalLossAccumulated = 0.0;
                    nextStake = baseStake;
                    if (userId && symbol && logCallback) {
                        logCallback(userId, symbol, 'alerta', `⚠️ LIMITE DE RECUPERAÇÃO ATINGIDO (CONSERVADOR)\n• Ação: Aceitando perda e resetando stake.\n• Próxima Entrada: Valor Inicial ($${baseStake.toFixed(2)})`);
                    }
                }
            } else if (this.riskMode === 'MODERADO') {
                // ✅ Zenix Pro: (TotalLoss * 1.15) / payout (Recupera + 15%)
                const targetRecovery = this.totalLossAccumulated * 1.15;
                nextStake = targetRecovery / PAYOUT_RATE;
            } else if (this.riskMode === 'AGRESSIVO') {
                // ✅ Zenix Pro: (TotalLoss * 1.30) / payout (Recupera + 30%)
                const targetRecovery = this.totalLossAccumulated * 1.30;
                nextStake = targetRecovery / PAYOUT_RATE;
            }
        } else if (this.lastResultWasWin && vitoriasConsecutivas !== undefined && vitoriasConsecutivas > 0 && (vitoriasConsecutivas % 2 !== 0)) {
            nextStake = baseStake + lastProfit;
            if (userId && symbol && logCallback) {
                logCallback(userId, symbol, 'info', `🚀 APLICANDO SOROS NÍVEL 1\n• Lucro Anterior: $${lastProfit.toFixed(2)}\n• Nova Stake (Base + Lucro): $${nextStake.toFixed(2)}`);
            }
        }

        nextStake = Math.round(nextStake * 100) / 100;

        const profitAccumulatedAtPeak = this.maxBalance - this.initialBalance;
        const activationTrigger = this.profitTarget * 0.40;
        let minAllowedBalance = 0.0;

        if (this.useBlindado && profitAccumulatedAtPeak >= activationTrigger && !this._blindadoActive) {
            this._blindadoActive = true;
            if (userId && symbol && logCallback) {
                const fixedProtectedAmount = activationTrigger; // 40% da meta
                logCallback(userId, symbol, 'alerta', `🛡️ Proteção de Lucro: Ativado\n• Lucro Atual: $${profitAccumulatedAtPeak.toFixed(2)}\n• Proteção FIXA: $${fixedProtectedAmount.toFixed(2)} (40% da Meta) garantidos.`);
            }
        }

        // ✅ Log de progresso ANTES de ativar (quando lucro < 40% da meta)
        if (this.useBlindado && !this._blindadoActive && profitAccumulatedAtPeak > 0 && profitAccumulatedAtPeak < activationTrigger) {
            const percentualProgresso = (profitAccumulatedAtPeak / activationTrigger) * 100;
            if (userId && symbol && logCallback) {
                logCallback(userId, symbol, 'info', `🛡️ Proteção de Lucro: $${profitAccumulatedAtPeak.toFixed(2)} | Meta ativação: $${activationTrigger.toFixed(2)} (${percentualProgresso.toFixed(1)}%)`);
            }
        }

        // ✅ Lógica de Proteção de Capital
        // [NEXUS v3.5] Stop Blindado: Preventivo (recalcula ANTES para proteger o piso)
        if (this._blindadoActive) {
            // [NEXUS v3.5] Stop Blindado Fixo: 
            // Ativação: 40% da Meta
            // Piso: 50% do valor de ATIVAÇÃO (Fixo, não sobe)
            const activationPoint = this.profitTarget * 0.40;
            const fixedGuaranteedProfit = activationPoint; // Piso fixo (40% da Meta)
            const guaranteedBalance = this.initialBalance + fixedGuaranteedProfit;
            const potentialBalanceAfterLoss = currentBalance - nextStake;

            if (potentialBalanceAfterLoss < guaranteedBalance) {
                let adjustedStake = currentBalance - guaranteedBalance;
                adjustedStake = Math.round(adjustedStake * 100) / 100;

                if (userId && symbol && logCallback) {
                    logCallback(userId, symbol, 'alerta',
                        `⚠️ AJUSTE DE RISCO (STOP BLINDADO)\n• Stake Calculada: $${nextStake.toFixed(2)}\n• Saldo Restante até Piso: $${(currentBalance - guaranteedBalance).toFixed(2)}\n• Ação: Stake reduzida para $${adjustedStake.toFixed(2)} para proteger o lucro.`
                    );
                }
                nextStake = adjustedStake;
            }
        } else {
            // [NEXUS v3.5] Stop Loss Normal: Preventivo (ajusta antes da trade)
            const minAllowedBalance = this.initialBalance - this.stopLossLimit;
            const potentialBalanceAfterLoss = currentBalance - nextStake;

            if (potentialBalanceAfterLoss < minAllowedBalance) {
                let adjustedStake = currentBalance - minAllowedBalance;
                adjustedStake = Math.round(adjustedStake * 100) / 100;

                if (userId && symbol && logCallback) {
                    logCallback(userId, symbol, 'alerta',
                        `⚠️ AJUSTE DE RISCO (STOP LOSS)\n• Stake Calculada: $${nextStake.toFixed(2)}\n• Saldo Restante até Stop: $${(currentBalance - minAllowedBalance).toFixed(2)}\n• Ação: Stake reduzida para $${adjustedStake.toFixed(2)} para respeitar o Stop Loss.`
                    );
                }
                nextStake = adjustedStake;
            }
        }

        let finalFloor = this.initialBalance;
        if (this._blindadoActive) {
            const activationPoint = this.profitTarget * 0.40;
            finalFloor += activationPoint;
        } else {
            finalFloor -= this.stopLossLimit;
        }

        const maxRisk = currentBalance - finalFloor;

        if (nextStake > maxRisk) {
            nextStake = Math.max(0, maxRisk);
        }

        // ✅ [ZENIX v3.5] ATLAS STYLE: 
        // Se a stake for menor que 0.35, usamos 0.35 para tentar a última operação.
        // Se já estivermos exatamente no piso ou abaixo, retornamos 0 para parar.
        if (currentBalance <= finalFloor) {
            return 0.0;
        }

        if (nextStake < 0.35) {
            nextStake = 0.35;
        }

        return Math.round(nextStake * 100) / 100;
    }
}

interface NexusUserState {
    userId: string;
    derivToken: string;
    currency: string;
    capital: number;
    apostaInicial: number;
    modoMartingale: ModoMartingale;
    mode: 'VELOZ' | 'NORMAL' | 'LENTO';
    originalMode: 'VELOZ' | 'NORMAL' | 'LENTO';
    lastDirection: DigitParity | null;
    isOperationActive: boolean;
    vitoriasConsecutivas: number;
    ultimoLucro: number;
    ticksColetados: number;
    rejectedAnalysisCount: number;
    recovering?: boolean; // ✅ Modo de recuperação ativo
    dynamicBarrier?: number; // ✅ Barreira dinâmica calculada na análise principal
}

@Injectable()
export class NexusStrategy implements IStrategy {
    name = 'nexus';
    private readonly logger = new Logger(NexusStrategy.name);
    private users = new Map<string, NexusUserState>();
    private riskManagers = new Map<string, RiskManager>();
    private ticks: Tick[] = [];
    private symbol = 'R_25'; // ✅ NEXUS: Mercado oficial R_25 (Volatility 25)
    private appId: string;

    private wsConnections: Map<string, WsConnection> = new Map();
    private logQueue: any[] = [];
    private logProcessing = false;

    constructor(
        private dataSource: DataSource,
        private tradeEvents: TradeEventsService,
        private readonly copyTradingService: CopyTradingService,
    ) {
        this.appId = (process as any).env.DERIV_APP_ID || '111346';
    }

    async initialize(): Promise<void> {
        this.logger.log('[NEXUS] Estratégia NEXUS inicializada');
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

    private async processUser(state: NexusUserState): Promise<void> {
        if (state.isOperationActive) return;

        // ✅ [ZENIX v3.5] ATLAS STYLE STOP CHECK (NO INÍCIO DO CICLO)
        const riskManager = this.riskManagers.get(state.userId)!;
        const currentProfit = state.capital - riskManager.getInitialBalance();

        // Check Stop Blindado Floor
        if (riskManager.blindadoActive) {
            const fixedGuaranteedProfit = riskManager.getProfitTarget() * 0.40;
            const protectedFloor = riskManager.getInitialBalance() + fixedGuaranteedProfit;
            if (state.capital <= protectedFloor) {
                this.logger.log(`[NEXUS][${state.userId}] 🛡️ STOP BLINDADO ATINGIDO | Saldo: $${state.capital.toFixed(2)} <= Piso: $${protectedFloor.toFixed(2)}`);
                await this.stopUser(state, 'stopped_blindado');
                return;
            }
        }

        // Check Meta (TP) - Para evitar erro de modal trocado
        const profitTargetLimit = riskManager.getProfitTarget();
        if (profitTargetLimit > 0 && currentProfit >= profitTargetLimit) {
            this.logger.log(`[NEXUS][${state.userId}] 🎯 META ALCANÇADA NO INÍCIO DO CICLO | Lucro: $${currentProfit.toFixed(2)}`);
            await this.stopUser(state, 'stopped_profit');
            return;
        }

        // ✅ [NEXUS COMPATIBILITY] Define Window Size (Spec Oficial)
        // VELOZ: 10 ticks, NORMAL: 20 ticks, PRECISO: 40 ticks
        const windowSize = state.mode === 'VELOZ' ? 10 : (state.mode === 'NORMAL' ? 20 : 40);

        // 1. Coleta de Dados
        if (state.ticksColetados < windowSize) {
            // Log apenas periodicamente (par ou 0)
            if (state.ticksColetados === 0 || state.ticksColetados % 2 === 0) {
                this.logDataCollection(state.userId, {
                    currentCount: state.ticksColetados,
                    targetCount: windowSize,
                    mode: state.mode
                });
            }
            return;
        }

        // 2. Análise de Mercado (Ao atingir janela)
        const message = `ANÁLISE DE MERCADO
• Modo: ${state.mode}
• Janela: ${windowSize} ticks
• Status: Processando padrões...`;
        this.saveNexusLog(state.userId, this.symbol, 'analise', message);

        // 3. Executar Análise
        if (!riskManager) return;

        const result = this.check_signal(state, riskManager);

        if (!result) {
            this.logBlockedEntry(state.userId, 'Padrão não identificado', 'FILTRO');
            // ✅ [ZENIX v3.5] Re-analisar no próximo tick
            state.ticksColetados = windowSize - 1;
            return;
        }

        // Reset ticks ONLY when trade is actually executed or succeeds
        state.ticksColetados = 0;

        // 4. Executar Operação
        await this.executeOperation(state, result);
    }

    private check_signal(state: NexusUserState, riskManager: RiskManager): DigitParity | null {
        // ✅ Python Nexus v2: Entrada Principal (Higher -0.15) + Recuperação (Rise/Fall)

        // 🧩 [NEXUS V3] Lógica de Recuperação Orion/Titan
        // Perda 1 (M0): Contrato Inicial (Rise/Fall) -> Main Logic
        // Perda 2 (M1): Contrato Inicial (Rise/Fall) -> Main Logic (Persistência de Contrato)
        // Perda 3+ (M2+): Troca de Contrato (Higher -0.15) -> Recovery Logic

        const isRecovering = state.recovering || riskManager.consecutiveLosses >= 2;

        if (!isRecovering) {
            // ═══════════════════════════════════════════════════════════════
            // ANÁLISE PRINCIPAL (BARRIER HIGHER/LOWER)
            // ═══════════════════════════════════════════════════════════════

            let windowSize: number;
            let kMove: number;
            let kBarrier: number;
            let minConsecTicks: number;

            if (state.mode === 'VELOZ') {
                windowSize = 10;
                kMove = 1.5;
                kBarrier = 0.8;
                minConsecTicks = 1;
            } else if (state.mode === 'NORMAL') {
                windowSize = 20;
                kMove = 2.2;
                kBarrier = 1.1;
                minConsecTicks = 1;
            } else { // LENTO/PRECISO
                windowSize = 40;
                kMove = 3.0;
                kBarrier = 1.4;
                minConsecTicks = 2;
            }

            // Filtro 1: Dados suficientes
            if (this.ticks.length < windowSize) return null;

            const window = this.ticks.slice(-windowSize);
            const prices = window.map(t => t.value);

            // Filtro 2: Momentum Direcional
            let consecUp = 0;
            let consecDown = 0;

            for (let i = window.length - 1; i > 0; i--) {
                const delta = prices[i] - prices[i - 1];
                if (delta > 0) {
                    consecUp++;
                    if (consecDown > 0) break;
                } else if (delta < 0) {
                    consecDown++;
                    if (consecUp > 0) break;
                } else {
                    break;
                }
            }

            if (consecUp < minConsecTicks && consecDown < minConsecTicks) {
                return null; // Bloqueado
            }

            // Filtro 3: Movimento mínimo normalizado
            const medianAbsDelta = this.calculateMedianAbsDelta(windowSize);
            const move = Math.abs(prices[prices.length - 1] - prices[0]);
            const minMove = medianAbsDelta * kMove;

            if (move < minMove) {
                return null; // Bloqueado
            }

            // Filtro 4: Direção
            const direction = consecUp >= minConsecTicks ? 'CALL' : 'PUT';

            // Cálculo da Barreira Dinâmica
            const minOffset = 0.10; // offset mínimo
            const barrierOffset = Math.max(minOffset, medianAbsDelta * kBarrier);
            const currentPrice = prices[prices.length - 1];

            // Armazenar barreira no state para usar na compra
            state.dynamicBarrier = direction === 'CALL'
                ? currentPrice + barrierOffset
                : currentPrice - barrierOffset;

            // ✅ LOG PADRONIZADO V2: Sinal Gerado
            this.logSignalGenerated(state.userId, {
                mode: state.mode,
                isRecovery: false,
                filters: [
                    `Janela: ${windowSize} ticks`,
                    `Momentum: ${direction === 'CALL' ? consecUp : consecDown} ticks`,
                    `Move: ${move.toFixed(3)} (≥ ${minMove.toFixed(3)})`,
                    `Barreira: ${state.dynamicBarrier.toFixed(2)}`
                ],
                trigger: direction === 'CALL' ? 'Momentum Alta' : 'Momentum Baixa',
                probability: state.mode === 'VELOZ' ? 65 : (state.mode === 'NORMAL' ? 70 : 75),
                contractType: `BARRIER ${direction}`,
                direction: direction
            });

            return direction === 'CALL' ? 'PAR' : 'IMPAR';
        } else {
            // ═══════════════════════════════════════════════════════════════
            // ANÁLISE DE RECUPERAÇÃO (RISE/FALL)
            // ═══════════════════════════════════════════════════════════════

            // Filtro 1: Herança de Modo
            let effectiveMode = state.mode;
            if (effectiveMode === 'VELOZ') {
                effectiveMode = 'NORMAL'; // VELOZ herda NORMAL
            }

            let minConsecTicks: number;
            if (effectiveMode === 'NORMAL') {
                minConsecTicks = 1;
            } else { // PRECISO/LENTO
                minConsecTicks = 2;
            }

            if (this.ticks.length < minConsecTicks + 1) return null;

            const prices = this.ticks.slice(-(minConsecTicks + 1)).map(t => t.value);

            // Filtro 2: Momentum Direcional
            let consecUp = 0;
            let consecDown = 0;

            for (let i = 1; i < prices.length; i++) {
                if (prices[i] > prices[i - 1]) consecUp++;
                else if (prices[i] < prices[i - 1]) consecDown++;
                else break; // Interrompe se houver empate
            }

            if (consecUp < minConsecTicks && consecDown < minConsecTicks) {
                return null;
            }

            const direction = consecUp >= minConsecTicks ? 'CALL' : 'PUT';

            // ✅ LOG PADRONIZADO V2: Sinal Recuperação
            this.logSignalGenerated(state.userId, {
                mode: effectiveMode,
                isRecovery: true,
                filters: [
                    `Modo Efetivo: ${effectiveMode}`,
                    `Momentum: ${direction === 'CALL' ? consecUp : consecDown} ticks consecutivos`
                ],
                trigger: `Recuperação ${direction === 'CALL' ? 'Alta' : 'Baixa'}`,
                probability: effectiveMode === 'NORMAL' ? 70 : 80,
                contractType: 'RISE/FALL',
                direction: direction
            });

            return direction === 'CALL' ? 'PAR' : 'IMPAR';
        }

        return null;
    }

    private calculateSMA(period: number): number {
        if (this.ticks.length < period) return this.ticks[this.ticks.length - 1]?.value || 0;
        const prices = this.ticks.slice(-period).map(t => t.value);
        return prices.reduce((a, b) => a + b, 0) / period;
    }

    private calculateRSI(period: number): number {
        if (this.ticks.length <= period) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = this.ticks.length - period; i < this.ticks.length; i++) {
            const diff = this.ticks[i].value - this.ticks[i - 1].value;
            if (diff >= 0) gains += diff;
            else losses += Math.abs(diff);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * ✅ NEXUS: Calcula mediana de abs(delta) para normalização por volatilidade
     */
    private calculateMedianAbsDelta(windowSize: number): number {
        if (this.ticks.length < windowSize) return 0.01; // fallback mínimo

        const window = this.ticks.slice(-windowSize);
        const deltas: number[] = [];

        for (let i = 1; i < window.length; i++) {
            deltas.push(Math.abs(window[i].value - window[i - 1].value));
        }

        deltas.sort((a, b) => a - b);
        const mid = Math.floor(deltas.length / 2);

        if (deltas.length % 2 === 0) {
            return (deltas[mid - 1] + deltas[mid]) / 2;
        }
        return deltas[mid];
    }

    async activateUser(userId: string, config: any): Promise<void> {
        const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, stopLossBlindado, profitTarget, lossLimit } = config;

        // Mapeamento de Modos (Frontend -> Backend)
        let nexusMode: 'VELOZ' | 'NORMAL' | 'LENTO' = 'VELOZ';
        const inputMode = (mode || '').toUpperCase();

        if (inputMode === 'MODERADO' || inputMode === 'MODERATE' || inputMode === 'BALANCEADO' || inputMode === 'NORMAL') {
            nexusMode = 'NORMAL';
        } else if (inputMode === 'LENTO' || inputMode === 'PRECISO' || inputMode === 'DEVAGAR' || inputMode === 'SLOW') {
            nexusMode = 'LENTO';
        } else {
            nexusMode = 'VELOZ';
        }

        this.users.set(userId, {
            userId, derivToken, currency: currency || 'USD',
            capital: stakeAmount, apostaInicial: entryValue || 0.35,
            modoMartingale: modoMartingale || 'conservador',
            mode: nexusMode,
            originalMode: nexusMode,
            lastDirection: null,
            isOperationActive: false,
            vitoriasConsecutivas: 0, ultimoLucro: 0, ticksColetados: 0,
            rejectedAnalysisCount: 0
        });

        this.riskManagers.set(userId, new RiskManager(
            stakeAmount, lossLimit || 50, profitTarget || 100,
            modoMartingale.toUpperCase(), stopLossBlindado !== false // ✅ Enable blindado based on config
        ));

        this.logger.log(`[NEXUS] ${userId} ativado em ${nexusMode} (Input: ${inputMode})`);

        // ✅ LOG PADRONIZADO V2: Configuração Inicial
        this.logInitialConfigV2(userId, {
            strategyName: 'NEXUS 3.0',
            operationMode: nexusMode,
            riskProfile: modoMartingale.toUpperCase(),
            profitTarget: profitTarget || 0,
            stopLoss: lossLimit || 0,
            stopBlindadoEnabled: stopLossBlindado !== false
        });

        // ✅ LOG PADRONIZADO V2: Início de Sessão
        this.logSessionStart(userId, {
            date: new Date(),
            initialBalance: stakeAmount,
            profitTarget: profitTarget || 0,
            stopLoss: lossLimit || 0,
            mode: nexusMode,
            strategyName: 'NEXUS 3.0'
        });
    }

    async deactivateUser(userId: string): Promise<void> {
        this.users.delete(userId);
        this.riskManagers.delete(userId);
    }

    getUserState(userId: string) { return this.users.get(userId); }

    private async executeOperation(state: NexusUserState, direction: DigitParity): Promise<void> {
        // ✅ [NEXUS] Check limits BEFORE calculating stake or trading
        await this.checkNexusLimits(state.userId);
        if (!this.users.has(state.userId)) return; // User stopped

        const riskManager = this.riskManagers.get(state.userId)!;
        const stake = riskManager.calculateStake(
            state.capital,
            state.apostaInicial,
            state.ultimoLucro,
            this.logger,
            state.vitoriasConsecutivas,
            state.userId,
            this.symbol,
            this.saveNexusLog.bind(this)
        );

        // ✅ [ZENIX v3.4] Check Insufficient Balance
        if (state.capital < stake) {
            this.saveNexusLog(state.userId, this.symbol, 'erro',
                `❌ SALDO INSUFICIENTE! Capital atual ($${state.capital.toFixed(2)}) é menor que o necessário ($${stake.toFixed(2)}) para o stake calculado ($${stake.toFixed(2)}). IA DESATIVADA.`
            );
            await this.stopUser(state, 'stopped_insufficient_balance');
            return;
        }

        // ✅ [FIX FAIL-SAFE] Stop Blindado/Loss via RiskManager
        if (stake <= 0) {
            this.logger.warn(`[NEXUS] ⚠️ Stake calculada = ${stake}. Proteção acionada.`);
            const reason = riskManager.blindadoActive ? 'stopped_blindado' : 'stopped_loss';

            // Tenta parar via stopUser (que deve fazer tudo: Evento, DB, Memória)
            await this.stopUser(state, reason);

            // 🚨 FAIL-SAFE: Se ainda estiver ativo na memória, força desativação
            if (this.users.has(state.userId)) {
                this.logger.warn(`[NEXUS] 💀 stopUser falhou em remover da memória. Forçando parada manual.`);
                await this.deactivateUser(state.userId);
            }
            return;
        }

        let barrier: string | undefined = undefined;

        // 🧩 [NEXUS V3] Lógica de Contratos (Spec Oficial)
        // Main Entry: Barrier definida dinamicamente na análise principal
        // Recovery: Rise/Fall (Sem Barreira)

        if (!state.recovering) {
            // ✅ Entrada Principal: Barrier Dinâmico
            if (state.dynamicBarrier) {
                // Formatar para offset relativo (API Deriv aceita offset +0.xxx ou -0.xxx)
                // Mas aqui dynamicBarrier é o preço ABSOLUTO calculado na análise
                // A API da Deriv para contract_type 'CALL'/'PUT' aceita 'barrier' como valor absoluto ou relativo.
                // Na análise calculamos o preço alvo. Vamos usar o offset relativo para garantir precisão?
                // Spec: "CALL → barrier = preço_atual + barrierOffset"
                // Se o ativo moveu desde a análise, o preço absoluto pode ser perigoso de usar como barrier fixa se o preço atual mudou muito.
                // Mas geralmente usa-se offset. Vamos recalcular o offset relativo baseado no preço ATUAL da execução?
                // Recalculando offset para segurança:
                const entryPrice = this.ticks[this.ticks.length - 1].value;
                const calculatedBarrier = state.dynamicBarrier;

                // Se for CALL, barrier deve ser > entryPrice
                // Se for PUT, barrier deve ser < entryPrice
                // API Deriv: barrier "+0.15" significa spot + 0.15

                let offset = calculatedBarrier - entryPrice;

                // Garantir offset mínimo de segurança
                if (direction === 'PAR') { // CALL
                    if (offset < 0.1) offset = 0.1;
                    barrier = `+${offset.toFixed(3)}`;
                } else { // PUT
                    if (offset > -0.1) offset = -0.1;
                    barrier = `${offset.toFixed(3)}`;
                }
            } else {
                // Fallback seguro se não houver dynamicBarrier (não deve acontecer na principal)
                barrier = direction === 'PAR' ? '+0.10' : '-0.10';
            }
        } else {
            // ✅ Recuperação: Rise/Fall (Sem Barreira)
            barrier = undefined;
        }

        // ✅ [LOG] Início de Entrada (Igual Atlas/Titan)
        const barrierMsg = barrier ? `\n• Barreira: ${barrier}` : '';
        this.saveNexusLog(state.userId, this.symbol, 'operacao',
            `INICIANDO ENTRADA
• Contrato: ${direction === 'PAR' ? 'CALL' : 'PUT'}
• Stake: $${stake.toFixed(2)}${barrierMsg}
• Status: Enviando ordem...`
        );

        state.isOperationActive = true;
        try {
            const currentPrice = this.ticks[this.ticks.length - 1].value;
            const tradeId = await this.createTradeRecord(state, direction, stake, currentPrice, barrier);

            // Removed old "ENTRADA CONFIRMADA" log as it is now detailed in check_signal result

            const result = await this.executeTradeViaWebSocket(state.derivToken, {
                contract_type: direction === 'PAR' ? 'CALL' : 'PUT',
                amount: stake,
                currency: state.currency,
                barrier: barrier
            }, state.userId, async (contractId, entryPrice) => {
                // ✅ [NEXUS] Master Trader Replication - IMMEDIATE (at entry)
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
                                this.symbol,
                                direction === 'PAR' ? 'CALL' : 'PUT', // Mapping Nexus direction
                                barrier ? parseFloat(barrier) : null,
                                stake,
                                percent,
                                0, // multiplier
                                1, // duration (Spec: 1 tick)
                                't', // duration_unit
                                direction === 'PAR' ? 'CALL' : 'PUT',
                                'OPEN',
                            ]
                        );

                        // 2. Chamar serviço de cópia para execução imediata
                        if (this.copyTradingService) {
                            await this.copyTradingService.replicateManualOperation(
                                state.userId,
                                {
                                    contractId: contractId || '',
                                    contractType: direction === 'PAR' ? 'CALL' : 'PUT',
                                    symbol: this.symbol,
                                    duration: 1,
                                    durationUnit: 't',
                                    stakeAmount: stake,
                                    percent: percent,
                                    entrySpot: entryPrice || 0,
                                    entryTime: unixTimestamp,
                                    barrier: barrier ? parseFloat(barrier) : undefined,
                                },
                            );
                        }
                    }
                } catch (repError) {
                    this.logger.error(`[NEXUS] Erro na replicação Master Trader (Entry):`, repError);
                }
            });

            if (result) {
                const wasRecovery = riskManager.consecutiveLosses > 0 || state.recovering;
                riskManager.updateResult(result.profit, stake);
                state.capital += result.profit;
                state.ultimoLucro = result.profit;
                const status = result.profit >= 0 ? 'WON' : 'LOST';

                if (status === 'WON') {
                    if (wasRecovery) {
                        // ✅ LOG PADRONIZADO V2: Recuperação Bem-Sucedida
                        this.logSuccessfulRecoveryV2(state.userId, {
                            recoveredLoss: riskManager.totalLoss,
                            additionalProfit: result.profit,
                            profitPercentage: 0,
                            stakeBase: state.apostaInicial
                        });

                        state.vitoriasConsecutivas = 0;
                        state.mode = 'VELOZ'; // ✅ SPEC: Volta para VELOZ após recuperação
                        state.recovering = false; // ✅ Desativa recuperação
                    } else {
                        state.vitoriasConsecutivas++;
                        // ✅ LOG PADRONIZADO V2: Win Streak / Soros
                        if (state.vitoriasConsecutivas % 2 === 0) {
                            this.logWinStreak(state.userId, {
                                consecutiveWins: state.vitoriasConsecutivas,
                                accumulatedProfit: state.ultimoLucro * 2, // Estimativa
                                currentStake: stake
                            });
                            state.vitoriasConsecutivas = 0;
                        }
                    }

                    // ✅ LOG PADRONIZADO V2: Vitória (Resultado Final)
                    this.logTradeResultV2(state.userId, {
                        status: 'WIN',
                        profit: result.profit,
                        stake: stake,
                        balance: state.capital
                    });
                } else {
                    // ✅ LOG PADRONIZADO V2: Derrota
                    this.logTradeResultV2(state.userId, {
                        status: 'LOSS',
                        profit: -Math.abs(result.profit),
                        stake: stake,
                        balance: state.capital
                    });

                    // ✅ NEXUS SPEC: Ativar recuperação após 2 perdas consecutivas
                    if (riskManager.consecutiveLosses >= 2 && !state.recovering) {
                        state.recovering = true;
                        this.logContractChange(state.userId, {
                            reason: '2 Perdas Consecutivas',
                            oldContract: 'Barrier Higher/Lower',
                            newContract: 'Rise/Fall',
                            analysis: 'Modo Recuperação Ativado'
                        });
                    }

                    // ✅ NEXUS SPEC: Escalada de modo após LOSS na recuperação
                    if (state.recovering && state.mode !== 'LENTO') {
                        const oldMode = state.mode;
                        state.mode = 'LENTO'; // Escala para PRECISO/LENTO
                        this.saveNexusLog(state.userId, this.symbol, 'alerta',
                            `ESCALADA DE MODO NA RECUPERAÇÃO\nTítulo: Modo Ajustado\nModo Anterior: ${oldMode}\nNovo Modo: PRECISO\nMotivo: Loss na recuperação`
                        );
                    }
                }

                await this.dataSource.query(`UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`, [status, result.profit, result.exitSpot, tradeId]);

                this.tradeEvents.emit({ userId: state.userId, type: 'updated', tradeId, status, strategy: 'nexus', profitLoss: result.profit });

                // ✅ [ATLAS LOGIC] Update session_balance AND profit_peak
                const lucroSessao = state.capital - riskManager.getInitialBalance();
                await this.dataSource.query(
                    `UPDATE ai_user_config 
                     SET session_balance = ?, 
                         profit_peak = GREATEST(COALESCE(profit_peak, 0), ?)
                     WHERE user_id = ? AND is_active = 1`,
                    [lucroSessao, lucroSessao, state.userId]
                ).catch(e => this.logger.error(`[NEXUS] Erro ao atualizar session_balance: ${e.message}`));

                // ✅ [ATLAS LOGIC] Check protection limits after updating balance
                await this.checkNexusLimits(state.userId);

                // ✅ [NEXUS] Master Trader Result Update
                try {
                    const userMaster = await this.dataSource.query('SELECT trader_mestre FROM users WHERE id = ?', [state.userId]);
                    if (userMaster && userMaster.length > 0 && userMaster[0].trader_mestre === 1 && this.copyTradingService) {
                        const resMap = result.profit >= 0 ? 'win' : 'loss';
                        await this.copyTradingService.updateCopyTradingOperationsResult(
                            state.userId,
                            result.contractId,
                            resMap,
                            result.profit,
                            stake
                        );
                    }
                } catch (resError) {
                    this.logger.error(`[NEXUS] Erro ao atualizar resultados do Copy Trading:`, resError);
                }


                if (state.ultimoLucro > 0 && (state.capital - riskManager.getInitialBalance()) >= riskManager.getProfitTarget()) {
                    await this.stopUser(state, 'stopped_profit');
                }
            } else {
                await this.dataSource.query(`UPDATE ai_trades SET status = 'ERROR' WHERE id = ?`, [tradeId]);
            }
        } catch (e) {
            this.logger.error(`[NEXUS][ERR] ${e.message}`);
        } finally {
            state.isOperationActive = false;
        }
    }

    private async stopUser(state: NexusUserState, reason: 'stopped_blindado' | 'stopped_loss' | 'stopped_profit' | 'stopped_insufficient_balance') {
        const riskManager = this.riskManagers.get(state.userId);
        if (!riskManager) {
            await this.deactivateUser(state.userId);
            return;
        }

        const initialBalance = riskManager.getInitialBalance();
        const currentBalance = state.capital;
        const profit = currentBalance - initialBalance;
        const profitTarget = riskManager.getProfitTarget();
        const stopLossLimit = riskManager.getStopLossLimit();

        let logMessage = '';
        let logType = 'info';

        switch (reason) {
            case 'stopped_profit':
                logMessage = `🎯 META DE LUCRO ATINGIDA! Lucro: +$${profit.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`;
                logType = 'info';
                break;
            case 'stopped_loss':
                logMessage = `🛑 STOP LOSS ATINGIDO! Perda: $${Math.abs(profit).toFixed(2)} | Limite: $${stopLossLimit.toFixed(2)} - IA DESATIVADA`;
                logType = 'alerta';
                break;
            case 'stopped_blindado':
                logMessage = `🛡️ STOP BLINDADO ATINGIDO!\nStoploss blindado atingido, o sistema parou as operações com um lucro de $${profit.toFixed(2)} para proteger o seu capital.`;
                logType = 'alerta';
                break;
            case 'stopped_insufficient_balance':
                logMessage = `❌ SALDO INSUFICIENTE! Seu saldo atual não é suficiente para realizar novas operações. IA DESATIVADA.`;
                logType = 'erro';
                break;
        }

        // 1. Salvar Log
        this.saveNexusLog(state.userId, this.symbol, logType, logMessage);

        // 2. Emitir Evento (Informa ao frontend para mostrar o modal IMEDIATAMENTE)
        this.tradeEvents.emit({
            userId: state.userId,
            type: reason as any,
            strategy: 'nexus',
            profitLoss: profit
        });

        // 3. Remover da Memória (Pausar execução imediata - ANTES, para evitar loops)
        await this.deactivateUser(state.userId);

        // 4. Atualizar Banco de Dados (ai_user_config)
        // Desativar IA e atualizar session_status para mostrar modal no frontend
        try {
            await this.dataSource.query(
                `UPDATE ai_user_config 
                 SET is_active = 0, 
                     session_status = ?, 
                     deactivation_reason = ?,
                     deactivated_at = NOW()
                 WHERE user_id = ? AND is_active = 1`,
                [reason, logMessage, state.userId]
            );
        } catch (dbError) {
            this.logger.error(`[NEXUS] ⚠️ Erro ao atualizar status '${reason}' no DB: ${dbError.message}.`);
            // Tentativa de fallback se for erro de ENUM
            if (reason === 'stopped_insufficient_balance') {
                try {
                    await this.dataSource.query(
                        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
                         WHERE user_id = ? AND is_active = 1`,
                        [logMessage, state.userId]
                    );
                } catch (e) { console.error('[NEXUS] Falha crítica no fallback DB', e); }
            }
        }

        this.logger.log(`[NEXUS] ${state.userId} parado por ${reason}. Status salvo no banco.`);
    }

    private async createTradeRecord(state: NexusUserState, direction: DigitParity, stake: number, entryPrice: number, barrier?: string): Promise<number> {
        const analysisData = { strategy: 'nexus', mode: state.mode, direction };

        let signalLabel = direction === 'PAR' ? 'CALL' : 'PUT';

        // ✅ [NEXUS] Nomenclatura Personalizada para Histórico
        // Se não tiver barreira (Recuperação), exibe RISE/FALL
        if (!barrier) {
            signalLabel = direction === 'PAR' ? 'RISE' : 'FALL';
        }

        const r = await this.dataSource.query(
            `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, contract_type, created_at, analysis_data, symbol, gemini_duration, strategy)
             VALUES (?, ?, ?, ?, 'PENDING', ?, NOW(), ?, ?, 1, 'nexus')`,
            [state.userId, signalLabel, entryPrice, stake, signalLabel.toUpperCase(), JSON.stringify(analysisData), this.symbol]
        );
        const tradeId = r.insertId || r[0]?.insertId;



        return tradeId;
    }

    private async executeTradeViaWebSocket(
        token: string,
        params: any,
        userId: string,
        onBuy?: (contractId: string, entryPrice: number) => Promise<void>
    ): Promise<{ contractId: string, profit: number, exitSpot: any } | null> {
        try {
            const connection = await this.getOrCreateWebSocketConnection(token, userId);

            const proposalResponse: any = await connection.sendRequest({
                proposal: 1,
                amount: params.amount,
                basis: 'stake',
                contract_type: params.contract_type,
                currency: params.currency || 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.symbol,
                barrier: params.barrier
            }, 60000);

            if (proposalResponse.error) {
                const errorMsg = proposalResponse.error.message || JSON.stringify(proposalResponse.error);
                this.logger.error(`[NEXUS] ❌ Erro na proposta: ${errorMsg}`);
                if (userId) this.saveNexusLog(userId, this.symbol, 'erro', `❌ Erro na proposta: ${errorMsg}`);
                return null;
            }

            const proposalId = proposalResponse.proposal?.id;
            const proposalPrice = Number(proposalResponse.proposal?.ask_price);
            if (!proposalId) return null;

            const buyResponse: any = await connection.sendRequest({
                buy: proposalId,
                price: proposalPrice
            }, 60000);

            if (buyResponse.error) {
                const errorMsg = buyResponse.error.message || JSON.stringify(buyResponse.error);
                this.logger.error(`[NEXUS] ❌ Erro na compra: ${errorMsg}`);
                if (userId) this.saveNexusLog(userId, this.symbol, 'erro', `❌ Erro na compra: ${errorMsg}`);
                return null;
            }

            const contractId = buyResponse.buy?.contract_id;
            if (!contractId) return null;

            // ✅ Chamar callback onBuy IMEDIATAMENTE (Replication)
            if (onBuy) {
                onBuy(contractId, buyResponse.buy.entry_tick || buyResponse.buy.price).catch(err => {
                    this.logger.error(`[NEXUS] Erro no callback onBuy: ${err.message}`);
                });
            }

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
                                resolve({ contractId: c.contract_id, profit: Number(c.profit), exitSpot: c.exit_tick });
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
            this.logger.error(`[NEXUS] ❌ Erro ao executar trade via WS: ${error.message}`);
            return null;
        }
    }

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
                        }, 30000);

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
                } catch (e) { }
            });

            socket.on('open', () => {
                const conn: WsConnection = {
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
                    if (conn.keepAliveInterval) clearInterval(conn.keepAliveInterval as any);
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

        return {
            ws: ws,
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

    // ------------------------------------------------------------------
    // ✅ LOGS PADRONIZADOS ZENIX v2.0 (Helpers)
    // ------------------------------------------------------------------

    private logInitialConfigV2(userId: string, config: {
        strategyName: string;
        operationMode: string;
        riskProfile: string;
        profitTarget: number;
        stopLoss: number;
        stopBlindadoEnabled: boolean;
    }) {
        const message = `CONFIGURAÇÕES INICIAIS
IA: NEXUS 3.0
Modo: ${config.operationMode.toUpperCase()}
Perfil Corretora: ${config.riskProfile.toUpperCase()}
Meta de Lucro: ${config.profitTarget > 0 ? '$' + config.profitTarget.toFixed(2) : 'N/A'}
Limite de Perda: ${config.stopLoss > 0 ? '$' + config.stopLoss.toFixed(2) : 'N/A'}
Stop Blindado: ${config.stopBlindadoEnabled ? 'ATIVADO' : 'DESATIVADO'}`;

        this.saveNexusLog(userId, 'SISTEMA', 'info', message);
    }

    private logSessionStart(userId: string, session: {
        date: Date;
        initialBalance: number;
        profitTarget: number;
        stopLoss: number;
        mode: string;
        strategyName: string;
    }) {
        const message = `INÍCIO DE SESSÃO
Saldo Inicial: $${session.initialBalance.toFixed(2)}
Meta do Dia: $${session.profitTarget.toFixed(2)}
IA Ativa: NEXUS 3.0
Status: Monitorando Mercado`;

        this.saveNexusLog(userId, 'SISTEMA', 'info', message);
    }

    private logDataCollection(userId: string, data: {
        targetCount: number;
        currentCount: number;
        mode?: string;
    }) {
        const message = `COLETA DE DADOS
Coleta de Dados em Andamento
Meta de Coleta: ${data.targetCount} ticks
Progresso: ${data.currentCount} / ${data.targetCount}
Status: aguardando ticks suficientes`;

        this.saveNexusLog(userId, 'SISTEMA', 'info', message);
    }

    private logAnalysisStarted(userId: string, mode: string) {
        const message = `ANÁLISE INICIADA
Análise de Mercado
Tipo de Análise: PRINCIPAL
Modo Ativo: ${mode.toUpperCase()}
Contrato Avaliado: Price Action (1 tick)`;

        this.saveNexusLog(userId, 'SISTEMA', 'analise', message);
    }

    private logSignalGenerated(userId: string, signal: {
        mode: string;
        isRecovery: boolean;
        filters: string[];
        trigger: string;
        probability: number;
        contractType: string;
        direction?: 'CALL' | 'PUT';
    }) {
        const filtersText = signal.filters.map(f => `• ${f}`).join('\n');
        const message = `SINAL DETECTADO
Direção: ${signal.contractType}${signal.direction ? ` (${signal.direction})` : ''}
${filtersText}
Força: ${signal.probability}%
Tipo de Contrato: Price Action`;

        this.saveNexusLog(userId, 'SISTEMA', 'sinal', message);
    }

    private logTradeResultV2(userId: string, result: {
        status: 'WIN' | 'LOSS';
        profit: number;
        stake: number;
        balance: number;
    }) {
        const message = `RESULTADO DA OPERAÇÃO
Status: ${result.status}
Lucro/Perda: $${result.profit >= 0 ? '+' : ''}${result.profit.toFixed(2)}
Saldo Atual: $${result.balance.toFixed(2)}
Estado: Operação Finalizada`;

        this.saveNexusLog(userId, 'SISTEMA', 'resultado', message);
    }

    private logMartingaleLevelV2(userId: string, martingale: {
        level: number;
        lossNumber: number;
        accumulatedLoss: number;
        calculatedStake: number;
        profitPercentage: number;
        contractType: string;
    }) {
        const message = `MARTINGALE NÍVEL ${martingale.level}
Próxima Stake: $${martingale.calculatedStake.toFixed(2)}
Objetivo: Recuperação de Capital
Investimento: Inteligência Artificial
Status: Aguardando Próximo Ciclo`;

        this.saveNexusLog(userId, 'SISTEMA', 'alerta', message);
    }

    private logSorosActivation(userId: string, soros: {
        previousProfit: number;
        stakeBase: number;
        level?: number;
    }) {
        const level = soros.level || 1;
        const newStake = soros.stakeBase + soros.previousProfit;

        const message = `NEXUS | Soros Nível ${level}
• Lucro Anterior: $${soros.previousProfit.toFixed(2)}
• Nova Stake: $${newStake.toFixed(2)}`;

        this.saveNexusLog(userId, 'SISTEMA', 'info', message);
    }

    private logWinStreak(userId: string, streak: {
        consecutiveWins: number;
        accumulatedProfit: number;
        currentStake: number;
    }) {
        const message = `NEXUS | Sequência: ${streak.consecutiveWins} Vitórias
• Lucro Acumulado: $${streak.accumulatedProfit.toFixed(2)}`;

        this.saveNexusLog(userId, 'SISTEMA', 'resultado', message);
    }

    private logSuccessfulRecoveryV2(userId: string, recovery: {
        recoveredLoss: number;
        additionalProfit: number;
        profitPercentage: number;
        stakeBase: number;
    }) {
        const message = `RECUPERAÇÃO CONCLUÍDA
Recuperação Bem-Sucedida
Recuperado: $${recovery.recoveredLoss.toFixed(2)}
Ação: Retornando à Stake Base
Status: Sessão Equilibrada`;

        this.saveNexusLog(userId, 'SISTEMA', 'resultado', message);
    }

    private logContractChange(userId: string, change: {
        reason: string;
        oldContract: string;
        newContract: string;
        analysis: string;
    }) {
        const message = `NEXUS | Ajuste de Operação
• De: ${change.oldContract}
• Para: ${change.newContract}
• Motivo: ${change.reason}`;

        this.saveNexusLog(userId, 'SISTEMA', 'info', message);
    }

    // ✅ MISSING LOGS FROM ATLAS

    private logModeEvaluation(userId: string, mode: string, winRate: number, losses: number) {
        const message = `NEXUS | Avaliação de Modo
• Modo Atual: ${mode.toUpperCase()}
• Win Rate Local: ${winRate.toFixed(1)}%
• Perdas Consecutivas: ${losses}
• Decisão: manter modo`;

        this.saveNexusLog(userId, 'SISTEMA', 'analise', message);
    }

    private logRecoveryPartial(userId: string, recovered: number, target: number) {
        const state = this.users.get(userId);
        const currency = state?.currency || 'USD';
        const message = `NEXUS | Recuperação Parcial
• Recuperado até agora: ${formatCurrency(recovered, currency)}
• Falta para concluir: ${formatCurrency(target - recovered, currency)}
• Ação: recalcular stake`;

        this.saveNexusLog(userId, this.symbol, 'alerta', message);
    }

    private logRecoveryStarted(userId: string, accumulatedLoss: number, target: number, riskProfile: string) {
        const state = this.users.get(userId);
        const currency = state?.currency || 'USD';
        const message = `NEXUS | Início da Recuperação
• Perfil de Risco: ${riskProfile.toUpperCase()}
• Perdas Acumuladas: ${formatCurrency(accumulatedLoss, currency)}
• Alvo de Recuperação: ${formatCurrency(target, currency)}
• Contrato: Rise/Fall`;

        this.saveNexusLog(userId, this.symbol, 'alerta', message);
    }

    private logAnalysisSwitch(userId: string, from: string, to: string, reason: string) {
        const message = `NEXUS | Troca de Análise
• Análise Anterior: ${from}
• Nova Análise: ${to}
• Motivo: ${reason}`;

        this.saveNexusLog(userId, this.symbol, 'alerta', message);
    }

    private logBlockedEntry(userId: string, reason: string, type: 'FILTRO' | 'ESTADO') {
        const message = `NEXUS | Entrada Bloqueada — ${type}
• Motivo: ${reason}
• ${type === 'FILTRO' ? 'Critério Avaliado: filtros' : 'Estado Atual: bloqueado'}
• Ação: aguardar próximo ciclo`;

        this.saveNexusLog(userId, this.symbol, 'alerta', message);
    }

    private logStateReset(userId: string, reason: string) {
        const message = `NEXUS | Reset de Estado
• Motivo: ${reason}
• Ação: reiniciar ciclo`;

        this.saveNexusLog(userId, 'SISTEMA', 'info', message);
    }

    private logStrategicPause(userId: string, phase: 'AVALIADA' | 'ATIVADA' | 'ENCERRADA', details: string) {
        const message = `NEXUS | Pausa Estratégica
• Título: Proteção de Capital (${phase})
• Status: ${phase === 'AVALIADA' ? 'em análise' : phase === 'ATIVADA' ? 'suspensão temporária' : 'retomando operações'}
• Motivo: ${details}
• Ação: ${phase === 'ENCERRADA' ? 'reiniciar ciclo' : 'aguardar resfriamento'}`;

        this.saveNexusLog(userId, this.symbol, 'alerta', message);
    }

    private logSessionEnd(userId: string, summary: {
        result: 'PROFIT' | 'LOSS' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'STOP_BLINDADO';
        totalProfit: number;
        trades: number;
    }) {
        const state = this.users.get(userId);
        const currency = state?.currency || 'USD';
        const message = `NEXUS | Encerramento de Sessão
• Resultado: ${formatCurrency(summary.totalProfit, currency)}
• Total de Entradas: ${summary.trades}
• Status Final: ${summary.result.replace('_', ' ')}`;

        this.saveNexusLog(userId, 'SISTEMA', 'analise', message);
    }

    /**
     * ✅ NEXUS: Verifica limites (meta, stop-loss) - COPIADO DO ATLAS
     */
    private async checkNexusLimits(userId: string): Promise<void> {
        const state = this.users.get(userId);
        if (!state) return;

        const symbol = this.symbol || 'SISTEMA';

        // ✅ [ATLAS LOGIC] - Reverificar limites do banco (Segunda Camada)
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
            [userId],
        );

        if (!configResult || configResult.length === 0) return;

        const config = configResult[0];
        const lossLimit = parseFloat(config.lossLimit) || 0;
        const profitTarget = parseFloat(config.profitTarget) || 0;
        const capitalInicial = parseFloat(config.capitalInicial) || 0;

        const lucroAtual = parseFloat(config.sessionBalance) || 0;
        const capitalSessao = capitalInicial + lucroAtual;

        // 1. Meta de Lucro (Profit Target)
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
            this.saveNexusLog(userId, symbol, 'info',
                `NEXUS | Meta de Lucro Atingida
• Status: Meta Alcançada
• Lucro: ${formatCurrency(lucroAtual, state.currency)}
• Meta: ${formatCurrency(profitTarget, state.currency)}
• Ação: IA DESATIVADA`
            );

            await this.dataSource.query(
                `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
                 WHERE user_id = ? AND is_active = 1`,
                [`Meta de lucro atingida: +${formatCurrency(lucroAtual, state.currency)}`, userId],
            );

            this.tradeEvents.emit({
                userId: userId,
                type: 'stopped_profit',
                strategy: 'nexus',
                symbol: symbol,
                profitLoss: lucroAtual
            });

            this.users.delete(userId);
            return;
        }

        // 2. Stop-loss blindado
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
            const profitPeak = parseFloat(config.profitPeak) || 0;
            const activationThreshold = profitTarget * 0.40;

            // ✅ [DEBUG] Log para rastrear valores
            this.logger.log(`[NEXUS] 🛡️ Verificando Stop Blindado:
      profitPeak: ${profitPeak}
      activationThreshold: ${activationThreshold}
      profitTarget: ${profitTarget}
      lucroAtual: ${lucroAtual}
      capitalSessao: ${capitalSessao}
      capitalInicial: ${capitalInicial}`);

            if (profitTarget > 0 && profitPeak >= activationThreshold) {
                const factor = (parseFloat(config.stopBlindadoPercent) || 50.0) / 100;
                // ✅ Fixed Floor: Protect % of Activation Threshold, not Peak
                const valorProtegidoFixo = activationThreshold * factor;
                const stopBlindado = capitalInicial + valorProtegidoFixo;

                // ✅ [DEBUG] Log para rastrear cálculo do piso
                this.logger.log(`[NEXUS] 🛡️ Stop Blindado ATIVO:
        valorProtegidoFixo: ${valorProtegidoFixo}
        stopBlindado: ${stopBlindado}
        capitalSessao: ${capitalSessao}
        Vai parar? ${capitalSessao <= stopBlindado + 0.01}`);

                if (capitalSessao <= stopBlindado + 0.01) {
                    const lucroFinal = capitalSessao - capitalInicial;

                    // ✅ [NEXUS v3.5] Forçar tipo 'alerta' para garantir que saveNexusLog emita 'blindado_activated' se necessário
                    // Embora o ideal aqui seja já disparar a parada.
                    this.saveNexusLog(userId, symbol, 'alerta',
                        `🛡️ STOP BLINDADO ATINGIDO!\nStoploss blindado atingido, o sistema parou as operações com um lucro de ${formatCurrency(lucroFinal, state.currency)} para proteger o seu capital.`
                    );

                    await this.dataSource.query(
                        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
                         WHERE user_id = ? AND is_active = 1`,
                        [`Stop Blindado: +${formatCurrency(lucroFinal, state.currency)}`, userId],
                    );

                    // ✅ [DEBUG] Confirmar que UPDATE foi executado
                    this.logger.warn(`[NEXUS] 🛡️ STOP BLINDADO - UPDATE executado! session_status = 'stopped_blindado', userId: ${userId}`);

                    this.tradeEvents.emit({
                        userId: userId,
                        type: 'stopped_blindado',
                        strategy: 'nexus',
                        symbol: symbol,
                        profitProtected: lucroFinal,
                        profitLoss: lucroFinal
                    });

                    this.users.delete(userId);

                    // ✅ [FIX] Log final e RETURN imediatamente
                    this.logger.warn(`[NEXUS] 🛡️ STOP BLINDADO - IA parada, saindo de checkNexusLimits()...`);
                    return;
                }
            }
        }

        // 3. Stop Loss Normal
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
            this.saveNexusLog(userId, symbol, 'alerta',
                `NEXUS | Stop Loss Atingido
• Status: Limite de Perda
• Perda: ${formatCurrency(perdaAtual, state.currency)}
• Limite: ${formatCurrency(lossLimit, state.currency)}
• Ação: IA DESATIVADA`
            );

            await this.dataSource.query(
                `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
                 WHERE user_id = ? AND is_active = 1`,
                [`Stop Loss atingido: -${formatCurrency(perdaAtual, state.currency)}`, userId],
            );

            this.tradeEvents.emit({
                userId: userId,
                type: 'stopped_loss',
                strategy: 'nexus',
                symbol: symbol,
                profitLoss: -perdaAtual
            });

            this.users.delete(userId);
            return;
        }
    }

    private async saveNexusLog(userId: string, symbol: string, type: any, message: string) {
        if (!userId || !type || !message) return;

        // ✅ Mapeamento de ícones (igual ao Titan)
        const iconMap: any = {
            'info': 'ℹ️',
            'alerta': '⚠️',
            'sinal': '🎯',
            'operacao': '🚀',
            'resultado': '💰',
            'erro': '❌',
            'analise': '🔍',
            'tick': '📊'
        };
        const icon = iconMap[type] || '📝';

        // Prepare details
        const detailsObj = {
            strategy: 'nexus',
            symbol: symbol
        };

        // Salvar no banco de dados
        this.dataSource.query(
            `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
            [userId, type, icon, message, JSON.stringify(detailsObj)]
        ).catch(err => {
            this.logger.error(`[NEXUS][LOG] Erro ao salvar log: ${err.message}`);
        });

        // ✅ Emitir evento SSE para atualizar frontend em tempo real
        this.tradeEvents.emit({
            userId,
            type: 'updated',
            strategy: 'nexus',
            status: 'LOG',
        });

        if (type === 'alerta' && message.includes('BLINDADO ATIVADO')) {
            this.tradeEvents.emit({ userId, type: 'blindado_activated', strategy: 'nexus' });
        }
    }

    private getIconForType(type: string): string {
        // ✅ DEPRECATED: Icons now added directly in saveNexusLog
        const icons: Record<string, string> = {
            'info': 'ℹ️', 'analise': '🔍', 'operacao': '⚡', 'resultado': '💰', 'alerta': '🛡️', 'erro': '❌'
        };
        return icons[type] || '🎯';
    }

    private analyzeNexus(state: NexusUserState, riskManager: RiskManager): { hasSignal: boolean, signal?: DigitParity, reason?: string } {
        // ✅ Python Nexus v2: Entrada Principal (Higher -0.15) + Recuperação (Rise/Fall)

        const isRecovering = riskManager.consecutiveLosses >= 2;

        if (!isRecovering) {
            // ═══════════════════════════════════════════════════════════════
            // ANÁLISE PRINCIPAL (ENTRADA BARREIRA - M0/M1)
            // ═══════════════════════════════════════════════════════════════

            if (state.mode === 'VELOZ') {
                // VELOZ: 1 tick consecutivo na mesma direção + delta >= 0.1
                const lastTwo = this.ticks.slice(-2);
                if (lastTwo.length < 2) return { hasSignal: false, reason: 'Aguardando ticks (VELOZ)' };

                const delta = Math.abs(lastTwo[1].value - lastTwo[0].value);

                if (lastTwo[1].value > lastTwo[0].value && delta >= 0.1) {
                    this.logSignalGenerated(state.userId, {
                        mode: state.mode,
                        isRecovery: false,
                        filters: ['1 tick consecutivo', `Delta: ${delta.toFixed(2)} (>= 0.1)`],
                        trigger: 'Tendência Imediata (Veloz)',
                        probability: 60,
                        contractType: 'HIGHER',
                        direction: 'CALL'
                    });
                    return { hasSignal: true, signal: 'PAR' };
                } else if (lastTwo[1].value < lastTwo[0].value && delta >= 0.1) {
                    this.logSignalGenerated(state.userId, {
                        mode: state.mode,
                        isRecovery: false,
                        filters: ['1 tick consecutivo', `Delta: ${delta.toFixed(2)} (>= 0.1)`],
                        trigger: 'Tendência Imediata (Veloz)',
                        probability: 60,
                        contractType: 'LOWER',
                        direction: 'PUT'
                    });
                    return { hasSignal: true, signal: 'IMPAR' };
                }

            } else if (state.mode === 'NORMAL') {
                // NORMAL: 3 ticks consecutivos na mesma direção + delta >= 0.3
                if (this.ticks.length < 4) return { hasSignal: false, reason: 'Aguardando ticks (NORMAL)' };

                const last4 = this.ticks.slice(-4);
                const prices = last4.map(t => t.value);

                const upMomentum = prices[1] > prices[0] && prices[2] > prices[1] && prices[3] > prices[2];
                const downMomentum = prices[1] < prices[0] && prices[2] < prices[1] && prices[3] < prices[2];
                const delta = prices[3] - prices[0];

                if (upMomentum && delta >= 0.3) {
                    this.logSignalGenerated(state.userId, {
                        mode: state.mode,
                        isRecovery: false,
                        filters: ['3 ticks consecutivos', `Delta: ${delta.toFixed(2)} (>= 0.3)`],
                        trigger: 'Momentum de Alta',
                        probability: 75,
                        contractType: 'HIGHER',
                        direction: 'CALL'
                    });
                    return { hasSignal: true, signal: 'PAR' };
                } else if (downMomentum && delta <= -0.3) {
                    this.logSignalGenerated(state.userId, {
                        mode: state.mode,
                        isRecovery: false,
                        filters: ['3 ticks consecutivos', `Delta: ${delta.toFixed(2)} (<= -0.3)`],
                        trigger: 'Momentum de Baixa',
                        probability: 75,
                        contractType: 'LOWER',
                        direction: 'PUT'
                    });
                    return { hasSignal: true, signal: 'IMPAR' };
                }

            } else if (state.mode === 'LENTO') {
                // LENTO / PRECISO: 3 ticks consecutivos na mesma direção + delta >= 0.5
                if (this.ticks.length < 4) return { hasSignal: false, reason: 'Aguardando ticks (LENTO)' };

                const last4 = this.ticks.slice(-4);
                const prices = last4.map(t => t.value);

                const upMomentum = prices[1] > prices[0] && prices[2] > prices[1] && prices[3] > prices[2];
                const downMomentum = prices[1] < prices[0] && prices[2] < prices[1] && prices[3] < prices[2];
                const delta = prices[3] - prices[0];

                if (upMomentum && delta >= 0.5) {
                    this.logSignalGenerated(state.userId, {
                        mode: state.mode,
                        isRecovery: false,
                        filters: ['3 ticks consecutivos', `Delta: ${delta.toFixed(2)} (>= 0.5)`],
                        trigger: 'Momentum Forte (Alta)',
                        probability: 85,
                        contractType: 'HIGHER',
                        direction: 'CALL'
                    });
                    return { hasSignal: true, signal: 'PAR' };
                } else if (downMomentum && delta <= -0.5) {
                    this.logSignalGenerated(state.userId, {
                        mode: state.mode,
                        isRecovery: false,
                        filters: ['3 ticks consecutivos', `Delta: ${delta.toFixed(2)} (<= -0.5)`],
                        trigger: 'Momentum Forte (Baixa)',
                        probability: 85,
                        contractType: 'LOWER',
                        direction: 'PUT'
                    });
                    return { hasSignal: true, signal: 'IMPAR' };
                }
            }
        } else {
            // Recovers
            let requiredTicks: number;
            let minDelta: number;
            let modeInfo: string;

            if (state.mode === 'VELOZ') {
                requiredTicks = 2; minDelta = 0.2; modeInfo = '2 ticks + delta >= 0.2';
            } else if (state.mode === 'NORMAL') {
                requiredTicks = 3; minDelta = 0.5; modeInfo = '3 ticks + delta >= 0.5';
            } else {
                requiredTicks = 3; minDelta = 0.7; modeInfo = '3 ticks + delta >= 0.7';
            }

            if (this.ticks.length < requiredTicks + 1) return { hasSignal: false, reason: `Aguardando ${requiredTicks} ticks (RECUPERAÇÃO)` };

            const prices = this.ticks.slice(-(requiredTicks + 1)).map(t => t.value);

            // CALL
            let upMomentum = true;
            for (let i = 0; i < requiredTicks; i++) {
                if (prices[i + 1] <= prices[i]) { upMomentum = false; break; }
            }
            const deltaUp = prices[prices.length - 1] - prices[0];

            if (upMomentum && deltaUp >= minDelta) {
                this.logSignalGenerated(state.userId, {
                    mode: state.mode,
                    isRecovery: true,
                    filters: [modeInfo, `Delta: ${deltaUp.toFixed(2)} (>= ${minDelta})`],
                    trigger: 'Recuperação Alta',
                    probability: 80,
                    contractType: 'RISE/FALL',
                    direction: 'CALL'
                });
                return { hasSignal: true, signal: 'PAR' };
            }

            // PUT
            let downMomentum = true;
            for (let i = 0; i < requiredTicks; i++) {
                if (prices[i + 1] >= prices[i]) { downMomentum = false; break; }
            }
            const deltaDown = prices[0] - prices[prices.length - 1];

            if (downMomentum && deltaDown >= minDelta) {
                this.logSignalGenerated(state.userId, {
                    mode: state.mode,
                    isRecovery: true,
                    filters: [modeInfo, `Delta: ${deltaDown.toFixed(2)} (>= ${minDelta})`],
                    trigger: 'Recuperação Baixa',
                    probability: 80,
                    contractType: 'RISE/FALL',
                    direction: 'PUT'
                });
                return { hasSignal: true, signal: 'IMPAR' };
            }
        }

        return { hasSignal: false, reason: 'Filtros não atendidos (Tendência/Momentum)' };
    }


}
