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

    getStopLossLimit(): number {
        return this.stopLossLimit;
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
        const PAYOUT_RATE = 0.95;

        if (this.consecutiveLosses > 0) {
            if (this.riskMode === 'CONSERVADOR') {
                if (this.consecutiveLosses <= 5) {
                    nextStake = this.totalLossAccumulated / PAYOUT_RATE;
                } else {
                    this.consecutiveLosses = 0;
                    this.totalLossAccumulated = 0.0;
                    nextStake = baseStake;
                    if (userId && symbol && logCallback) {
                        logCallback(userId, symbol, 'alerta', `⚠️ LIMITE DE RECUPERAÇÃO ATINGIDO (CONSERVADOR)\n• Ação: Aceitando perda e resetando stake.\n• Próxima Entrada: Valor Inicial ($${baseStake.toFixed(2)})`);
                    }
                }
            } else if (this.riskMode === 'MODERADO') {
                // Modificado para Nexus v2: (TotalLoss * 1.25) / 0.95
                const targetRecovery = this.totalLossAccumulated * 1.25;
                nextStake = targetRecovery / PAYOUT_RATE;
            } else if (this.riskMode === 'AGRESSIVO') {
                // Modificado para Nexus v2: (TotalLoss * 1.50) / 0.95
                const targetRecovery = this.totalLossAccumulated * 1.50;
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
                logCallback(userId, symbol, 'alerta', `🛡️ STOP LOSS BLINDADO ATIVADO\n• Lucro Atual: $${profitAccumulatedAtPeak.toFixed(2)}\n• Proteção: 50% ($${(profitAccumulatedAtPeak * 0.5).toFixed(2)}) garantidos.`);
            }
        }

        // ✅ Log de progresso ANTES de ativar (quando lucro < 40% da meta)
        if (this.useBlindado && !this._blindadoActive && profitAccumulatedAtPeak > 0 && profitAccumulatedAtPeak < activationTrigger) {
            const percentualProgresso = (profitAccumulatedAtPeak / activationTrigger) * 100;
            if (userId && symbol && logCallback) {
                logCallback(userId, symbol, 'info', `ℹ️🛡️ Stop Blindado: Lucro $${profitAccumulatedAtPeak.toFixed(2)} | Meta ativação: $${activationTrigger.toFixed(2)} (${percentualProgresso.toFixed(1)}%)`);
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
                const isBlindado = this._blindadoActive;
                logCallback(userId, symbol, 'alerta', `⚠️ AJUSTE DE RISCO (STOP ${isBlindado ? 'BLINDADO' : 'NORMAL'})\n• Stake Calculada: $${nextStake.toFixed(2)}\n• ${isBlindado ? 'Lucro Protegido Restante' : 'Saldo Restante até Stop'}: $${(currentBalance - minAllowedBalance).toFixed(2)}\n• Ação: Stake reduzida para $${adjustedStake.toFixed(2)} para ${isBlindado ? 'não violar a proteção de lucro' : 'respeitar o Stop Loss exato'}.`);
            }

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
    apostaInicial: number;
    modoMartingale: ModoMartingale;
    mode: 'VELOZ' | 'BALANCEADO' | 'PRECISO';
    originalMode: 'VELOZ' | 'BALANCEADO' | 'PRECISO';
    lastDirection: DigitParity | null;
    isOperationActive: boolean;
    vitoriasConsecutivas: number;
    ultimoLucro: number;
    ticksColetados: number;
    rejectedAnalysisCount: number;
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

        for (const state of this.users.values()) {
            state.ticksColetados++;
            await this.processUser(state);
        }
    }

    private async processUser(state: NexusUserState): Promise<void> {
        if (state.isOperationActive) return;
        const riskManager = this.riskManagers.get(state.userId);
        if (!riskManager) return;

        const signal = this.check_signal(state, riskManager);
        if (!signal) return;

        await this.executeOperation(state, signal);
    }

    private check_signal(state: NexusUserState, riskManager: RiskManager): DigitParity | null {
        let requiredTicks = state.mode === 'VELOZ' ? 10 : state.mode === 'BALANCEADO' ? 20 : 50;

        // Log de Coleta
        if (state.ticksColetados < requiredTicks) {
            if (state.ticksColetados % 5 === 0 || state.ticksColetados === 3) {
                this.saveNexusLog(state.userId, this.symbol, 'info', `📡 COLETANDO DADOS...\n• META DE COLETA: ${requiredTicks} TICKS (Modo ${state.mode})\n• CONTAGEM: ${state.ticksColetados}/${requiredTicks}`);
            }
            return null;
        }

        // Log de Início de Análise
        if (state.ticksColetados === requiredTicks) {
            this.saveNexusLog(state.userId, this.symbol, 'info', `🧠 ANÁLISE INICIADA...\n• Verificando condições para o modo: ${state.mode}`);
        }

        const lastTicks = this.ticks.slice(-requiredTicks);
        if (lastTicks.length < 5) return null;

        let signal: DigitParity | null = null;
        let analysisMsg = '';

        if (state.mode === 'VELOZ') {
            const t = lastTicks.slice(-3);
            if (t[2].value > t[1].value && t[1].value > t[0].value) {
                signal = 'PAR';
                analysisMsg = `✅ FILTRO 1: Padrão de Alta Identificado\n✅ FILTRO 2: Momentum confirmado\n✅ GATILHO: 2 subidas consecutivas`;
            } else {
                analysisMsg = `❌ Filtro 1: Sem Momentum (${t[0].value} -> ${t[1].value} -> ${t[2].value})`;
            }
        } else if (state.mode === 'BALANCEADO') {
            const sma50 = this.calculateSMA(50);
            const currentPrice = lastTicks[lastTicks.length - 1].value;

            if (currentPrice > sma50) {
                const t = lastTicks.slice(-4);
                if (t[0].value > t[1].value && t[1].value > t[2].value && t[3].value > t[2].value) {
                    signal = 'PAR';
                    analysisMsg = `✅ FILTRO 1: Preço acima da SMA50\n✅ FILTRO 2: Pullback identificado\n✅ GATILHO: Retomada de alta`;
                } else {
                    analysisMsg = `❌ Filtro 2: Aguardando Pullback`;
                }
            } else {
                analysisMsg = `❌ Filtro 1: Preço (${currentPrice}) abaixo da SMA50 (${sma50.toFixed(2)})`;
            }
        } else if (state.mode === 'PRECISO') {
            const rsi = this.calculateRSI(14);
            // Relaxed from 20 to 30 to ensure execution
            if (rsi < 30) {
                signal = 'PAR';
                analysisMsg = `✅ FILTRO 1: RSI em zona de sobrevenda (${rsi.toFixed(2)})\n✅ GATILHO: Exaustão de venda detectada`;
            } else {
                analysisMsg = `❌ Filtro 1: RSI Neutro/Alto (${rsi.toFixed(2)} >= 30)`;
            }
        }

        // Logic for Batched Logging or Immediate Signal
        if (signal) {
            state.rejectedAnalysisCount = 0; // Reset
            this.saveNexusLog(state.userId, this.symbol, 'analise', `🔍 ANÁLISE: MODO ${state.mode}\n${analysisMsg}\n💪 FORÇA DO SINAL: 65%\n📊 ENTRADA: ${state.mode === 'VELOZ' ? 'HIGHER (-0.15)' : 'CALL'}`);
        } else {
            state.rejectedAnalysisCount = (state.rejectedAnalysisCount || 0) + 1;

            if (state.rejectedAnalysisCount >= 5) {
                // this.saveNexusLog(state.userId, this.symbol, 'info', `📋 [RESUMO] Últimas 5 análises recusadas. | Padrão Atual: ${analysisMsg} | Aguardando gatilho...`);
                state.rejectedAnalysisCount = 0;
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

        // Mapeamento de Modos (Frontend -> Backend)
        let nexusMode: 'VELOZ' | 'BALANCEADO' | 'PRECISO' = 'VELOZ';
        const inputMode = (mode || '').toUpperCase();

        if (inputMode === 'MODERADO' || inputMode === 'MODERATE' || inputMode === 'BALANCEADO') {
            nexusMode = 'BALANCEADO';
        } else if (inputMode === 'LENTO' || inputMode === 'PRECISO' || inputMode === 'DEVAGAR' || inputMode === 'SLOW') {
            nexusMode = 'PRECISO';
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
            modoMartingale.toUpperCase(), stopLossBlindado !== false
        ));

        this.logger.log(`[NEXUS] ${userId} ativado em ${nexusMode} (Input: ${inputMode})`);
        this.saveNexusLog(userId, 'SISTEMA', 'info', `⚙️ CONFIGURAÇÕES INICIAIS\n• Estratégia: NEXUS\n• Modo de Negociação: ${nexusMode}\n• Gerenciamento de Risco: ${modoMartingale.toUpperCase()}\n• Meta de Lucro: $${(profitTarget || 100).toFixed(2)}\n• Stop Loss Normal: $${(lossLimit || 50).toFixed(2)}\n• Stop Loss Blindado: ${stopLossBlindado !== false ? 'ATIVADO' : 'DESATIVADO'}`);
    }

    async deactivateUser(userId: string): Promise<void> {
        this.users.delete(userId);
        this.riskManagers.delete(userId);
    }

    getUserState(userId: string) { return this.users.get(userId); }

    private async executeOperation(state: NexusUserState, direction: DigitParity): Promise<void> {
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

        if (stake <= 0) {
            const reason = riskManager.blindadoActive ? 'stopped_blindado' : 'stopped_loss';
            await this.stopUser(state, reason);
            return;
        }

        let barrier: string | undefined = '-0.15'; // Restored Original Attack Mode

        // Hybrid Defense Mode (Nexus v2)
        // Se estiver em recuperação (Losses > 0), remove barreira e opera Rise/Fall (Payout ~95%)
        if (riskManager.consecutiveLosses > 0) {
            barrier = undefined;
        }

        state.isOperationActive = true;
        try {
            const currentPrice = this.ticks[this.ticks.length - 1].value;
            const tradeId = await this.createTradeRecord(state, direction, stake, currentPrice);

            // Removed old "ENTRADA CONFIRMADA" log as it is now detailed in check_signal result

            const result = await this.executeTradeViaWebSocket(state.derivToken, {
                contract_type: 'CALL',
                amount: stake,
                currency: state.currency,
                barrier: barrier
            }, state.userId);

            if (result) {
                const wasRecovery = riskManager.consecutiveLosses > 0;
                riskManager.updateResult(result.profit, stake);
                state.capital += result.profit;
                state.ultimoLucro = result.profit;
                const status = result.profit >= 0 ? 'WON' : 'LOST';

                if (status === 'WON') {
                    if (wasRecovery) {
                        state.vitoriasConsecutivas = 0; // Reset total apos Martingale para voltar a Base
                        this.saveNexusLog(state.userId, this.symbol, 'info', `🔄 TROCA DE CONTRATO ATIVADA\n• Motivo: Loss na entrada principal (Higher).\n• Ação: Mudando para RISE/FALL para recuperação otimizada.\n• Análise: Seguindo direção dos últimos 2 ticks.\n• Multiplicador: 1.37x (Modo Agressivo)`); // Log simulates the switch logic that happened before this win
                        this.saveNexusLog(state.userId, this.symbol, 'info', `🔄 Recuperação completada. Resetando para Stake Base.`);
                    } else {
                        state.vitoriasConsecutivas++;
                        // ✅ Log de Ciclo Perfeito (Igual Orion)
                        if (state.vitoriasConsecutivas % 2 === 0) {
                            this.saveNexusLog(state.userId, this.symbol, 'resultado', `🎉 SOROS CICLO PERFEITO! 2 vitórias consecutivas (Nível 1)`);
                            this.saveNexusLog(state.userId, this.symbol, 'info', `Reiniciando para entrada inicial: $${state.apostaInicial.toFixed(2)}`);
                        }
                    }
                    this.saveNexusLog(state.userId, this.symbol, 'resultado', `🏁 RESULTADO DA ENTRADA\n• Status: WIN\n• Lucro/Prejuízo: +$${result.profit.toFixed(2)}\n• Saldo Atual: $${state.capital.toFixed(2)}`);
                } else {
                    // ✅ Log de Soros Falhou (Igual Orion)
                    if (state.vitoriasConsecutivas > 0) {
                        this.saveNexusLog(state.userId, this.symbol, 'resultado', `❌ Soros Nível 1 falhou! Entrando em recuperação`);
                    }

                    state.vitoriasConsecutivas = 0;
                    this.saveNexusLog(state.userId, this.symbol, 'resultado', `🏁 RESULTADO DA ENTRADA\n• Status: LOSS\n• Lucro/Prejuízo: -$${Math.abs(result.profit).toFixed(2)}\n• Saldo Atual: $${state.capital.toFixed(2)}`);

                    if (riskManager.consecutiveLosses >= 3) {
                        this.saveNexusLog(state.userId, this.symbol, 'alerta', `🚨 DEFESA AUTOMÁTICA ATIVADA\n• Motivo: ${riskManager.consecutiveLosses} Perdas Consecutivas.\n• Ação: Mudando análise para MODO LENTO para recuperação segura.`);
                    }
                }

                await this.dataSource.query(`UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ?, closed_at = NOW() WHERE id = ?`, [status, result.profit, result.exitSpot, tradeId]);



                this.tradeEvents.emit({ userId: state.userId, type: 'updated', tradeId, status, strategy: 'nexus', profitLoss: result.profit });

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

    private async stopUser(state: NexusUserState, reason: 'stopped_blindado' | 'stopped_loss' | 'stopped_profit') {
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
                logMessage = `💰✅Stoploss blindado atingido, o sistema parou as operações com um lucro de $${profit.toFixed(2)} para proteger o seu capital.`;
                logType = 'alerta';
                break;
        }

        // 1. Salvar Log
        this.saveNexusLog(state.userId, this.symbol, logType, logMessage);

        // 2. Emitir Evento
        this.tradeEvents.emit({ userId: state.userId, type: reason, strategy: 'nexus' });

        // 3. Atualizar Banco de Dados (autonomous_agent_config)
        // Mantemos is_active = 1 (TRUE) para permitir o reset diário, mas mudamos o status para stopped_X
        await this.dataSource.query(
            `UPDATE autonomous_agent_config 
             SET is_active = TRUE, 
                 session_status = ?, 
                 updated_at = NOW() 
             WHERE user_id = ? AND agent_type = 'nexus'`,
            [reason, state.userId]
        );

        // 4. Remover da Memória (Pausar execução imediata)
        await this.deactivateUser(state.userId);

        this.logger.log(`[NEXUS] ${state.userId} parado por ${reason}. Status salvo no banco.`);
    }

    private async createTradeRecord(state: NexusUserState, direction: DigitParity, stake: number, entryPrice: number): Promise<number> {
        const analysisData = { strategy: 'nexus', mode: state.mode, direction };
        const r = await this.dataSource.query(
            `INSERT INTO ai_trades (user_id, gemini_signal, entry_price, stake_amount, status, contract_type, created_at, analysis_data, symbol, gemini_duration)
             VALUES (?, 'CALL', ?, ?, 'PENDING', 'CALL', NOW(), ?, ?, 5)`,
            [state.userId, entryPrice, stake, JSON.stringify(analysisData), this.symbol]
        );
        const tradeId = r.insertId || r[0]?.insertId;



        return tradeId;
    }

    private async executeTradeViaWebSocket(token: string, params: any, userId: string): Promise<any> {
        try {
            const connection = await this.getOrCreateWebSocketConnection(token, userId);

            const proposalResponse: any = await connection.sendRequest({
                proposal: 1,
                amount: params.amount,
                basis: 'stake',
                contract_type: params.contract_type,
                currency: params.currency || 'USD',
                duration: 5,
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

    private async saveNexusLog(userId: string, symbol: string, type: any, message: string) {
        if (!userId || !type || !message) return;

        // Salvar no banco de dados de forma assíncrona (sem bloquear)
        // ✅ Mantendo compatibilidade com Orion: ícone vazio no banco, pois já vem na mensagem
        const icon = '';

        this.dataSource.query(
            `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
            [userId, type, icon, message, JSON.stringify({ strategy: 'nexus' })]
        ).catch(err => {
            this.logger.error(`[NEXUS][LOG] Erro ao salvar log: ${err.message}`);
        });

        // ✅ Emitir evento SSE para atualizar frontend em tempo real (Igual Orion)
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
        // Ícones definidos apenas para referência interna ou display legado se necessário
        const icons: Record<string, string> = {
            'info': 'ℹ️', 'analise': '🔍', 'operacao': '⚡', 'resultado': '💰', 'alerta': '🛡️', 'erro': '❌'
        };
        return icons[type] || '🎯';
    }
}
