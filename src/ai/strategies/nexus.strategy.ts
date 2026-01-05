import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
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
        const PAYOUT_RATE = 0.30;

        if (this.consecutiveLosses > 0) {
            if (this.riskMode === 'CONSERVADOR') {
                if (this.consecutiveLosses <= 5) {
                    nextStake = this.totalLossAccumulated / PAYOUT_RATE;
                } else {
                    this.consecutiveLosses = 0;
                    this.totalLossAccumulated = 0.0;
                    nextStake = baseStake;
                }
            } else if (this.riskMode === 'MODERADO') {
                const targetRecovery = this.totalLossAccumulated + (baseStake * 0.25);
                nextStake = targetRecovery / PAYOUT_RATE;
            } else if (this.riskMode === 'AGRESSIVO') {
                const targetRecovery = this.totalLossAccumulated + (baseStake * 0.50);
                nextStake = targetRecovery / PAYOUT_RATE;
            }
        } else if (this.lastResultWasWin && vitoriasConsecutivas !== undefined && vitoriasConsecutivas > 0 && vitoriasConsecutivas <= 1) {
            nextStake = baseStake + lastProfit;
        }

        nextStake = Math.round(nextStake * 100) / 100;

        const profitAccumulatedAtPeak = this.maxBalance - this.initialBalance;
        const activationTrigger = this.profitTarget * 0.50;
        let minAllowedBalance = 0.0;

        if (this.useBlindado && profitAccumulatedAtPeak >= activationTrigger && !this._blindadoActive) {
            this._blindadoActive = true;
            if (userId && symbol && logCallback) {
                logCallback(userId, symbol, 'alerta', `🛡️ STOP-LOSS BLINDADO ATIVADO! Lucro Garantido: $${(profitAccumulatedAtPeak * 0.5).toFixed(2)}`);
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
            if (adjustedStake < 0.35) return 0.0;
            return adjustedStake;
        }

        return Math.round(nextStake * 100) / 100;
    }
}

interface NexusUserState {
    userId: string;
    derivToken: string;
    currency: string;
    capital: number;
    capitalInicial: number;
    maxBalance: number;
    apostaInicial: number;
    modoMartingale: ModoMartingale;
    mode: 'VELOZ' | 'BALANCEADO' | 'PRECISO';
    originalMode: 'VELOZ' | 'BALANCEADO' | 'PRECISO';
    lastDirection: DigitParity | null;
    isOperationActive: boolean;
    vitoriasConsecutivas: number;
    ultimoLucro: number;
    ticksColetados: number;
    stopBlindadoLogsEnviados: Set<string>;
}

@Injectable()
export class NexusStrategy implements IStrategy {
    name = 'nexus';
    private readonly logger = new Logger(NexusStrategy.name);
    private users = new Map<string, NexusUserState>();
    private riskManagers = new Map<string, RiskManager>();
    private ticks: Tick[] = [];
    private symbol = 'R_100';
    private appId: string;

    private wsConnections: Map<string, WsConnection> = new Map();
    private logQueue: any[] = [];
    private logProcessing = false;

    // ✅ Rastreamento de logs de coleta de dados (para evitar logs duplicados)
    private coletaLogsEnviados = new Map<string, Set<number>>(); // userId -> Set de marcos já logados

