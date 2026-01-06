import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  IAutonomousAgentStrategy,
  AutonomousAgentConfig,
  AutonomousAgentState,
  MarketAnalysis,
  TradeDecision,
} from './common.types';
import { Tick, DigitParity } from '../../ai/ai.service';
import { LogQueueService } from '../../utils/log-queue.service';
import { DerivWebSocketPoolService } from '../../broker/deriv-websocket-pool.service';

/**
 * 🛡️ SENTINEL Strategy para Agente Autônomo
 * 
 * Implementação completa do Agente Sentinel conforme documentação:
 * - Análise Híbrida (Técnica + Estatística)
 * - Modos de Negociação (Veloz, Normal, Lento)
 * - Modos de Gerenciamento (Conservador, Moderado, Agressivo)
 * - Stop Loss Normal e Blindado
 * - Martingale Inteligente
 * - Soros (Alavancagem)
 * - Sistema de logs detalhado
 */
@Injectable()
export class SentinelStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'sentinel';
  displayName = '🛡️ SENTINEL';
  description = 'Agente autônomo com análise híbrida, Martingale Inteligente e Soros';

  private readonly logger = new Logger(SentinelStrategy.name);
  private readonly userConfigs = new Map<string, SentinelUserConfig>();
  private readonly userStates = new Map<string, SentinelUserState>();
  private readonly ticks = new Map<string, Tick[]>();
  private readonly maxTicks = 200;

  // Configurações por modo de negociação
  private readonly tradingModeConfigs = {
    veloz: { ticksToCollect: 20, emaPeriods: [10, 25], scoreMinimum: 60 },
    normal: { ticksToCollect: 50, emaPeriods: [10, 25, 50], scoreMinimum: 70 },
    lento: { ticksToCollect: 100, emaPeriods: [10, 25, 50], scoreMinimum: 80 },
  };

  // Configurações por modo de gerenciamento
  private readonly managementModeConfigs = {
    conservador: { recoveryTarget: 1.0, recoveryProfit: 0, maxRecoveryAttempts: 3, sorosLevels: 1 },
    moderado: { recoveryTarget: 1.15, recoveryProfit: 0.15, maxRecoveryAttempts: -1, sorosLevels: 2 },
    agressivo: { recoveryTarget: 1.20, recoveryProfit: 0.20, maxRecoveryAttempts: -1, sorosLevels: 3 },
  };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => DerivWebSocketPoolService))
    private readonly derivPool: DerivWebSocketPoolService,
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {}

  async onModuleInit() {
    this.logger.log('🛡️ SENTINEL Strategy inicializado');
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
        `SELECT user_id, initial_stake, daily_profit_target, daily_loss_limit, 
                initial_balance, deriv_token, currency, symbol, agent_type, trading_mode
         FROM autonomous_agent_config 
         WHERE is_active = TRUE AND agent_type = 'sentinel'`,
      );

      for (const user of activeUsers) {
        const userId = user.user_id.toString();
        const config: SentinelUserConfig = {
          userId: userId,
          initialStake: parseFloat(user.initial_stake),
          dailyProfitTarget: parseFloat(user.daily_profit_target),
          dailyLossLimit: parseFloat(user.daily_loss_limit),
          derivToken: user.deriv_token,
          currency: user.currency,
          symbol: user.symbol || 'R_75',
          tradingMode: (user.trading_mode || 'normal').toLowerCase() as 'veloz' | 'normal' | 'lento',
          managementMode: 'moderado', // Default, pode ser configurado
          stopLossType: 'normal', // Default, pode ser configurado
          initialBalance: parseFloat(user.initial_balance) || 0,
        };

        this.userConfigs.set(userId, config);
        this.initializeUserState(userId, config);
      }

      this.logger.log(`[Sentinel] Sincronizados ${activeUsers.length} usuários ativos`);
    } catch (error) {
      this.logger.error('[Sentinel] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Inicializa estado do usuário
   */
  private initializeUserState(userId: string, config: SentinelUserConfig): void {
    const state: SentinelUserState = {
      userId,
      isActive: true,
      currentProfit: 0,
      currentLoss: 0,
      operationsCount: 0,
      martingaleLevel: 0,
      sorosLevel: 0,
      totalLosses: 0,
      consecutiveLosses: 0,
      recoveryAttempts: 0,
      lastTradeResult: null,
      currentContractId: null,
      currentTradeId: null,
      isWaitingContract: false,
    };

    this.userStates.set(userId, state);
    this.ticks.set(userId, []);
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    const sentinelConfig: SentinelUserConfig = {
      userId: config.userId,
      initialStake: config.initialStake,
      dailyProfitTarget: config.dailyProfitTarget,
      dailyLossLimit: config.dailyLossLimit,
      derivToken: config.derivToken,
      currency: config.currency,
      symbol: config.symbol || 'R_75',
      tradingMode: ((config as any).tradingMode || 'normal').toLowerCase() as 'veloz' | 'normal' | 'lento',
      managementMode: ((config as any).managementMode || 'moderado').toLowerCase() as 'conservador' | 'moderado' | 'agressivo',
      stopLossType: ((config as any).stopLossType || 'normal').toLowerCase() as 'normal' | 'blindado',
      initialBalance: config.initialBalance || 0,
    };

    this.userConfigs.set(userId, sentinelConfig);
    this.initializeUserState(userId, sentinelConfig);

    // Log de ativação
    await this.saveLog(userId, 'INFO', 'CORE', `Agente 1 - Sentinel iniciando...`);
    await this.saveLog(userId, 'INFO', 'CORE', 
      `Carregando configurações: tradingmode=${sentinelConfig.tradingMode}, managementmode=${sentinelConfig.managementMode}, stoplosstype=${sentinelConfig.stopLossType}`);

    this.logger.log(`[Sentinel] ✅ Usuário ${userId} ativado`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userConfigs.delete(userId);
    this.userStates.delete(userId);
    this.ticks.delete(userId);
    this.logger.log(`[Sentinel] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Processa um tick recebido
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    // Processar para todos os usuários ativos que usam o símbolo do tick
    const promises: Promise<void>[] = [];
    const tickSymbol = symbol || 'R_75'; // Default para R_75 (Sentinel usa R_75)

    for (const [userId, config] of this.userConfigs.entries()) {
      if (config.symbol === tickSymbol) {
        promises.push(this.processTickForUser(userId, tick).catch((error) => {
          this.logger.error(`[Sentinel][${userId}] Erro ao processar tick:`, error);
        }));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Processa tick para um usuário específico
   */
  private async processTickForUser(userId: string, tick: Tick): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || !state.isActive) {
      return;
    }

    // Se está aguardando resultado de contrato, não processar novos ticks
    if (state.isWaitingContract) {
      return;
    }

    // Adicionar tick à coleção
    const userTicks = this.ticks.get(userId) || [];
    userTicks.push(tick);
    
    // Manter apenas os últimos maxTicks
    if (userTicks.length > this.maxTicks) {
      userTicks.shift();
    }
    this.ticks.set(userId, userTicks);

    // Verificar se tem ticks suficientes para análise
    const modeConfig = this.tradingModeConfigs[config.tradingMode];
    if (userTicks.length < modeConfig.ticksToCollect) {
      // Log apenas a cada 10 ticks para não poluir
      if (userTicks.length % 10 === 0) {
        await this.saveLog(userId, 'DEBUG', 'ANALYZER', 
          `Ticks coletados: ${userTicks.length}/${modeConfig.ticksToCollect}`);
      }
      return;
    }

    // Realizar análise
    const analysis = await this.analyze(userId, userTicks);
    
    if (analysis && analysis.score >= modeConfig.scoreMinimum) {
      // Tomar decisão de trade
      const decision = await this.makeTradeDecision(userId, analysis);
      
      if (decision.action === 'BUY') {
        await this.executeTrade(userId, decision, analysis);
      }
    }
  }

  /**
   * Análise híbrida (Técnica + Estatística)
   */
  private async analyze(userId: string, ticks: Tick[]): Promise<SentinelAnalysis | null> {
    const config = this.userConfigs.get(userId);
    if (!config) return null;

    const modeConfig = this.tradingModeConfigs[config.tradingMode];
    const prices = ticks.slice(-modeConfig.ticksToCollect).map(t => t.value);

    // Análise Técnica
    const technicalAnalysis = this.performTechnicalAnalysis(prices, modeConfig.emaPeriods);
    
    // Análise Estatística
    const statisticalAnalysis = this.performStatisticalAnalysis(ticks.slice(-modeConfig.ticksToCollect));

    // Combinar análises
    const combinedScore = (technicalAnalysis.score * 0.6) + (statisticalAnalysis.score * 0.4);
    const direction = technicalAnalysis.direction && statisticalAnalysis.direction === technicalAnalysis.direction
      ? technicalAnalysis.direction
      : null;

    // Log da análise
    await this.saveLog(userId, 'DEBUG', 'ANALYZER',
      `Análise técnica: EMA_fast=${technicalAnalysis.emaFast.toFixed(4)}, RSI=${technicalAnalysis.rsi.toFixed(1)}, Momentum=${technicalAnalysis.momentum.toFixed(4)}`);
    await this.saveLog(userId, 'DEBUG', 'ANALYZER',
      `Análise estatística: digitpattern=${statisticalAnalysis.digitPattern}`);

    if (direction && combinedScore >= modeConfig.scoreMinimum) {
      await this.saveLog(userId, 'INFO', 'ANALYZER',
        `Sinal encontrado. direction=${direction}, score=${combinedScore.toFixed(1)}%`);
    }

    return {
      score: combinedScore,
      direction: direction as 'CALL' | 'PUT' | null,
      technical: technicalAnalysis,
      statistical: statisticalAnalysis,
      confidence: combinedScore / 100,
    };
  }

  /**
   * Análise Técnica: EMA, RSI, Momentum, MACD
   */
  private performTechnicalAnalysis(prices: number[], emaPeriods: number[]): TechnicalAnalysis {
    // Calcular EMAs
    const emas = emaPeriods.map(period => this.calculateEMA(prices, period));
    const emaFast = emas[0];
    const emaSlow = emas[emas.length - 1];

    // Calcular RSI
    const rsi = this.calculateRSI(prices, 14);

    // Calcular Momentum
    const momentum = this.calculateMomentum(prices, 10);

    // Calcular MACD
    const macd = this.calculateMACD(prices);

    // Determinar direção baseada nos indicadores
    let direction: 'CALL' | 'PUT' | null = null;
    let score = 0;

    // EMA: Se EMA rápida > EMA lenta = tendência de alta
    if (emaFast > emaSlow) {
      score += 20;
      direction = 'CALL';
    } else if (emaFast < emaSlow) {
      score += 20;
      direction = 'PUT';
    }

    // RSI: < 30 = sobrevendido (CALL), > 70 = sobrecomprado (PUT)
    if (rsi < 30) {
      score += 20;
      if (!direction) direction = 'CALL';
    } else if (rsi > 70) {
      score += 20;
      if (!direction) direction = 'PUT';
    }

    // Momentum: Positivo = CALL, Negativo = PUT
    if (momentum > 0) {
      score += 15;
      if (!direction) direction = 'CALL';
    } else if (momentum < 0) {
      score += 15;
      if (!direction) direction = 'PUT';
    }

    // MACD: Sinal positivo = CALL, negativo = PUT
    if (macd > 0) {
      score += 15;
      if (!direction) direction = 'CALL';
    } else if (macd < 0) {
      score += 15;
      if (!direction) direction = 'PUT';
    }

    return {
      emaFast,
      emaSlow,
      rsi,
      momentum,
      macd,
      direction,
      score: Math.min(score, 100),
    };
  }

  /**
   * Análise Estatística: Dígitos e Padrões
   */
  private performStatisticalAnalysis(ticks: Tick[]): StatisticalAnalysis {
    // Extrair últimos dígitos
    const lastDigits = ticks.slice(-20).map(t => {
      const value = t.value.toString();
      return parseInt(value[value.length - 1]);
    });

    // Contar pares e ímpares
    const evenCount = lastDigits.filter(d => d % 2 === 0).length;
    const oddCount = lastDigits.filter(d => d % 2 === 1).length;

    // Determinar padrão
    let digitPattern: 'strongeven' | 'strongodd' | 'balanced' = 'balanced';
    let direction: 'CALL' | 'PUT' | null = null;
    let score = 50; // Base

    if (evenCount > oddCount + 3) {
      digitPattern = 'strongeven';
      direction = 'PUT'; // Se muitos pares, espera-se ímpar (PUT)
      score = 60 + Math.min((evenCount - oddCount) * 2, 20);
    } else if (oddCount > evenCount + 3) {
      digitPattern = 'strongodd';
      direction = 'CALL'; // Se muitos ímpares, espera-se par (CALL)
      score = 60 + Math.min((oddCount - evenCount) * 2, 20);
    }

    return {
      digitPattern,
      direction,
      score: Math.min(score, 100),
      evenCount,
      oddCount,
    };
  }

  /**
   * Calcula EMA (Exponential Moving Average)
   */
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) {
      return prices[prices.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] * multiplier) + (ema * (1 - multiplier));
    }

    return ema;
  }

  /**
   * Calcula RSI (Relative Strength Index)
   */
  private calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) {
      return 50; // Neutro
    }

    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calcula Momentum
   */
  private calculateMomentum(prices: number[], period: number): number {
    if (prices.length < period + 1) {
      return 0;
    }

    return prices[prices.length - 1] - prices[prices.length - period - 1];
  }

  /**
   * Calcula MACD (Moving Average Convergence Divergence)
   */
  private calculateMACD(prices: number[]): number {
    if (prices.length < 26) {
      return 0;
    }

    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    return ema12 - ema26;
  }

  /**
   * Toma decisão de trade baseada na análise e estado atual
   */
  private async makeTradeDecision(userId: string, analysis: SentinelAnalysis): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
    }

    // Verificar Stop Loss
    const stopLossCheck = await this.checkStopLoss(userId);
    if (stopLossCheck.action === 'STOP') {
      return stopLossCheck;
    }

    // Determinar stake
    const stake = await this.getNextStake(userId);

    // Verificar se pode operar
    if (stake <= 0) {
      return { action: 'WAIT', reason: 'INVALID_STAKE' };
    }

    return {
      action: 'BUY',
      stake,
      contractType: analysis.direction === 'CALL' ? 'RISE' : 'FALL',
      reason: 'SIGNAL_FOUND',
      mode: config.tradingMode,
    };
  }

  /**
   * Obtém próximo stake (inicial, Soros ou recuperação)
   */
  private async getNextStake(userId: string): Promise<number> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return 0;
    }

    // Se está em Soros, usar stake de Soros
    if (state.sorosLevel > 0 && state.lastTradeResult?.win) {
      const sorosStake = state.lastTradeResult.profit + config.initialStake;
      await this.saveLog(userId, 'INFO', 'RISK',
        `Ativando Soros Nível ${state.sorosLevel}. stakeanterior=${config.initialStake}, lucro=${state.lastTradeResult.profit.toFixed(2)}, proximostake=${sorosStake.toFixed(2)}`);
      return sorosStake;
    }

    // Se está em recuperação (Martingale), calcular stake de recuperação
    if (state.martingaleLevel > 0) {
      return await this.calculateRecoveryStake(userId);
    }

    // Stake inicial
    await this.saveLog(userId, 'INFO', 'RISK', `Verificando entrada normal (M0). Stake inicial: $${config.initialStake.toFixed(2)}`);
    return config.initialStake;
  }

  /**
   * Calcula stake de recuperação (Martingale Inteligente)
   */
  private async calculateRecoveryStake(userId: string): Promise<number> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return 0;
    }

    const mgmtConfig = this.managementModeConfigs[config.managementMode];
    const target = state.totalLosses * mgmtConfig.recoveryTarget;
    const payout = 0.95; // Payout Higher/Lower (95%)

    // Fórmula: stake = target / payout
    const recoveryStake = target / payout;

    await this.saveLog(userId, 'WARN', 'RISK',
      `Ativando recuperação (Martingale M${state.martingaleLevel}). perdas_totais=${state.totalLosses.toFixed(2)}, modo=${config.managementMode}`);
    await this.saveLog(userId, 'INFO', 'RISK',
      `Usando Martingale Inteligente: mudando para contrato Higher/Lower`);
    await this.saveLog(userId, 'INFO', 'RISK',
      `Calculando stake de recuperação: meta=${target.toFixed(2)}, payout=${(payout * 100).toFixed(2)}%, proximo_stake=${recoveryStake.toFixed(2)}`);

    return recoveryStake;
  }

  /**
   * Verifica Stop Loss (Normal ou Blindado)
   */
  private async checkStopLoss(userId: string): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
    }

    const nextStake = await this.getNextStake(userId);

    // Stop Loss Normal
    if (config.stopLossType === 'normal') {
      const totalAtRisk = state.currentLoss + nextStake;
      if (totalAtRisk >= config.dailyLossLimit) {
        await this.saveLog(userId, 'WARN', 'RISK',
          `Risco de ultrapassar Stop Loss! perdasatuais=${state.currentLoss.toFixed(2)}, proximaentrada_calculada=${nextStake.toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}`);
        await this.saveLog(userId, 'WARN', 'RISK',
          `Reduzindo stake para ${(config.dailyLossLimit - state.currentLoss).toFixed(2)} e resetando martingale.`);
        
        // Resetar martingale e reduzir stake
        state.martingaleLevel = 0;
        state.recoveryAttempts = 0;
        
        return {
          action: 'BUY',
          stake: Math.max(0, config.dailyLossLimit - state.currentLoss),
          reason: 'STOP_LOSS_ADJUSTED',
        };
      }
    }

    // Stop Loss Blindado
    if (config.stopLossType === 'blindado' && state.currentProfit > 0) {
      const initialBalance = config.initialBalance || 0;
      const protectedProfit = state.currentProfit * 0.5; // 50% do lucro protegido
      const protectedBalance = initialBalance + protectedProfit;
      const currentBalance = initialBalance + state.currentProfit - state.currentLoss;

      if (currentBalance <= protectedBalance) {
        await this.saveLog(userId, 'INFO', 'RISK',
          `Lucro atual: $${state.currentProfit.toFixed(2)}. Ativando Stop Loss Blindado em $${protectedBalance.toFixed(2)} (garantindo $${protectedProfit.toFixed(2)} de lucro).`);
        await this.saveLog(userId, 'WARN', 'RISK',
          `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${currentBalance.toFixed(2)}. Encerrando operações do dia.`);
        
        // Parar operações
        state.isActive = false;
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET session_status = 'stopped_blindado' WHERE user_id = ?`,
          [userId],
        );

        return { action: 'STOP', reason: 'STOP_LOSS_BLINDADO' };
      }
    }

    return { action: 'WAIT', reason: 'STOP_LOSS_OK' };
  }

  /**
   * Executa trade
   */
  private async executeTrade(userId: string, decision: TradeDecision, analysis: SentinelAnalysis): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || decision.action !== 'BUY') {
      return;
    }

    // Verificar Stop Loss antes de executar
    const stopLossCheck = await this.checkStopLoss(userId);
    if (stopLossCheck.action === 'STOP') {
      return;
    }

    const contractType = decision.contractType || (analysis.direction === 'CALL' ? 'RISE' : 'FALL');
    
    // Se está em Martingale, usar Higher/Lower
    const finalContractType = state.martingaleLevel > 0 ? 'HIGHER' : contractType;

    await this.saveLog(userId, 'INFO', 'API', `Consultando payout para contrato ${finalContractType}...`);

    try {
      // Obter payout via proposal
      const payout = await this.getPayout(config.derivToken, finalContractType, config.symbol, 5);
      const zenixPayout = payout * 0.97; // Markup de 3%

      await this.saveLog(userId, 'DEBUG', 'API', `Payout Deriv: ${(payout * 100).toFixed(2)}%, Payout ZENIX: ${(zenixPayout * 100).toFixed(2)}%`);

      // Executar compra
      await this.saveLog(userId, 'INFO', 'API', 
        `Comprando contrato ${finalContractType}. stake=${decision.stake?.toFixed(2)}, direction=${analysis.direction}`);

      // ✅ Criar registro de trade ANTES de executar
      const tradeId = await this.createTradeRecord(
        userId,
        {
          contractType: finalContractType,
          stakeAmount: decision.stake || config.initialStake,
          duration: 5,
          analysis: analysis,
          payout: zenixPayout,
          entryPrice: 0, // Será atualizado após proposta
        },
      );

      const contractId = await this.buyContract(
        userId,
        config.derivToken,
        finalContractType,
        config.symbol,
        decision.stake || config.initialStake,
        5, // duration em ticks
      );

      if (contractId) {
        state.isWaitingContract = true;
        state.currentContractId = contractId;
        state.currentTradeId = tradeId;
        await this.saveLog(userId, 'INFO', 'API', `Contrato comprado. contract_id=${contractId}, trade_id=${tradeId}`);
        
        // ✅ Atualizar trade com contract_id e entry_price
        await this.updateTradeRecord(tradeId, {
          contractId: contractId,
          entryPrice: 0, // Será atualizado via proposal_open_contract
          status: 'ACTIVE',
        });
      } else {
        // Se falhou, atualizar trade com erro
        await this.updateTradeRecord(tradeId, {
          status: 'ERROR',
          errorMessage: 'Falha ao comprar contrato',
        });
      }
    } catch (error) {
      this.logger.error(`[Sentinel][${userId}] Erro ao executar trade:`, error);
      await this.saveLog(userId, 'ERROR', 'API', `Erro ao executar trade: ${error.message}`);
    }
  }

  /**
   * Obtém payout de um contrato via Deriv API
   */
  private async getPayout(token: string, contractType: string, symbol: string, duration: number): Promise<number> {
    try {
      const response = await this.derivPool.sendRequest(
        token,
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
        10000, // timeout 10s
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
      this.logger.error(`[Sentinel] Erro ao obter payout:`, error);
      // Retornar valores padrão em caso de erro
      if (contractType === 'HIGHER' || contractType === 'LOWER') {
        return 0.98; // 98% para Higher/Lower
      }
      return 0.95; // 95% para Rise/Fall
    }
  }

  /**
   * Compra contrato na Deriv via WebSocket Pool
   */
  private async buyContract(
    userId: string,
    token: string,
    contractType: string,
    symbol: string,
    stake: number,
    duration: number,
  ): Promise<string | null> {
    try {
      // Primeiro, obter proposta
      const proposalResponse = await this.derivPool.sendRequest(
        token,
        {
          proposal: 1,
          amount: stake,
          basis: 'stake',
          contract_type: contractType,
          currency: 'USD',
          duration: duration,
          duration_unit: 't',
          symbol: symbol,
        },
        10000, // timeout 10s
      );

      if (proposalResponse.error) {
        throw new Error(proposalResponse.error.message || 'Erro ao obter proposta');
      }

      if (!proposalResponse.proposal || !proposalResponse.proposal.id) {
        throw new Error('Resposta de proposta inválida');
      }

      const proposalId = proposalResponse.proposal.id;
      const proposalPrice = Number(proposalResponse.proposal.ask_price || 0);

      // Enviar compra
      const buyResponse = await this.derivPool.sendRequest(
        token,
        {
          buy: proposalId,
          price: proposalPrice,
        },
        30000, // timeout 30s
      );

      if (buyResponse.error) {
        throw new Error(buyResponse.error.message || 'Erro ao comprar contrato');
      }

      if (!buyResponse.buy || !buyResponse.buy.contract_id) {
        throw new Error('Resposta de compra inválida');
      }

      const contractId = buyResponse.buy.contract_id;

      // Inscrever para monitorar contrato
      this.derivPool.subscribe(
        token,
        {
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1,
        },
        (contractMsg: any) => {
          if (contractMsg.proposal_open_contract) {
            const contract = contractMsg.proposal_open_contract;
            const state = this.userStates.get(userId);
            
            // ✅ Atualizar entry_price quando disponível
            if (contract.entry_spot && state?.currentTradeId) {
              this.updateTradeRecord(state.currentTradeId, {
                entryPrice: Number(contract.entry_spot),
              }).catch((error) => {
                this.logger.error(`[Sentinel][${userId}] Erro ao atualizar entry_price:`, error);
              });
            }
            
            // Verificar se contrato foi finalizado
            if (contract.is_sold === 1) {
              const profit = Number(contract.profit || 0);
              const win = profit > 0;
              const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
              
              // Processar resultado com userId correto
              this.onContractFinish(
                userId,
                { win, profit, contractId, exitPrice },
              ).catch((error) => {
                this.logger.error(`[Sentinel][${userId}] Erro ao processar resultado:`, error);
              });
              
              // Remover subscription
              this.derivPool.removeSubscription(token, contractId);
            }
          }
        },
        contractId,
      );

      return contractId;
    } catch (error) {
      this.logger.error(`[Sentinel][${userId}] Erro ao comprar contrato:`, error);
      return null;
    }
  }

  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    // O Sentinel processa ticks diretamente, não usa marketAnalysis
    return { action: 'WAIT', reason: 'PROCESSED_BY_TICKS' };
  }

  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string; exitPrice?: number },
  ): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return;
    }

    state.isWaitingContract = false;
    const tradeId = state.currentTradeId;
    state.currentContractId = null;
    state.currentTradeId = null;

    // ✅ Atualizar trade no banco com resultado
    if (tradeId) {
      await this.updateTradeRecord(tradeId, {
        status: result.win ? 'WON' : 'LOST',
        exitPrice: result.exitPrice || 0,
        profitLoss: result.profit,
        closedAt: new Date(),
      });
    }

    if (result.win) {
      await this.saveLog(userId, 'INFO', 'API', 
        `Operação finalizada. result=WIN, profit=${result.profit.toFixed(2)}`);
      
      state.currentProfit += result.profit;
      state.operationsCount++;
      state.lastTradeResult = { win: true, profit: result.profit };

      // Ativar Soros se aplicável
      const mgmtConfig = this.managementModeConfigs[config.managementMode];
      if (state.sorosLevel < mgmtConfig.sorosLevels) {
        state.sorosLevel++;
        await this.saveLog(userId, 'INFO', 'RISK',
          `Ativando Soros Nível ${state.sorosLevel}. stakeanterior=${config.initialStake}, lucro=${result.profit.toFixed(2)}, proximostake=${(result.profit + config.initialStake).toFixed(2)}`);
      } else {
        state.sorosLevel = 0; // Reset após máximo
      }

      // Resetar Martingale em caso de vitória
      state.martingaleLevel = 0;
      state.recoveryAttempts = 0;
      state.consecutiveLosses = 0;
    } else {
      await this.saveLog(userId, 'ERROR', 'API', 
        `Operação finalizada. result=LOSS, loss=${Math.abs(result.profit).toFixed(2)}`);
      
      state.currentLoss += Math.abs(result.profit);
      state.totalLosses += Math.abs(result.profit);
      state.consecutiveLosses++;
      state.operationsCount++;
      state.lastTradeResult = { win: false, profit: result.profit };

      // Ativar Martingale Inteligente
      const mgmtConfig = this.managementModeConfigs[config.managementMode];
      if (mgmtConfig.maxRecoveryAttempts === -1 || state.recoveryAttempts < mgmtConfig.maxRecoveryAttempts) {
        state.martingaleLevel = 1;
        state.recoveryAttempts++;
        state.sorosLevel = 0; // Reset Soros em caso de perda
      } else {
        // Aceitar perda e resetar
        state.martingaleLevel = 0;
        state.recoveryAttempts = 0;
        state.consecutiveLosses = 0;
      }
    }

    // Atualizar estado no banco (incluindo total_trades, total_wins, total_losses)
    await this.dataSource.query(
      `UPDATE autonomous_agent_config 
       SET daily_profit = ?, 
           daily_loss = ?, 
           total_trades = total_trades + 1,
           total_wins = total_wins + ?,
           total_losses = total_losses + ?
       WHERE user_id = ?`,
      [
        state.currentProfit, 
        state.currentLoss, 
        result.win ? 1 : 0,
        result.win ? 0 : 1,
        userId,
      ],
    );

    // Verificar meta de lucro
    if (state.currentProfit >= config.dailyProfitTarget) {
      await this.saveLog(userId, 'INFO', 'RISK',
        `META DE LUCRO ATINGIDA! daily_profit=${state.currentProfit.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)}. Encerrando operações.`);
      await this.saveLog(userId, 'INFO', 'CORE', `Agente em modo de espera. Retornando amanhã.`);
      
      state.isActive = false;
      await this.dataSource.query(
        `UPDATE autonomous_agent_config SET session_status = 'stopped_profit' WHERE user_id = ?`,
        [userId],
      );
    }

    // Verificar limite de perda
    if (state.currentLoss >= config.dailyLossLimit) {
      await this.saveLog(userId, 'WARN', 'RISK',
        `LIMITE DE PERDA ATINGIDO! daily_loss=${state.currentLoss.toFixed(2)}, limit=${config.dailyLossLimit.toFixed(2)}. Encerrando operações.`);
      
      state.isActive = false;
      await this.dataSource.query(
        `UPDATE autonomous_agent_config SET session_status = 'stopped_loss' WHERE user_id = ?`,
        [userId],
      );
    }
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    const state = this.userStates.get(userId);
    if (!state) return null;

    return {
      userId: state.userId,
      isActive: state.isActive,
      currentProfit: state.currentProfit,
      currentLoss: state.currentLoss,
      operationsCount: state.operationsCount,
    };
  }

  async resetDailySession(userId: string): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return;
    }

    state.currentProfit = 0;
    state.currentLoss = 0;
    state.martingaleLevel = 0;
    state.sorosLevel = 0;
    state.totalLosses = 0;
    state.consecutiveLosses = 0;
    state.recoveryAttempts = 0;
    state.isActive = true;

    await this.dataSource.query(
      `UPDATE autonomous_agent_config 
       SET daily_profit = 0, daily_loss = 0, session_status = 'active', session_date = NOW()
       WHERE user_id = ?`,
      [userId],
    );

    this.logger.log(`[Sentinel] ✅ Sessão diária resetada para usuário ${userId}`);
  }

  /**
   * Cria registro de trade no banco de dados
   */
  private async createTradeRecord(
    userId: string,
    trade: {
      contractType: string;
      stakeAmount: number;
      duration: number;
      analysis: SentinelAnalysis;
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
      strategy: 'sentinel',
      tradingMode: config.tradingMode,
      managementMode: config.managementMode,
      technical: {
        emaFast: trade.analysis.technical.emaFast,
        emaSlow: trade.analysis.technical.emaSlow,
        rsi: trade.analysis.technical.rsi,
        momentum: trade.analysis.technical.momentum,
        macd: trade.analysis.technical.macd,
      },
      statistical: {
        digitPattern: trade.analysis.statistical.digitPattern,
        evenCount: trade.analysis.statistical.evenCount,
        oddCount: trade.analysis.statistical.oddCount,
      },
      score: trade.analysis.score,
      confidence: trade.analysis.confidence,
      martingaleLevel: state.martingaleLevel,
      sorosLevel: state.sorosLevel,
      timestamp: new Date().toISOString(),
    };

    const analysisReasoning = `Análise ${config.tradingMode}: Score ${trade.analysis.score.toFixed(1)}%, ` +
      `Direção ${trade.analysis.direction}, ` +
      `EMA Fast=${trade.analysis.technical.emaFast.toFixed(2)}, ` +
      `RSI=${trade.analysis.technical.rsi.toFixed(1)}, ` +
      `Padrão=${trade.analysis.statistical.digitPattern}`;

    try {
      const result = await this.dataSource.query(
        `INSERT INTO autonomous_agent_trades (
          user_id, analysis_data, confidence_score, analysis_reasoning,
          contract_type, contract_duration, entry_price, stake_amount,
          martingale_level, payout, symbol, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())`,
        [
          userId,
          JSON.stringify(analysisData),
          trade.analysis.score,
          analysisReasoning,
          trade.contractType,
          trade.duration,
          trade.entryPrice,
          trade.stakeAmount,
          state.martingaleLevel > 0 ? 'M1' : 'M0',
          trade.payout * 100, // Converter para percentual
          config.symbol,
        ],
      );

      const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
      return insertId || 0;
    } catch (error) {
      this.logger.error(`[Sentinel][${userId}] Erro ao criar registro de trade:`, error);
      return 0;
    }
  }

  /**
   * Atualiza registro de trade no banco de dados
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
      return;
    }

    updateValues.push(tradeId);

    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_trades 
         SET ${updateFields.join(', ')}
         WHERE id = ?`,
        updateValues,
      );
    } catch (error) {
      this.logger.error(`[Sentinel] Erro ao atualizar trade ${tradeId}:`, error);
    }
  }

  /**
   * Salva log no sistema (banco de dados e LogQueueService)
   */
  private async saveLog(userId: string, level: string, module: string, message: string): Promise<void> {
    // ✅ Salvar no banco de dados (autonomous_agent_logs)
    try {
      await this.dataSource.query(
        `INSERT INTO autonomous_agent_logs (user_id, timestamp, log_level, module, message, metadata)
         VALUES (?, NOW(), ?, ?, ?, NULL)`,
        [userId, level.toUpperCase(), module.toUpperCase(), message],
      );
    } catch (error) {
      this.logger.error(`[Sentinel] Erro ao salvar log no banco:`, error);
    }

    // ✅ Salvar via LogQueueService (para exibição em tempo real)
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
        message: `[${module}] - ${message}`,
        icon: this.getLogIcon(level),
        details: { symbol: this.userConfigs.get(userId)?.symbol || 'R_75' },
        tableName: 'autonomous_agent_logs',
      });
    }

    this.logger.log(`[Sentinel][${module}][${userId}] ${message}`);
  }

  private getLogIcon(level: string): string {
    switch (level.toUpperCase()) {
      case 'INFO': return 'ℹ️';
      case 'WARN': return '⚠️';
      case 'ERROR': return '❌';
      case 'DEBUG': return '🔍';
      default: return '📝';
    }
  }
}

