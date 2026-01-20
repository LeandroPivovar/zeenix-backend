import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';


/**
 * ✅ TITAN Strategy - 3 MODOS DE OPERAÇÃO
 * Baseado na documentação: VELOZ, NORMAL, LENTO (Mapeado para PRECISO no sistema)
 */

type OperationMode = 'VELOZ' | 'NORMAL' | 'LENTO';

// ==================== CONSTANTES POR MODO ====================
interface ModeConfig {
    windowSize: number;       // Tamanho da janela de análise
    majorityThreshold: number; // Percentual mínimo de maioria (0-1)
    momentumThreshold: number; // Mínimo de dígitos na segunda metade
    noiseThreshold: number;    // Máximo de alternâncias permitidas
}

const MODE_CONFIGS: Record<OperationMode, ModeConfig> = {
    VELOZ: {
        windowSize: 10,
        majorityThreshold: 0.50, // 50% = 5 de 10
        momentumThreshold: 3,
        noiseThreshold: 6,
    },
    NORMAL: {
        windowSize: 20,
        majorityThreshold: 0.60, // 60% = 12 de 20
        momentumThreshold: 4,
        noiseThreshold: 8,
    },
    LENTO: {
        windowSize: 30,
        majorityThreshold: 0.60, // 60% = 18 de 30
        momentumThreshold: 5,
        noiseThreshold: 8,
    },
};

// ==================== FUNÇÕES AUXILIARES ====================
/**
* Extrai o último dígito de um tick
*/
const extractLastDigit = (quote: number): number => {
    const quoteStr = quote.toFixed(5);
    const lastChar = quoteStr[quoteStr.length - 1];
    return parseInt(lastChar, 10);
};

/**
* Verifica se um dígito é Par
*/
const isEven = (digit: number): boolean => digit % 2 === 0;

/**
* Extrai os últimos N dígitos do histórico de ticks
*/
const getLastDigits = (ticks: Tick[], count: number): number[] => {
    // ✅ FIX: Retorna os dígitos disponíveis mesmo se não tiver count completo
    // A verificação de quantidade suficiente é feita em analyzeTitan
    const availableTicks = Math.min(ticks.length, count);
    if (availableTicks === 0) {
        return [];
    }

    return ticks
        .slice(-availableTicks)
        .map(tick => extractLastDigit(tick.value));
};

// ==================== FILTROS ====================

/**
 * Filtro de Maioria
 */
const checkMajority = (
    digits: number[],
    threshold: number
): {
    parity: 'EVEN' | 'ODD' | null;
    evenCount: number;
    oddCount: number;
    percentage: number;
} => {
    const evenCount = digits.filter(isEven).length;
    const oddCount = digits.length - evenCount;
    const minRequired = Math.ceil(digits.length * threshold);

    if (evenCount >= minRequired) {
        return {
            parity: 'EVEN',
            evenCount,
            oddCount,
            percentage: Math.round((evenCount / digits.length) * 100),
        };
    }

    if (oddCount >= minRequired) {
        return {
            parity: 'ODD',
            evenCount,
            oddCount,
            percentage: Math.round((oddCount / digits.length) * 100),
        };
    }

    return {
        parity: null,
        evenCount,
        oddCount,
        percentage: Math.round((Math.max(evenCount, oddCount) / digits.length) * 100),
    };
};

/**
 * Filtro de Momentum
 */
const checkMomentum = (
    digits: number[],
    targetParity: 'EVEN' | 'ODD',
    threshold: number
): { status: 'ACELERANDO' | 'SEM_MOMENTUM'; firstHalf: number; secondHalf: number } => {
    const halfPoint = Math.floor(digits.length / 2);
    // Ajuste para pegar as metades corretas da janela
    // Ex: 10 digitos -> first: 0-4, second: 5-9
    const firstHalf = digits.slice(0, halfPoint);
    const secondHalf = digits.slice(halfPoint);

    const countInHalf = (half: number[]) =>
        targetParity === 'EVEN'
            ? half.filter(isEven).length
            : half.filter(d => !isEven(d)).length;

    const firstCount = countInHalf(firstHalf);
    const secondCount = countInHalf(secondHalf);

    // Verifica se está acelerando ou mantendo força (exige não-desaceleração)
    // Documentação (ajustada): aceita se acceleration OU se mantém força alta (Ex: 5 vs 5)
    // Lógica: segunda metade deve ser maior ou igual à primeira, E atingir o threshold
    const isAccelerating = secondCount >= firstCount && secondCount >= threshold;

    return {
        status: isAccelerating ? 'ACELERANDO' : 'SEM_MOMENTUM',
        firstHalf: firstCount,
        secondHalf: secondCount
    };
};