    constructor(
        private dataSource: DataSource,
        private tradeEvents: TradeEventsService,
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

        // ✅ Log de debug: verificar se está recebendo ticks (a cada 20 ticks quando há usuários)
        if (this.users.size > 0 && this.ticks.length % 20 === 0) {
            this.logger.debug(`[NEXUS] 📥 Tick #${this.ticks.length} recebido | Valor: ${tick.value.toFixed(2)} | Dígito: ${tick.digit} | Usuários ativos: ${this.users.size}`);
        }

        // ✅ Processar cada usuário sequencialmente (mais simples e confiável)
        for (const state of this.users.values()) {
            try {
                state.ticksColetados++;
                
                // ✅ Log de coleta de ticks (similar à Orion)
                const requiredTicks = state.mode === 'VELOZ' ? 10 : state.mode === 'BALANCEADO' ? 20 : 50;
                const ticksAtuais = state.ticksColetados;
                const ticksFaltando = requiredTicks - ticksAtuais;
                const key = `nexus_${state.userId}`;
                
                if (ticksAtuais < requiredTicks) {
                    // ✅ Logar apenas uma vez quando começar a coletar
                    if (!this.coletaLogsEnviados.has(key)) {
                        this.coletaLogsEnviados.set(key, new Set());
                        this.saveNexusLog(state.userId, this.symbol, 'info', 
                            `📊 Aguardando ${requiredTicks} ticks para análise | Modo: ${state.mode} | Coleta inicial iniciada.`);
                    }
                    
                    // ✅ Logar progresso: a cada tick para VELOZ (10 ticks), a cada 2 para BALANCEADO (20 ticks), a cada 5 para PRECISO (50 ticks)
                    const intervaloLog = state.mode === 'VELOZ' ? 1 : state.mode === 'BALANCEADO' ? 2 : 5;
                    if (ticksAtuais % intervaloLog === 0) {
                        this.logger.debug(`[NEXUS][${state.userId}] Coletando amostra (${ticksAtuais}/${requiredTicks})`);
                        this.saveNexusLog(state.userId, this.symbol, 'info', 
                            `📊 Aguardando ${requiredTicks} ticks para análise | Modo: ${state.mode} | Ticks coletados: ${ticksAtuais}/${requiredTicks} | Faltam: ${ticksFaltando}`);
                    }
                    
                    continue; // Continuar coletando
                }
                
                // ✅ Logar quando completar a coleta (apenas uma vez)
                if (ticksAtuais === requiredTicks) {
                    if (this.coletaLogsEnviados.has(key)) {
                        const marcosLogados = this.coletaLogsEnviados.get(key)!;
                        if (!marcosLogados.has(100)) {
                            marcosLogados.add(100);
                            this.saveNexusLog(state.userId, this.symbol, 'info', 
                                `✅ DADOS COLETADOS | Modo: ${state.mode} | Amostra completa: ${requiredTicks} ticks | Iniciando operações...`);
                        }
                    }
                }
                
                // ✅ Log de tick quando já coletou dados suficientes (a cada 10 ticks para não spammar)
                if (ticksAtuais >= requiredTicks && ticksAtuais % 10 === 0) {
                    const ultimoTick = this.ticks[this.ticks.length - 1];
                    const digit = ultimoTick.digit;
                    const paridade = digit % 2 === 0 ? 'PAR' : 'IMPAR';
                    this.saveNexusLog(state.userId, this.symbol, 'tick', 
                        `📊 TICK: ${digit} (${paridade}) | Valor: ${ultimoTick.value.toFixed(2)} | Modo: ${state.mode} | Analisando...`);
                }
                
                // ✅ Processar usuário apenas se já coletou ticks suficientes
                if (ticksAtuais >= requiredTicks) {
                    await this.processUser(state);
                }
            } catch (error) {
                this.logger.error(`[NEXUS][${state.userId}] Erro ao processar tick:`, error);
            }
        }
    }

    private async processUser(state: NexusUserState): Promise<void> {
        if (state.isOperationActive) {
            this.logger.debug(`[NEXUS][${state.userId}] Operação ativa, pulando`);
            return;
        }
        
        const riskManager = this.riskManagers.get(state.userId);
        if (!riskManager) {
            this.logger.warn(`[NEXUS][${state.userId}] ⚠️ RiskManager não encontrado!`);
            return;
        }

        const signal = this.check_signal(state, riskManager);
        if (!signal) {
            // ✅ Log periódico quando não há sinal (a cada 20 ticks para não spammar)
            if (state.ticksColetados % 20 === 0 && state.ticksColetados >= (state.mode === 'VELOZ' ? 10 : state.mode === 'BALANCEADO' ? 20 : 50)) {
                this.logger.debug(`[NEXUS][${state.userId}] Aguardando sinal | Ticks coletados: ${state.ticksColetados} | Buffer: ${this.ticks.length}`);
            }
            return;
        }

        this.logger.log(`[NEXUS][${state.userId}] 🎯 SINAL GERADO: ${signal}`);
        await this.executeOperation(state, signal);
    }