// ============================================
// TIPOS ESPECÍFICOS DO SENTINEL
// ============================================

interface SentinelUserConfig extends AutonomousAgentConfig {
  tradingMode: 'veloz' | 'normal' | 'lento';
  managementMode: 'conservador' | 'moderado' | 'agressivo';
  stopLossType: 'normal' | 'blindado';
}

interface SentinelUserState extends AutonomousAgentState {
  martingaleLevel: number;
  sorosLevel: number;
  totalLosses: number;
  consecutiveLosses: number;
  recoveryAttempts: number;
  lastTradeResult: { win: boolean; profit: number } | null;
  currentContractId: string | null;
  currentTradeId: number | null;
  isWaitingContract: boolean;
}

interface SentinelAnalysis {
  score: number;
  direction: 'CALL' | 'PUT' | null;
  technical: TechnicalAnalysis;
  statistical: StatisticalAnalysis;
  confidence: number;
}

interface TechnicalAnalysis {
  emaFast: number;
  emaSlow: number;
  rsi: number;
  momentum: number;
  macd: number;
  direction: 'CALL' | 'PUT' | null;
  score: number;
}

interface StatisticalAnalysis {
  digitPattern: 'strongeven' | 'strongodd' | 'balanced';
  direction: 'CALL' | 'PUT' | null;
  score: number;
  evenCount: number;
  oddCount: number;
}