/**
 * Filtro Anti-Ruído
 */
const checkNoise = (
    digits: number[],
    threshold: number
): {
    alternations: number;
    isNoisy: boolean;
} => {
    let alternations = 0;

    for (let i = 1; i < digits.length; i++) {
        if (isEven(digits[i]) !== isEven(digits[i - 1])) {
            alternations++;
        }
    }

    return {
        alternations,
        isNoisy: alternations > threshold,
    };
};

interface AnalysisResult {
    hasSignal: boolean;
    contractType?: 'DIGITEVEN' | 'DIGITODD';
    reason: string;
    details: {
        majority: { even: number; odd: number; percentage: number };
        momentum: { status: string; firstHalf: number; secondHalf: number };
        noise: string;
        alternations: number;
    };
}

/**
 * ANÁLISE UNIVERSAL (3 MODOS)
 */
const analyzeTitan = (
    ticks: Tick[],
    mode: OperationMode
): AnalysisResult => {
    const config = MODE_CONFIGS[mode];

    // Extrai dígitos
    const digits = getLastDigits(ticks, config.windowSize);

    // Verifica se há ticks suficientes
    if (digits.length < config.windowSize) {
        return {
            hasSignal: false,
            // Inclui contagem explícita na reason para o regex do log pegar
            reason: `COLETANDO_DADOS (${digits.length}/${config.windowSize})`,
            details: {
                majority: { even: 0, odd: 0, percentage: 0 },
                momentum: { status: 'SEM_MOMENTUM', firstHalf: 0, secondHalf: 0 },
                noise: 'OK',
                alternations: 0,
            },
        };
    }

    // FILTRO 1: Maioria
    const majority = checkMajority(digits, config.majorityThreshold);

    if (!majority.parity) {
        return {
            hasSignal: false,
            reason: 'SEM_MAIORIA',
            details: {
                majority: {
                    even: majority.evenCount,
                    odd: majority.oddCount,
                    percentage: majority.percentage,
                },
                momentum: { status: 'SEM_MOMENTUM', firstHalf: 0, secondHalf: 0 },
                noise: 'OK',
                alternations: 0,
            },
        };
    }

    // FILTRO 2: Momentum
    const momentum = checkMomentum(digits, majority.parity, config.momentumThreshold);

    if (momentum.status === 'SEM_MOMENTUM') {
        return {
            hasSignal: false,
            reason: `SEM_MOMENTUM_${majority.parity}`,
            details: {
                majority: {
                    even: majority.evenCount,
                    odd: majority.oddCount,
                    percentage: majority.percentage,
                },
                momentum: momentum,
                noise: 'OK',
                alternations: 0,
            },
        };
    }

    // FILTRO 3: Anti-Ruído
    const noise = checkNoise(digits, config.noiseThreshold);

    if (noise.isNoisy) {
        return {
            hasSignal: false,
            reason: 'RUIDO_ALTO',
            details: {
                majority: {
                    even: majority.evenCount,
                    odd: majority.oddCount,
                    percentage: majority.percentage,
                },
                momentum: momentum,
                noise: 'RUIDO_ALTO',
                alternations: noise.alternations,
            },
        };
    }

    // SINAL CONFIRMADO! ✅
    const contractType: 'DIGITEVEN' | 'DIGITODD' = majority.parity === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD';

    return {
        hasSignal: true,
        contractType,
        reason: 'SINAL_CONFIRMADO',
        details: {
            majority: {
                even: majority.evenCount,
                odd: majority.oddCount,
                percentage: majority.percentage,
            },
            momentum: momentum,
            noise: 'OK',
            alternations: noise.alternations,
        },
    };
};

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
    defesaAtivaLogged?: boolean;
    lastOperationStart?: number;
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

    // ✅ Pool de conexões WebSocket por token
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

    private logQueue: Array<{
        userId: string;
        symbol: string;
        type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
        message: string;
        details?: any;
    }> = [];
    private logProcessing = false;

    private blindadoActivatedUsers = new Set<string>();

    constructor(
        private dataSource: DataSource,
        private tradeEvents: TradeEventsService,

    ) {
        this.appId = process.env.DERIV_APP_ID || '111346';
    }

    async initialize(): Promise<void> {
        this.logger.log('[TITAN] Estratégia TITAN Master inicializada');
    }

    async processTick(tick: Tick, symbol?: string): Promise<void> {
        if (symbol && symbol !== this.symbol) return;

        // 🔍 DEBUG: Log para verificar se está sendo chamado
        if (this.users.size > 0) {
            this.logger.debug(`[TITAN] 📥 Tick recebido: ${tick.value} | Symbol: ${symbol} | Usuários ativos: ${this.users.size}`);
        }

        this.ticks.push(tick);
        if (this.ticks.length > 100) this.ticks.shift();

        for (const state of this.users.values()) {
            state.ticksColetados++;
            await this.processUser(state);
        }
    }

    private async processUser(state: TitanUserState): Promise<void> {
        // 🔍 DEBUG: Log entrada do user
        this.logger.debug(`[TITAN] Processando user ${state.userId} | OpAtiva: ${state.isOperationActive}`);

        // 🔒 SAFEGUARD: Se operação estiver ativa por muito tempo (> 60s), forçar reset
        // Também reseta se lastOperationStart não estiver definido (caso de estado inconsistente)
        const now = Date.now();
        const operationDuration = state.lastOperationStart ? now - state.lastOperationStart : 999999;

        if (state.isOperationActive && operationDuration > 60000) {
            this.logger.warn(`[TITAN] ⚠️ Operação travada detectada para ${state.userId}. Resetando estado. (Duração: ${(operationDuration / 1000).toFixed(1)}s)`);
            state.isOperationActive = false;
            state.lastOperationStart = undefined;
        }

        if (state.isOperationActive) {
            // 🔍 DEBUG: Log motivo do skip
            this.logger.debug(`[TITAN] Skipping user ${state.userId} because operation is active`);
            return;
        }
        const riskManager = this.riskManagers.get(state.userId);
        if (!riskManager) {
            this.logger.warn(`[TITAN] RiskManager não encontrado para usuário ${state.userId}`);
            return;
        }

        // SEMPRE chamar check_signal para gerar logs, mesmo sem sinal
        const signal = this.check_signal(state, riskManager);

        // Só executar operação se houver sinal
        if (signal) {
            // Reset ticks counter after signal or if analysis window is consumed
            state.ticksColetados = 0;
            await this.executeOperation(state, signal);
        }
    }

    private check_signal(state: TitanUserState, riskManager: RiskManager): DigitParity | null {
        // ✅ 1. Defesa Automática (Auto-Defense)
        // Se tiver 4 ou mais losses (conforme doc), força o modo PRECISO (LENTO) temporariamente
        let effectiveModeUser = state.mode;
        let analysisMode: OperationMode;

        if (riskManager.consecutiveLosses >= 4) {
            effectiveModeUser = 'PRECISO';

            if (!state.defesaAtivaLogged) {
                this.logger.log(`🚨 [TITAN][DEFESA ATIVA] ${riskManager.consecutiveLosses} Losses seguidos. Forçando modo LENTO (Preciso).`);
                this.logContractChange(state.userId, state.mode, 'PRECISO (LENTO)', `${riskManager.consecutiveLosses} Losses Consecutivos - Defesa Automática`);
                state.defesaAtivaLogged = true;
            }
        } else {
            if (state.defesaAtivaLogged) {
                this.logContractChange(state.userId, 'PRECISO (LENTO)', state.originalMode, `Recuperação Completa`);
                state.defesaAtivaLogged = false;
            }
            effectiveModeUser = state.mode;
        }

        // ✅ 2. Lógica de Persistência (Directional Martingale)
        // Se estiver em recuperação inicial (Loss 1-3), a Titan NÃO inverte a mão.
        // Ela insiste na direção original até vencer.
        // Se atingir 4 losses, a Defesa Automática (LENTO) assume e exige nova análise.
        if (riskManager.consecutiveLosses > 0 && riskManager.consecutiveLosses < 4 && state.lastDirection) {
            // Log de Persistência explícito
            this.saveTitanLog(state.userId, this.symbol, 'analise',
                `⚔️ [PERSISTÊNCIA] Recuperação (M${riskManager.consecutiveLosses}). Mantendo foco em: ${state.lastDirection}`);

            return state.lastDirection;
        }

        // Mapeamento User Mode -> Analysis Mode
        // VELOZ -> VELOZ
        // NORMAL -> NORMAL
        // PRECISO -> LENTO
        if (effectiveModeUser === 'VELOZ') analysisMode = 'VELOZ';
        else if (effectiveModeUser === 'NORMAL') analysisMode = 'NORMAL';
        else analysisMode = 'LENTO'; // PRECISO maps to LENTO

        // ✅ 3. Verificar Janela de Dados (Wait for next X ticks)
        const config = MODE_CONFIGS[analysisMode];
        if (state.ticksColetados < config.windowSize) {
            // Log de progresso da coleta (Feedback periódico)
            if (state.ticksColetados % 2 === 0 || state.ticksColetados === 0) {
                this.logDataCollection(state.userId, state.ticksColetados, config.windowSize);
            }
            return null;
        }

        // Executar Análise Titan
        const result = analyzeTitan(this.ticks, analysisMode);

        // ✅ Reset incremental para garantir que esperará novos dados após cada análise
        state.ticksColetados = 0;

        // 🔍 DEBUG INTERNO
        // this.logger.debug(`[TITAN][ANALYSIS] ${state.userId} | Mode: ${analysisMode} | Result: ${result.hasSignal ? 'SIGNAL' : 'NO_SIGNAL'} (${result.reason})`);

        if (!result.hasSignal) {
            // 🔍 LOG DEBUG: Mostrar o motivo da falha da análise para o usuário (se solicitado)
            // Formatar detalhes para o log
            const details = result.details;
            const momentumStatus = details.momentum.status === 'ACELERANDO' ? 'ACELERANDO' : 'SEM_MOMENTUM';
            const momentumDetail = `${details.momentum.firstHalf} vs ${details.momentum.secondHalf}`;

            // ✅ Log de progresso da análise (Sempre mostrar para o usuário saber que a IA está viva)
            let logMessage = '';

            if (result.reason.includes('COLETANDO_DADOS')) {
                const progressMatch = result.reason.match(/\((\d+)\/(\d+)\)/);
                if (progressMatch) {
                    this.logDataCollection(state.userId, parseInt(progressMatch[1]), parseInt(progressMatch[2]));
                }
            } else {
                // Log da análise sem sinal (Se quiser reduzir spam, pode remover ou throtar)
                // this.logAnalysisStarted(state.userId, analysisMode);
            }
            return null;
        }

        const signal = result.contractType === 'DIGITEVEN' ? 'PAR' : 'IMPAR';

        // ✅ LOG PADRÃO V2: Sinal Gerado
        // Mapear filtros para texto amigável
        const filtersDesc = [
            `Maioria: ${result.details.majority.percentage}% (${result.details.majority.even}P/${result.details.majority.odd}I)`,
            `Momentum: ${result.details.momentum.status} (${result.details.momentum.firstHalf}/${result.details.momentum.secondHalf})`,
            `Ruído: ${result.details.alternations} Alternâncias`
        ];

        // Calcular probabilidade baseada na maioria (ex: 70%)
        const prob = result.details.majority.percentage;

        this.logSignalGenerated(state.userId, analysisMode, signal, filtersDesc, prob);

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

        // ✅ LOGS PADRONIZADOS V2
        this.logInitialConfigV2(userId, titanMode, this.riskManagers.get(userId)!);
        this.logSessionStart(userId, stakeAmount, profitTarget || 100);

        let requiredTicks = titanMode === 'VELOZ' ? 10 : 20;
        this.logDataCollection(userId, 0, requiredTicks);
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
                ? `🛡️ STOP BLINDADO ATINGIDO! Lucro protegido: $${riskManager.guaranteedProfit.toFixed(2)} - IA DESATIVADA`
                : `🛑 STOP LOSS ATINGIDO! Perda: $${Math.abs(state.capital - state.capitalInicial).toFixed(2)} - IA DESATIVADA`;

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
                                `🛡️ STOP BLINDADO ATINGIDO! Lucro protegido: $${lucroProtegido.toFixed(2)} - IA DESATIVADA`);

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
        if (riskManager.consecutiveLosses > 0) {
            this.logMartingaleLevelV2(state.userId, riskManager.consecutiveLosses, stake);
        }

        state.isOperationActive = true;
        state.lastOperationStart = Date.now();
        try {
            const currentPrice = this.ticks[this.ticks.length - 1].value;
            const tradeId = await this.createTradeRecord(state, direction, stake, currentPrice);

            // Executar operação via WebSocket
            // Usar método com underline para evitar conflito de duplicata
            const result = await this._executeTradeViaWebSocket(state.derivToken, {
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
                this.logTradeResultV2(state.userId, status === 'WON' ? 'WIN' : 'LOSS', result.profit, state.capital, { exitDigit });

                if (status === 'WON') {
                    // Soros Logic
                    if (state.vitoriasConsecutivas === 1 && !state.sorosActive) {
                        // First win, activate Soros
                        state.sorosActive = true;
                        state.sorosStake = state.apostaInicial + result.profit;
                        this.logSorosActivation(state.userId, 1, result.profit, state.sorosStake);
                    } else if (state.vitoriasConsecutivas >= 2 && state.sorosActive) {
                        // Soros cycle completed (won with Soros stake)
                        state.sorosActive = false;
                        state.sorosStake = 0;
                        state.vitoriasConsecutivas = 0; // ✅ RESET PARA REINICIAR CICLO SOROS
                        this.saveTitanLog(state.userId, this.symbol, 'info', `🔄 [SOROS] Ciclo Nível 1 Concluído. Retornando à Stake Base ($${state.apostaInicial.toFixed(2)}).`);
                    }

                    // Log Win Streak
                    if (state.vitoriasConsecutivas > 1) {
                        this.logWinStreak(state.userId, state.vitoriasConsecutivas, state.capital - state.capitalInicial);
                    }

                    // Recuperação completa
                    if (previousConsecutiveLosses > 0) {
                        this.logSuccessfulRecoveryV2(state.userId, riskManager['totalLossAccumulated'], result.profit, state.capital);
                        // Reset risk manager total loss if full recovery (already handled in riskManager.updateResult but good to be safe visually)
                        // Actually updateResult handles it.
                    }
                } else {
                    // Reset Soros on loss
                    if (state.sorosActive) {
                        state.sorosActive = false;
                        state.sorosStake = 0;
                    }
                }

                await this.dataSource.query(`UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`, [status, result.profit, result.exitSpot, tradeId]);



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
            `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, contract_type, created_at, analysis_data, symbol, gemini_duration, strategy)
       VALUES (?, ?, ?, ?, 'PENDING', ?, NOW(), ?, ?, ?, 'titan')`,
            [state.userId, direction, entryPrice, stake, direction === 'PAR' ? 'DIGITEVEN' : 'DIGITODD', JSON.stringify(analysisData), this.symbol, 1]
        );
        const tradeId = r.insertId || r[0]?.insertId;



        return tradeId;
    }

    private async _executeTradeViaWebSocket(token: string, params: { contract_type: string; amount: number; currency: string }, userId: string): Promise<{ contractId: string; profit: number; exitSpot: number; entrySpot: number } | null> {
        return new Promise(async (resolve, reject) => {
            try {
                const conn = await this.getOrCreateWebSocketConnection(token, userId);
                const { ws, sendRequest, subscribe, removeSubscription } = conn;

                // 1. Enviar Ordem de Compra
                const buyReq = {
                    buy: 1,
                    price: params.amount,
                    parameters: {
                        amount: params.amount,
                        basis: 'stake',
                        contract_type: params.contract_type,
                        currency: params.currency,
                        duration: 1,
                        duration_unit: 't',
                        symbol: this.symbol,
                    }
                };

                this.logger.debug(`[TITAN] 📤 Enviando Buy: ${JSON.stringify(buyReq.parameters)}`);
                const buyRes: any = await sendRequest(buyReq);

                if (buyRes.error) {
                    this.logger.error(`[TITAN] ❌ Erro no Buy: ${buyRes.error.message}`);
                    throw new Error(buyRes.error.message);
                }

                const contractId = buyRes.buy.contract_id;
                const longcode = buyRes.buy.longcode;
                this.logger.log(`[TITAN] ✅ Contrato Criado: ${contractId} | ${longcode}`);

                // 2. Monitorar Contrato
                // Usar o PRÓPRIO ID do contrato como chave, convertido para string para garantir compatibilidade
                const subKey = String(contractId);
                const subReq = {
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1
                };

                // Timeout de segurança
                const timeout = setTimeout(() => {
                    removeSubscription(subKey);
                    reject(new Error('Timeout monitorando contrato'));
                }, 15000);

                await subscribe(subReq, (msg: any) => {
                    if (msg.error) {
                        clearTimeout(timeout);
                        removeSubscription(subKey);
                        reject(new Error(msg.error.message));
                        return;
                    }

                    const contract = msg.proposal_open_contract;
                    if (!contract) return;

                    // Verifica se finalizou
                    if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
                        clearTimeout(timeout);
                        removeSubscription(subKey); // Remove assinatura

                        const profit = Number(contract.profit);
                        const exitSpot = Number(contract.exit_tick || contract.exit_spot || contract.current_spot || 0);
                        const entrySpot = Number(contract.entry_tick || contract.entry_spot || 0);

                        this.logger.debug(`[TITAN] 🏁 Contrato Finalizado: ${contract.status} | Profit: ${profit}`);
                        resolve({
                            contractId: String(contractId),
                            profit,
                            exitSpot,
                            entrySpot
                        });
                    }
                }, subKey);

            } catch (e) {
                this.logger.error(`[TITAN] ❌ Falha na execução WS: ${e.message}`);
                resolve(null); // Retorna null para tratar como erro na strategy
            }
        });
    }

    // ===================================
    // WEBSOCKET REUTILIZÁVEL (POOL)
    // ===================================
    private async getOrCreateWebSocketConnection(token: string, userId: string): Promise<any> {
        // Se já existe e está conectada/autorizada, retorna
        const existing = this.wsConnections.get(token);
        if (existing && existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
            return existing;
        }

        // Se existe mas caiu, fecha e remove para recriar
        if (existing) {
            try {
                existing.ws.terminate();
            } catch (e) { }
            if (existing.keepAliveInterval) clearInterval(existing.keepAliveInterval);
            this.wsConnections.delete(token);
        }

        this.logger.debug(`[TITAN] 🔌 Criando nova conexão WebSocket para Token ${token.substring(0, 8)}...`);

        // Cria nova
        const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=' + this.appId);

        const connectionObj = {
            ws,
            authorized: false,
            keepAliveInterval: null as NodeJS.Timeout | null,
            requestIdCounter: 0,
            pendingRequests: new Map(),
            subscriptions: new Map(),
            sendRequest: (req: any, timeoutMs = 30000) => {
                return new Promise((resolve, reject) => {
                    const reqId = ++connectionObj.requestIdCounter;
                    req.req_id = reqId;

                    const timer = setTimeout(() => {
                        if (connectionObj.pendingRequests.has(reqId.toString())) {
                            connectionObj.pendingRequests.delete(reqId.toString());
                            reject(new Error('Timeout'));
                        }
                    }, timeoutMs);

                    connectionObj.pendingRequests.set(reqId.toString(), { resolve, reject, timeout: timer });
                    ws.send(JSON.stringify(req));
                });
            },
            subscribe: (req: any, callback: (msg: any) => void, subscriptionIdKey: string) => {
                return new Promise((resolve, reject) => {
                    const reqId = ++connectionObj.requestIdCounter;
                    req.req_id = reqId;

                    // Registra callback temporário para pegar o ID da subscription
                    const tempResolve = (response: any) => {
                        if (response.error) {
                            reject(response.error);
                            return;
                        }
                        // Armazena callback oficial
                        connectionObj.subscriptions.set(subscriptionIdKey, callback);
                        resolve(response);
                    };

                    const timer = setTimeout(() => {
                        if (connectionObj.pendingRequests.has(reqId.toString())) {
                            connectionObj.pendingRequests.delete(reqId.toString());
                            reject(new Error('Timeout subscribe'));
                        }
                    }, 10000);

                    connectionObj.pendingRequests.set(reqId.toString(), { resolve: tempResolve, reject, timeout: timer });
                    ws.send(JSON.stringify(req));
                });
            },
            removeSubscription: (subscriptionIdKey: string) => {
                connectionObj.subscriptions.delete(subscriptionIdKey);
            }
        };

        this.wsConnections.set(token, connectionObj);

        return new Promise((resolve, reject) => {
            ws.on('open', async () => {
                this.logger.debug(`[TITAN] 🟢 Conectado ao Deriv WS. Autenticando...`);
                try {
                    const authRes: any = await connectionObj.sendRequest({ authorize: token });
                    if (authRes.error) {
                        this.logger.error(`[TITAN] ❌ Erro Auth: ${authRes.error.message}`);
                        this.wsConnections.delete(token); // Remove se falhar auth
                        reject(authRes.error);
                    } else {
                        this.logger.log(`[TITAN] ✅ Autenticado com sucesso! Conta: ${authRes.authorize.loginid}`);
                        connectionObj.authorized = true;

                        // Keep Alive
                        connectionObj.keepAliveInterval = setInterval(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ ping: 1 }));
                            }
                        }, 30000);

                        resolve(connectionObj);
                    }
                } catch (e) {
                    reject(e);
                }
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Resposta direta a req_id
                    if (msg.req_id) {
                        const pending = connectionObj.pendingRequests.get(msg.req_id.toString());
                        if (pending) {
                            clearTimeout(pending.timeout);
                            connectionObj.pendingRequests.delete(msg.req_id.toString());
                            pending.resolve(msg);
                        }
                    }

                    // Mensagens de subscription (contract update)
                    // msg.proposal_open_contract -> verificar contract_id
                    if (msg.msg_type === 'proposal_open_contract') {
                        const contractId = msg.proposal_open_contract.contract_id;
                        // Procura se tem callback registrado para esse contrato
                        // Converter para string pois as chaves do Map são strings
                        const subKey = String(contractId);

                        if (connectionObj.subscriptions.has(subKey)) {
                            // this.logger.debug(`[TITAN] 📨 Update para contrato ${contractId}`);
                            connectionObj.subscriptions.get(subKey)(msg);
                        }
                    }

                } catch (err) {
                    this.logger.error(`[TITAN] Erro processar msg WS: ${err}`);
                }
            });

            ws.on('error', (err) => {
                this.logger.error(`[TITAN] ❌ Erro WS: ${err.message}`);
                connectionObj.authorized = false;
            });

            ws.on('close', () => {
                this.logger.warn(`[TITAN] 🔌 Conexão fechada.`);
                connectionObj.authorized = false;
                if (connectionObj.keepAliveInterval) clearInterval(connectionObj.keepAliveInterval);
                this.wsConnections.delete(token);
            });
        });
    }
    // ============================================
    // 🎨 HELPERS DE LOG PADRÃO ZENIX v2.0
    // ============================================

    private logInitialConfigV2(userId: string, mode: string, riskManager: RiskManager) {
        const message = `❄️ Zenix v2.0 | TITAN | ⚙️ Configurações Iniciais
• Modo: ${mode}
• Perfil: ${riskManager['riskMode']}
• Meta: $${riskManager['profitTarget'].toFixed(2)}
• Stop Loss: $${riskManager['stopLossLimit'].toFixed(2)}
• Blindado: ${riskManager['useBlindado'] ? 'ATIVADO' : 'DESATIVADO'}`;

        this.saveTitanLog(userId, 'SISTEMA', 'info', message);
    }

    private logSessionStart(userId: string, initialBalance: number, meta: number) {
        const message = `❄️ Zenix v2.0 | TITAN | 📡 Início de Sessão
• Saldo Inicial: $${initialBalance.toFixed(2)}
• Meta do Dia: $${meta.toFixed(2)}
• Status: Monitorando Mercado`;

        this.saveTitanLog(userId, this.symbol, 'info', message);
    }

    private logDataCollection(userId: string, current: number, target: number) {
        const message = `❄️ Zenix v2.0 | TITAN | 📡 Coletando dados... (${current}/${target})`;

        this.saveTitanLog(userId, this.symbol, 'analise', message);
    }

    private logAnalysisStarted(userId: string, mode: string) {
        const message = `❄️ Zenix v2.0 | TITAN | 🧠 Analisando Mercado (${mode})`;

        this.saveTitanLog(userId, this.symbol, 'analise', message);
    }

    private logSignalGenerated(userId: string, mode: string, signal: string, filters: string[], probability: number) {
        const filtersText = filters.map(f => `• ${f}`).join('\n');
        const message = `❄️ Zenix v2.0 | TITAN | 🎯 Sinal Detectado: ${signal}
${filtersText}
• Força: ${probability}%`;

        this.saveTitanLog(userId, this.symbol, 'sinal', message);
    }

    private logTradeResultV2(
        userId: string,
        result: 'WIN' | 'LOSS',
        profit: number,
        balance: number,
        contractInfo?: { exitDigit?: string }
    ) {
        const emoji = result === 'WIN' ? '✅' : '❌';
        const message = `❄️ Zenix v2.0 | TITAN | ${emoji} Resultado: ${result}
• Lucro/Perda: $${profit >= 0 ? '+' : ''}${profit.toFixed(2)}
• Saldo: $${balance.toFixed(2)}`;

        this.saveTitanLog(userId, this.symbol, 'resultado', message, contractInfo);
    }

    private logMartingaleLevelV2(userId: string, level: number, stake: number) {
        const message = `❄️ Zenix v2.0 | TITAN | 🔄 Martingale Nível ${level}
• Próxima Stake: $${stake.toFixed(2)}
• Objetivo: Recuperação`;

        this.saveTitanLog(userId, this.symbol, 'alerta', message);
    }

    private logSorosActivation(userId: string, level: number, profit: number, newStake: number) {
        const message = `❄️ Zenix v2.0 | TITAN | 🚀 Soros Nível ${level}
• Lucro Anterior: $${profit.toFixed(2)}
• Nova Stake: $${newStake.toFixed(2)}`;

        this.saveTitanLog(userId, this.symbol, 'info', message);
    }

    private logWinStreak(userId: string, count: number, profit: number) {
        const message = `❄️ Zenix v2.0 | TITAN | 🏆 Sequência: ${count} Vitórias
• Lucro Acumulado: $${profit.toFixed(2)}`;

        this.saveTitanLog(userId, this.symbol, 'info', message);
    }

    private logSuccessfulRecoveryV2(userId: string, totalLoss: number, amountRecovered: number, currentBalance: number) {
        const message = `❄️ Zenix v2.0 | TITAN | 🛡️ Recuperação Concluída
• Recuperado: $${totalLoss.toFixed(2)}
• Ação: Retornando à Stake Base`;

        this.saveTitanLog(userId, this.symbol, 'info', message);
    }

    private logContractChange(userId: string, oldContract: string, newContract: string, reason: string) {
        const message = `❄️ Zenix v2.0 | TITAN | 🔄 Ajuste de Operação
• De: ${oldContract}
• Para: ${newContract}
• Motivo: ${reason}`;

        this.saveTitanLog(userId, this.symbol, 'info', message);
    }



    private async saveTitanLog(
        userId: string,
        symbol: string,
        type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro',
        message: string,
        details?: any
    ) {
        this.logQueue.push({ userId, symbol, type, message, details });
        this.processLogs();
    }

    private async processLogs() {
        if (this.logProcessing || this.logQueue.length === 0) return;
        this.logProcessing = true;

        while (this.logQueue.length > 0) {
            const log = this.logQueue.shift();
            if (log) {
                try {
                    // Mapeamento de ícones
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
                    const icon = iconMap[log.type] || '📝';

                    // Prepare details
                    const detailsObj = {
                        strategy: 'titan',
                        symbol: log.symbol,
                        ...(log.details || {})
                    };

                    // Salvar no banco com schema correto
                    await this.dataSource.query(
                        `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
                        [log.userId, log.type, icon, log.message, JSON.stringify(detailsObj)]
                    );

                } catch (error) {
                    console.error('Erro ao salvar log do Titan:', error);
                }
            }
        }

        this.logProcessing = false;
    }
}