    private check_signal(state: NexusUserState, riskManager: RiskManager): DigitParity | null {
        let requiredTicks = state.mode === 'VELOZ' ? 10 : state.mode === 'BALANCEADO' ? 20 : 50;
        if (state.ticksColetados < requiredTicks) return null;

        // ✅ Verificar se temos ticks suficientes no buffer global
        if (this.ticks.length < requiredTicks) {
            // ✅ Log quando não há ticks suficientes no buffer
            if (state.ticksColetados % 10 === 0) {
                this.saveNexusLog(state.userId, this.symbol, 'info', 
                    `⏳ Aguardando buffer de ticks | Buffer: ${this.ticks.length}/${requiredTicks} | Coletados: ${state.ticksColetados}`);
            }
            return null;
        }

        const lastTicks = this.ticks.slice(-requiredTicks);
        if (lastTicks.length < requiredTicks) return null;

        let signal: DigitParity | null = null;
        let analiseMessage = '';

        if (state.mode === 'VELOZ') {
            // ✅ Pegar os últimos 3 ticks (mais recentes primeiro)
            const t = lastTicks.slice(-3);
            const ultimoTick = this.ticks[this.ticks.length - 1];
            const valorAtual = ultimoTick.value;
            
            // ✅ CORREÇÃO: t[0] é o mais antigo, t[1] é o do meio, t[2] é o mais recente
            // Para momentum de alta: t[2] > t[1] > t[0] (mais recente > meio > antigo)
            const tickAntigo = t[0]?.value || 0;
            const tickMeio = t[1]?.value || 0;
            const tickRecente = t[2]?.value || 0;
            
            // ✅ Log de análise mesmo quando não há sinal (para mostrar o que está sendo analisado)
            const diferenca1 = tickMeio - tickAntigo;
            const diferenca2 = tickRecente - tickMeio;
            const tendencia = diferenca1 > 0 && diferenca2 > 0 ? '📈 ALTA' : diferenca1 < 0 && diferenca2 < 0 ? '📉 BAIXA' : '➡️ LATERAL';
            
            analiseMessage = `🔍 [ANÁLISE VELOZ]\n` +
                ` • Últimos 3 ticks: ${tickAntigo.toFixed(2)} → ${tickMeio.toFixed(2)} → ${tickRecente.toFixed(2)}\n` +
                ` • Variações: +${diferenca1.toFixed(2)} → +${diferenca2.toFixed(2)}\n` +
                ` • Tendência: ${tendencia}\n` +
                ` • Valor atual: ${valorAtual.toFixed(2)}\n` +
                ` • Dígito: ${ultimoTick.digit} (${ultimoTick.digit % 2 === 0 ? 'PAR' : 'IMPAR'})\n` +
                ` • Ticks analisados: ${lastTicks.length}/${requiredTicks}`;
            
            // ✅ Verificar momentum: mais recente > meio > antigo
            if (t.length >= 3 && tickRecente > tickMeio && tickMeio > tickAntigo) {
                signal = 'PAR';
                analiseMessage += `\n🌊 [DECISÃO] Momentum de ALTA detectado (3 subidas consecutivas)\n` +
                    `✅ SINAL: Higher (CALL) | Confiança: ALTA`;
                this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                this.saveNexusLog(state.userId, this.symbol, 'sinal', `✅ SINAL GERADO: Higher (CALL) | Momentum de alta confirmado`);
            } else {
                // ✅ Logar análise mesmo sem sinal (a cada 5 ticks para não spammar)
                if (state.ticksColetados % 5 === 0) {
                    analiseMessage += `\n⏳ Aguardando momentum de alta (3 subidas consecutivas)...`;
                    this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                }
            }
        } else if (state.mode === 'BALANCEADO') {
            const sma50 = this.calculateSMA(50);
            const currentPrice = lastTicks[lastTicks.length - 1].value;
            const ultimoTick = this.ticks[this.ticks.length - 1];
            
            const distanciaSMA = ((currentPrice - sma50) / sma50) * 100;
            const posicao = currentPrice > sma50 ? 'ACIMA' : 'ABAIXO';
            
            analiseMessage = `🔍 [ANÁLISE BALANCEADO]\n` +
                ` • Preço atual: ${currentPrice.toFixed(2)}\n` +
                ` • SMA(50): ${sma50.toFixed(2)}\n` +
                ` • Posição: ${posicao} da média (${Math.abs(distanciaSMA).toFixed(2)}%)\n` +
                ` • Últimos 4 ticks: ${lastTicks.slice(-4).map(t => t.value.toFixed(2)).join(' → ')}\n` +
                ` • Ticks analisados: ${lastTicks.length}/${requiredTicks}`;

            // ✅ BALANCEADO: Tendência Macro de Alta (SMA > Preço) + 3 ticks consecutivos de queda (Correção) + Entrada na reversão
            if (currentPrice > sma50) {
                // Tendência de alta confirmada (preço acima da SMA)
                const t = lastTicks.slice(-3); // Últimos 3 ticks para verificar correção
                // ✅ Verificar 3 ticks consecutivos de queda: t[2] < t[1] < t[0] (mais recente < meio < antigo)
                const temCorrecao = t.length >= 3 && t[2].value < t[1].value && t[1].value < t[0].value;
                
                if (temCorrecao) {
                    // ✅ Correção detectada, entrada na reversão (expectativa de volta a subir)
                    signal = 'PAR';
                    analiseMessage += `\n🌊 [DECISÃO] Pullback detectado em Tendência de Alta\n` +
                        ` • Correção: 3 ticks consecutivos de queda\n` +
                        ` • Entrada: Reversão esperada (Higher)\n` +
                        `✅ SINAL: Higher (CALL) | Confiança: MÉDIA`;
                    this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                    this.saveNexusLog(state.userId, this.symbol, 'sinal', `✅ SINAL GERADO: Higher (CALL) | Pullback em alta confirmado`);
                } else {
                    // ✅ Logar análise mesmo sem sinal
                    if (state.ticksColetados % 10 === 0) {
                        analiseMessage += `\n⏳ Aguardando pullback (3 ticks consecutivos de queda) em tendência de alta...`;
                        this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                    }
                }
            } else {
                // ✅ Logar quando está abaixo da média
                if (state.ticksColetados % 10 === 0) {
                    analiseMessage += `\n⏳ Preço abaixo da média. Aguardando tendência de alta (SMA > Preço)...`;
                    this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                }
            }
        } else if (state.mode === 'PRECISO') {
            const rsi = this.calculateRSI(14);
            const ultimoTick = this.ticks[this.ticks.length - 1];
            const valorAtual = ultimoTick.value;
            
            const statusRSI = rsi < 20 ? 'EXAUSTÃO (Oversold)' : rsi > 80 ? 'SOBRECOMPRA (Overbought)' : rsi < 30 ? 'PRÓXIMO DE EXAUSTÃO' : rsi > 70 ? 'PRÓXIMO DE SOBRECOMPRA' : 'NEUTRO';
            const distanciaExaustao = 20 - rsi;
            
            analiseMessage = `🔍 [ANÁLISE PRECISO]\n` +
                ` • Valor atual: ${valorAtual.toFixed(2)}\n` +
                ` • RSI(14): ${rsi.toFixed(2)}\n` +
                ` • Status: ${statusRSI}\n` +
                ` • Distância da exaustão: ${distanciaExaustao > 0 ? distanciaExaustao.toFixed(2) : '0.00'} pontos\n` +
                ` • Últimos 5 ticks: ${lastTicks.slice(-5).map(t => t.value.toFixed(2)).join(' → ')}\n` +
                ` • Ticks analisados: ${lastTicks.length}/${requiredTicks}`;
            
            if (rsi < 20) {
                signal = 'PAR';
                analiseMessage += `\n🌊 [DECISÃO] RSI em exaustão (${rsi.toFixed(2)}) - Reversão esperada\n` +
                    `✅ SINAL: Higher (CALL) | Confiança: ALTA`;
                this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                this.saveNexusLog(state.userId, this.symbol, 'sinal', `✅ SINAL GERADO: Higher (CALL) | RSI em exaustão confirmado`);
            } else {
                // ✅ Logar análise mesmo sem sinal
                if (state.ticksColetados % 10 === 0) {
                    analiseMessage += `\n⏳ Aguardando RSI < 20 (exaustão)... Atual: ${rsi.toFixed(2)}`;
                    this.saveNexusLog(state.userId, this.symbol, 'analise', analiseMessage);
                }
            }
        }

        return signal;
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

    async activateUser(userId: string, config: any): Promise<void> {
        const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, stopLossBlindado, profitTarget, lossLimit } = config;
        const nexusMode = (mode || 'VELOZ').toUpperCase() as any;

        this.users.set(userId, {
            userId, derivToken, currency: currency || 'USD',
            capital: stakeAmount, capitalInicial: stakeAmount, maxBalance: stakeAmount,
            apostaInicial: entryValue || 0.35,
            modoMartingale: modoMartingale || 'conservador',
            mode: nexusMode, originalMode: nexusMode,
            lastDirection: null, isOperationActive: false,
            vitoriasConsecutivas: 0, ultimoLucro: 0, ticksColetados: 0,
            stopBlindadoLogsEnviados: new Set()
        });

        this.riskManagers.set(userId, new RiskManager(
            stakeAmount, lossLimit || 50, profitTarget || 100,
            modoMartingale.toUpperCase(), stopLossBlindado !== false
        ));

        this.logger.log(`[NEXUS] ${userId} ativado em ${nexusMode}`);
        this.saveNexusLog(userId, 'SISTEMA', 'info', `IA NEXUS ATIVADA | Modo: ${nexusMode} | Capital: $${stakeAmount.toFixed(2)}`);
    }

    async deactivateUser(userId: string): Promise<void> {
        const state = this.users.get(userId);
        if (state) {
            state.stopBlindadoLogsEnviados.clear();
        }
        this.users.delete(userId);
        this.riskManagers.delete(userId);
        // ✅ Limpar flags de log
        this.coletaLogsEnviados.delete(`nexus_${userId}`);
    }

    getUserState(userId: string) { return this.users.get(userId); }

    private async executeOperation(state: NexusUserState, direction: DigitParity): Promise<void> {
        const riskManager = this.riskManagers.get(state.userId)!;
        
        // ✅ Buscar configuração do usuário
        const configResult = await this.dataSource.query(
            `SELECT profit_target, loss_limit, stop_blindado_percent, profit_peak, session_balance
             FROM ai_user_config 
             WHERE user_id = ? AND is_active = 1
             LIMIT 1`,
            [state.userId]
        );
        
        const config = configResult && configResult.length > 0 ? configResult[0] : {};
        const profitTarget = parseFloat(config.profit_target) || riskManager.getProfitTarget();
        const lossLimit = parseFloat(config.loss_limit) || 50;
        const stopBlindadoPercent = parseFloat(config.stop_blindado_percent) || 50.0;
        let profitPeak = parseFloat(config.profit_peak) || 0;
        
        // ✅ Atualizar maxBalance se necessário
        if (state.capital > state.maxBalance) {
            state.maxBalance = state.capital;
        }
        
        const capitalInicial = state.capitalInicial;
        const capitalSessao = state.capital;
        const lucroAtual = capitalSessao - capitalInicial;
        
        // ✅ Verificar META DE LUCRO antes da operação
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
            this.logger.log(
                `[NEXUS][${state.mode}][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - DESATIVANDO SESSÃO`
            );
            this.saveNexusLog(state.userId, this.symbol, 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);
            
            await this.dataSource.query(
                `UPDATE ai_user_config 
                 SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
                 WHERE user_id = ? AND is_active = 1`,
                [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} >= Meta +$${profitTarget.toFixed(2)}`, state.userId]
            );
            
            await this.deactivateUser(state.userId);
            return;
        }
        
        // ✅ Verificar STOP-LOSS BLINDADO antes de executar operação
        if (config.stop_blindado_percent !== null && config.stop_blindado_percent !== undefined) {
            // Auto-healing: se lucro atual superou o pico registrado, atualizar pico
            if (lucroAtual > profitPeak) {
                const profitPeakAnterior = profitPeak;
                profitPeak = lucroAtual;
                
                // ✅ Log quando profit peak aumenta
                if (profitPeak >= profitTarget * 0.40) {
                    const fatorProtecao = stopBlindadoPercent / 100;
                    const protectedAmount = profitPeak * fatorProtecao;
                    const stopBlindado = capitalInicial + protectedAmount;
                    
                    this.logger.log(
                        `[NEXUS][${state.mode}][${state.userId}] 🛡️💰 STOP BLINDADO ATUALIZADO | ` +
                        `Pico: $${profitPeakAnterior.toFixed(2)} → $${profitPeak.toFixed(2)} | ` +
                        `Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%)`
                    );
                    this.saveNexusLog(
                        state.userId,
                        this.symbol,
                        'info',
                        `🛡️💰 STOP BLINDADO ATUALIZADO | Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)}`
                    );
                }
                
                // Atualizar no banco em background
                this.dataSource.query(
                    `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
                    [profitPeak, state.userId]
                ).catch(err => this.logger.error(`[NEXUS] Erro ao atualizar profit_peak:`, err));
            }
            
            // Ativar apenas se atingiu 40% da meta
            if (profitPeak >= profitTarget * 0.40) {
                const fatorProtecao = stopBlindadoPercent / 100;
                const protectedAmount = profitPeak * fatorProtecao;
                const stopBlindado = capitalInicial + protectedAmount;
                
                // ✅ Log quando Stop Blindado é ativado pela primeira vez
                const stopBlindadoKey = 'stop_blindado_ativado';
                if (!state.stopBlindadoLogsEnviados.has(stopBlindadoKey)) {
                    state.stopBlindadoLogsEnviados.add(stopBlindadoKey);
                    this.logger.log(
                        `[NEXUS][${state.mode}][${state.userId}] 🛡️✅ STOP BLINDADO ATIVADO! | ` +
                        `Meta: $${profitTarget.toFixed(2)} | ` +
                        `40% Meta: $${(profitTarget * 0.40).toFixed(2)} | ` +
                        `Pico Atual: $${profitPeak.toFixed(2)} | ` +
                        `Protegendo: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%) | ` +
                        `Stop Level: $${stopBlindado.toFixed(2)}`
                    );
                    this.saveNexusLog(
                        state.userId,
                        this.symbol,
                        'info',
                        `🛡️✅ STOP BLINDADO ATIVADO! Protegendo $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}% do pico $${profitPeak.toFixed(2)}) | Stop: $${stopBlindado.toFixed(2)}`
                    );
                }
                
                // Se capital da sessão caiu abaixo do stop blindado → PARAR
                if (capitalSessao <= stopBlindado) {
                    const lucroProtegido = capitalSessao - capitalInicial;
                    
                    this.logger.warn(
                        `[NEXUS][${state.mode}][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
                        `Capital Sessão: $${capitalSessao.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | ` +
                        `Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%) - BLOQUEANDO OPERAÇÃO`
                    );
                    
                    this.saveNexusLog(
                        state.userId,
                        this.symbol,
                        'alerta',
                        `🛡️ STOP-LOSS BLINDADO ATIVADO! Protegido: $${lucroProtegido.toFixed(2)} (${stopBlindadoPercent}% do pico $${profitPeak.toFixed(2)}) - IA DESATIVADA`
                    );
                    
                    const deactivationReason =
                        `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
                        `(${stopBlindadoPercent}% do pico de $${profitPeak.toFixed(2)})`;
                    
                    // Desativar a IA
                    await this.dataSource.query(
                        `UPDATE ai_user_config 
                         SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
                         WHERE user_id = ? AND is_active = 1`,
                        [deactivationReason, state.userId]
                    );
                    
                    await this.deactivateUser(state.userId);
                    return; // NÃO EXECUTAR OPERAÇÃO
                }
            }
        }
        
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

        if (stake <= 0) {
            const reason = riskManager.blindadoActive ? 'stopped_blindado' : 'stopped_loss';
            await this.stopUser(state, reason);
            return;
        }

        state.isOperationActive = true;
        let tradeId: number | null = null;
        try {
            const currentPrice = this.ticks[this.ticks.length - 1].value;
            
            // ✅ Calcular barreira dinâmica
            let barrier = '-0.15';
            if (riskManager.consecutiveLosses === 1) {
                barrier = '-0.25';
            } else if (riskManager.consecutiveLosses === 2) {
                barrier = '-0.35';
            } else if (riskManager.consecutiveLosses >= 3) {
                barrier = '-0.45';
            }
            
            tradeId = await this.createTradeRecord(state, direction, stake, currentPrice, barrier);

            // ✅ NEXUS usa Higher/Lower com barreira negativa (conforme documentação)
            // Higher = CALL (direção de alta), Lower = PUT (direção de baixa)
            // Barreira dinâmica já calculada acima
            
            // Direction: PAR = Higher (CALL), IMPAR = Lower (PUT)
            const contractType = direction === 'PAR' ? 'CALL' : 'PUT';
            const directionDisplay = direction === 'PAR' ? 'Higher (CALL)' : 'Lower (PUT)';
            
            this.saveNexusLog(state.userId, this.symbol, 'operacao', 
                `🎯 ENTRADA CONFIRMADA: ${directionDisplay} | Valor: $${stake.toFixed(2)} | Barreira: ${barrier}`);

            // ✅ NEXUS: Para contratos CALL/PUT com barreira, a API Deriv requer mínimo de 5 ticks
            // A documentação menciona 5 ticks (padrão) ou 1 tick (veloz extremo), mas com barreira só funciona com 5+
            const duration = 5; // Sempre 5 ticks para contratos com barreira (requisito da API Deriv)
            
            const result = await this.executeTradeViaWebSocket(state.derivToken, {
                contract_type: contractType,
                amount: stake,
                currency: state.currency,
                barrier: barrier,
                duration: duration
            }, state.userId);

            if (result) {
                riskManager.updateResult(result.profit, stake);
                state.capital += result.profit;
                state.ultimoLucro = result.profit;
                const status = result.profit >= 0 ? 'WON' : 'LOST';

                if (status === 'WON') {
                    state.vitoriasConsecutivas++;
                    this.saveNexusLog(state.userId, this.symbol, 'resultado', `✅ [WIN] Resultado Positivo. Lucro: +$${result.profit.toFixed(2)} | Saldo: $${state.capital.toFixed(2)}`);
                } else {
                    state.vitoriasConsecutivas = 0;
                    this.saveNexusLog(state.userId, this.symbol, 'resultado', `📉 [LOSS] Perda de $${Math.abs(result.profit).toFixed(2)}. Iniciando recuperação Dinâmica.`);
                }

                await this.dataSource.query(`UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`, [status, result.profit, result.exitSpot, tradeId]);
                this.tradeEvents.emit({ userId: state.userId, type: 'updated', tradeId, status, strategy: 'nexus', profitLoss: result.profit });

                // ✅ Processar resultado e verificar stop loss blindado após operação
                await this.processResult(state, result, stake, tradeId);
            } else {
                // ✅ Erro ao executar trade - atualizar registro e continuar processando
                await this.dataSource.query(`UPDATE ai_trades SET status = 'ERROR' WHERE id = ?`, [tradeId]);
                this.saveNexusLog(state.userId, this.symbol, 'erro', `❌ Erro ao executar operação. Continuando análise...`);
            }
        } catch (e) {
            this.logger.error(`[NEXUS][ERR] Erro ao executar operação:`, e);
            this.saveNexusLog(state.userId, this.symbol, 'erro', `❌ Erro: ${e.message || 'Erro desconhecido'}. Continuando análise...`);
            // ✅ Garantir que o trade seja marcado como erro se existir
            if (tradeId) {
                try {
                    await this.dataSource.query(`UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`, [e.message || 'Erro desconhecido', tradeId]);
                } catch (updateError) {
                    this.logger.error(`[NEXUS] Erro ao atualizar trade:`, updateError);
                }
            }
        } finally {
            // ✅ Sempre resetar o flag de operação ativa para permitir novas operações
            state.isOperationActive = false;
        }
    }

    private async processResult(
        state: NexusUserState,
        result: { profit: number, exitSpot: any, contractId: string },
        stakeUsed: number,
        tradeId: number | null
    ): Promise<void> {
        try {
            const riskManager = this.riskManagers.get(state.userId)!;
            const capitalInicial = state.capitalInicial;
            const capitalSessao = state.capital;
            const lucroAtual = capitalSessao - capitalInicial;
            const perdaAtual = capitalInicial - capitalSessao;
            
            // ✅ Atualizar session_balance no banco
            await this.dataSource.query(
                `UPDATE ai_user_config 
                 SET session_balance = ?
                 WHERE user_id = ? AND is_active = 1`,
                [lucroAtual, state.userId]
            );
            
            // ✅ Buscar configuração do usuário
            const configResult = await this.dataSource.query(
                `SELECT profit_target, loss_limit, stop_blindado_percent, profit_peak
                 FROM ai_user_config 
                 WHERE user_id = ? AND is_active = 1
                 LIMIT 1`,
                [state.userId]
            );
            
            const config = configResult && configResult.length > 0 ? configResult[0] : {};
            const profitTarget = parseFloat(config.profit_target) || riskManager.getProfitTarget();
            const lossLimit = parseFloat(config.loss_limit) || 50;
            const stopBlindadoPercent = parseFloat(config.stop_blindado_percent) || 50.0;
            let profitPeak = parseFloat(config.profit_peak) || 0;
            
            // ✅ Atualizar maxBalance se necessário
            if (state.capital > state.maxBalance) {
                state.maxBalance = state.capital;
            }
            
            // ✅ Verificar STOP WIN (profit target)
            if (profitTarget > 0 && lucroAtual >= profitTarget) {
                this.logger.log(
                    `[NEXUS][${state.mode}][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - DESATIVANDO SESSÃO`
                );
                this.saveNexusLog(state.userId, this.symbol, 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);
                
                await this.dataSource.query(
                    `UPDATE ai_user_config 
                     SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
                     WHERE user_id = ? AND is_active = 1`,
                    [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} >= Meta +$${profitTarget.toFixed(2)}`, state.userId]
                );
                
                await this.deactivateUser(state.userId);
                return;
            }
            
            // ✅ STOP LOSS BLINDADO (Dynamic Trailing)
            if (config.stop_blindado_percent !== null && config.stop_blindado_percent !== undefined) {
                // Auto-healing / Update Peak
                if (lucroAtual > profitPeak) {
                    const profitPeakAnterior = profitPeak;
                    profitPeak = lucroAtual;
                    
                    // ✅ Log quando profit peak aumenta após vitória
                    if (profitPeak >= profitTarget * 0.40) {
                        const fatorProtecao = stopBlindadoPercent / 100;
                        const protectedAmount = profitPeak * fatorProtecao;
                        const stopBlindado = capitalInicial + protectedAmount;
                        
                        this.logger.log(
                            `[NEXUS][${state.mode}][${state.userId}] 🛡️💰 STOP BLINDADO ATUALIZADO | ` +
                            `Pico: $${profitPeakAnterior.toFixed(2)} → $${profitPeak.toFixed(2)} | ` +
                            `Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%)`
                        );
                        this.saveNexusLog(
                            state.userId,
                            this.symbol,
                            'info',
                            `🛡️💰 STOP BLINDADO ATUALIZADO | Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)}`
                        );
                    }
                    
                    // Update DB
                    await this.dataSource.query(
                        `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
                        [profitPeak, state.userId]
                    );
                }
                
                // Check Stop
                if (profitPeak >= profitTarget * 0.40) {
                    const fatorProtecao = stopBlindadoPercent / 100;
                    const protectedAmount = profitPeak * fatorProtecao;
                    const stopBlindado = capitalInicial + protectedAmount;
                    
                    if (capitalSessao <= stopBlindado) {
                        const lucroProtegido = capitalSessao - capitalInicial;
                        this.logger.warn(`[NEXUS] 🛡️ STOP BLINDADO ATINGIDO APÓS OPERAÇÃO. Peak: ${profitPeak}, Protegido: ${protectedAmount}, Atual: ${lucroAtual}`);
                        this.saveNexusLog(state.userId, this.symbol, 'alerta', `🛡️ STOP BLINDADO ATINGIDO! Saldo protegido: $${lucroProtegido.toFixed(2)}`);
                        
                        const deactivationReason = `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro`;
                        
                        // STOP
                        await this.dataSource.query(
                            `UPDATE ai_user_config 
                             SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
                             WHERE user_id = ? AND is_active = 1`,
                            [deactivationReason, state.userId]
                        );
                        
                        await this.deactivateUser(state.userId);
                        return;
                    }
                }
            }
            
            // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
            if (lossLimit > 0 && perdaAtual >= lossLimit) {
                this.logger.warn(
                    `[NEXUS][${state.mode}][${state.userId}] 🛑 STOP LOSS ATINGIDO APÓS OPERAÇÃO! Perda: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - DESATIVANDO SESSÃO`
                );
                this.saveNexusLog(state.userId, this.symbol, 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);
                
                await this.dataSource.query(
                    `UPDATE ai_user_config 
                     SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
                     WHERE user_id = ? AND is_active = 1`,
                    [`Stop loss atingido após operação: Perda $${perdaAtual.toFixed(2)} >= Limite $${lossLimit.toFixed(2)}`, state.userId]
                );
                
                await this.deactivateUser(state.userId);
                return;
            }
        } catch (error) {
            this.logger.error(`[NEXUS] Erro ao processar resultado:`, error);
        }
    }

    private async stopUser(state: NexusUserState, reason: 'stopped_blindado' | 'stopped_loss' | 'stopped_profit') {
        this.saveNexusLog(state.userId, this.symbol, 'alerta', `🛑 Sessão encerrada: ${reason}`);
        this.tradeEvents.emit({ userId: state.userId, type: reason, strategy: 'nexus' });
        await this.deactivateUser(state.userId);
        await this.dataSource.query(`UPDATE ai_user_config SET is_active = 0, session_status = ? WHERE user_id = ?`, [reason, state.userId]);
    }

    private async createTradeRecord(state: NexusUserState, direction: DigitParity, stake: number, entryPrice: number, barrier?: string): Promise<number> {
        const analysisData = { strategy: 'nexus', mode: state.mode, direction, barrier };
        const contractType = direction === 'PAR' ? 'CALL' : 'PUT';
        // ✅ NEXUS: Para contratos CALL/PUT com barreira, a API Deriv requer mínimo de 5 ticks
        const duration = 5; // Sempre 5 ticks para contratos com barreira
        const r = await this.dataSource.query(
            `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, contract_type, created_at, analysis_data, symbol, gemini_duration)
             VALUES (?, ?, ?, ?, 'PENDING', ?, NOW(), ?, ?, ?)`,
            [state.userId, direction, entryPrice, stake, contractType, JSON.stringify(analysisData), this.symbol, duration]
        );
        return r.insertId || r[0]?.insertId;
    }

    private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<any> {
        try {
            const connection = await this.getOrCreateWebSocketConnection(token, userId);

            // ✅ NEXUS: Duração baseada no modo (5 ticks padrão, 1 tick para veloz extremo)
            // A duração será determinada pelo modo do usuário passado via params
            const duration = params.duration || 5; // Padrão 5 ticks conforme documentação
            
            const proposalPayload: any = {
                proposal: 1,
                amount: params.amount,
                basis: 'stake',
                contract_type: params.contract_type,
                currency: params.currency || 'USD',
                duration: duration,
                duration_unit: 't',
                symbol: this.symbol,
            };
            
            // ✅ Adicionar barreira negativa (offset) para Higher/Lower (CALL/PUT)
            // A barreira deve ser uma string no formato "-0.15", "-0.25", etc.
            if (params.barrier) {
                proposalPayload.barrier = String(params.barrier); // Converter para string
            }
            
            const proposalResponse: any = await connection.sendRequest(proposalPayload, 60000);

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

    private saveNexusLog(userId: string, symbol: string, type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro', message: string) {
        if (!userId || !type || !message) return;
        this.logQueue.push({ userId, symbol, type, message, timestamp: new Date() });
        this.processQueue();
    }

    private async processQueue() {
        if (this.logProcessing || this.logQueue.length === 0) return;
        this.logProcessing = true;

        try {
            const logs = this.logQueue.splice(0, 50);
            const icons: Record<string, string> = {
                'info': 'ℹ️', 
                'tick': '📊', 
                'analise': '🔍', 
                'sinal': '🎯', 
                'operacao': '⚡', 
                'resultado': '💰', 
                'alerta': '⚠️', 
                'erro': '❌'
            };

            for (const log of logs) {
                const icon = icons[log.type] || '🎯';
                await this.dataSource.query(
                    `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
                    [log.userId, log.type, icon, log.message, JSON.stringify({ strategy: 'nexus' })]
                );

                if (log.type === 'alerta' && log.message.includes('BLINDADO ATIVADO')) {
                    this.tradeEvents.emit({ userId: log.userId, type: 'blindado_activated', strategy: 'nexus' });
                }
            }
        } catch (e) {
            this.logger.error(`[NEXUS][LOG] ${e.message}`);
        } finally {
            this.logProcessing = false;
            if (this.logQueue.length > 0) this.processQueue();
        }
    }
}
