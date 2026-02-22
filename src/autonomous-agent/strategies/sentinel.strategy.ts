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
  private readonly processingLocks = new Map<string, boolean>(); // ✅ Lock para evitar processamento simultâneo
  private readonly appId: string;

  // ✅ Pool de conexões WebSocket por token (reutilização - uma conexão por token)
  private wsConnections: Map<
    string,
    {
      ws: WebSocket;
      authorized: boolean;
      currency?: string; // ✅ Adicionado para suportar múltiplas moedas (BRL, USD, etc)
      keepAliveInterval: NodeJS.Timeout | null;
      requestIdCounter: number;
      pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
      subscriptions: Map<string, (msg: any) => void>;
    }
  > = new Map();

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
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '1089';
  }

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
                initial_balance, deriv_token, currency, symbol, agent_type, trading_mode, session_id
         FROM autonomous_agent_config 
         WHERE is_active = TRUE 
           AND agent_type = 'sentinel'
           AND session_status NOT IN ('stopped_profit', 'stopped_loss', 'stopped_blindado')`,
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
          symbol: 'R_100', // ✅ Todos os agentes autônomos sempre usam R_100 (forçar mesmo se banco tiver R_75)
          tradingMode: (user.trading_mode || 'normal').toLowerCase() as 'veloz' | 'normal' | 'lento',
          managementMode: 'moderado', // Default, pode ser configurado
          stopLossType: 'normal', // Default, pode ser configurado
          initialBalance: parseFloat(user.initial_balance) || 0,
          sessionId: user.session_id ? parseInt(user.session_id) : undefined,
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
      lastContractType: undefined,
      picoLucro: 0,
      pisoBlindado: 0,
      stopBlindadoAtivo: false,
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
      symbol: 'R_100', // ✅ Todos os agentes autônomos sempre usam R_100 (forçar mesmo se config tiver R_75)
      tradingMode: ((config as any).tradingMode || 'normal').toLowerCase() as 'veloz' | 'normal' | 'lento',
      managementMode: ((config as any).managementMode || 'moderado').toLowerCase() as 'conservador' | 'moderado' | 'agressivo',
      stopLossType: ((config as any).stopLossType || 'normal').toLowerCase() as 'normal' | 'blindado',
      initialBalance: config.initialBalance || 0,
      sessionId: config.sessionId,
    };

    if (this.userConfigs.has(userId)) {
      // ✅ [FIX] SÓ REATIVAR se não estiver parado
      const state = this.userStates.get(userId);
      if (state && !state.isActive) {
        // Se já está nas configs mas está inativo, só reativar se não for stop
        // Sentinel usa isActive=false para parar no dia.
        // A query do sync já deve filtrar session_status, mas garantimos aqui via isUserActive interno ou similar se necessário.
        // Como o state é resetado no midnight, aqui apenas evitamos o override do sync de 5min.
        return;
      }
      this.userConfigs.set(userId, sentinelConfig);
      return;
    }

    this.userConfigs.set(userId, sentinelConfig);
    this.initializeUserState(userId, sentinelConfig);

    // ✅ PRÉ-AQUECER conexão WebSocket para evitar erro "Conexão não está pronta"
    try {
      this.logger.log(`[Sentinel][${userId}] 🔌 Pré-aquecendo conexão WebSocket...`);
      await this.warmUpConnection(sentinelConfig.derivToken);
      this.logger.log(`[Sentinel][${userId}] ✅ Conexão WebSocket pré-aquecida e pronta`);
    } catch (error) {
      this.logger.warn(`[Sentinel][${userId}] ⚠️ Erro ao pré-aquecer conexão (continuando mesmo assim):`, error.message);
      // Não bloquear ativação se pré-aquecimento falhar
    }

    // Log de ativação
    // ✅ Log de ativação no padrão Orion
    await this.saveLog(
      userId,
      'INFO',
      'CORE',
      `Usuário ATIVADO | Modo: ${sentinelConfig.tradingMode || 'normal'} | Capital: $${sentinelConfig.initialStake.toFixed(2)} | Meta: $${sentinelConfig.dailyProfitTarget.toFixed(2)} | Stop: $${sentinelConfig.dailyLossLimit.toFixed(2)}`,
    );
    const modeConfig = this.tradingModeConfigs[sentinelConfig.tradingMode || 'normal'];
    await this.saveLog(
      userId,
      'INFO',
      'ANALYZER',
      `📊 Aguardando ${modeConfig.ticksToCollect} ticks para análise | Modo: ${sentinelConfig.tradingMode || 'normal'} | Coleta inicial iniciada.`,
    );

    this.logger.log(`[Sentinel] ✅ Usuário ${userId} ativado`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userConfigs.delete(userId);
    this.userStates.delete(userId);
    this.ticks.delete(userId);
    this.logger.log(`[Sentinel] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Verifica se um usuário está ativo
   */
  isUserActive(userId: string): boolean {
    return this.userConfigs.has(userId) && this.userStates.has(userId);
  }

  /**
   * Processa um tick recebido
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    // ✅ Processar para todos os usuários ativos (sempre R_100, ignorar símbolo do banco se for R_75)
    const promises: Promise<void>[] = [];
    const tickSymbol = symbol || 'R_100'; // ✅ Todos os agentes autônomos usam R_100

    // ✅ Log de debug para verificar se está recebendo ticks
    if (this.userConfigs.size > 0) {
      this.logger.debug(`[Sentinel] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);
    }

    for (const [userId, config] of this.userConfigs.entries()) {
      // Sempre processar se o tick for R_100 (todos os agentes autônomos usam R_100)
      if (tickSymbol === 'R_100') {
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

    // ✅ Verificar lock de processamento (evitar múltiplas análises simultâneas)
    if (this.processingLocks.get(userId)) {
      return; // Já está processando, ignorar este tick
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

    // ✅ Verificar novamente se está aguardando resultado (pode ter mudado durante coleta de ticks)
    if (state.isWaitingContract) {
      return;
    }

    // Verificar se tem ticks suficientes para análise
    const modeConfig = this.tradingModeConfigs[config.tradingMode];
    if (userTicks.length < modeConfig.ticksToCollect) {
      // ✅ Log apenas a cada 10 ticks para não poluir (mantido para feedback de progresso)
      if (userTicks.length % 10 === 0) {
        await this.saveLog(
          userId,
          'INFO',
          'ANALYZER',
          `📊 Aguardando ${modeConfig.ticksToCollect - userTicks.length} ticks para análise | Coleta: ${userTicks.length}/${modeConfig.ticksToCollect}`,
        );
      }
      return;
    }

    // ✅ Verificar novamente ANTES de fazer análise (evitar análise desnecessária)
    if (state.isWaitingContract) {
      return;
    }

    // ✅ Setar lock de processamento ANTES de fazer análise
    this.processingLocks.set(userId, true);

    try {
      // ✅ Log periódico removido - apenas logs de decisão serão exibidos

      // Realizar análise
      const analysis = await this.analyze(userId, userTicks);

      // ✅ Verificar novamente APÓS análise (pode ter mudado durante análise)
      if (state.isWaitingContract) {
        this.processingLocks.set(userId, false); // Liberar lock antes de retornar
        return;
      }

      if (analysis) {
        // ✅ Verificar novamente ANTES de processar decisão (pode ter mudado durante análise)
        if (state.isWaitingContract) {
          this.processingLocks.set(userId, false); // Liberar lock antes de retornar
          return;
        }

        // ✅ Log consolidado da análise e conclusão
        const config = this.userConfigs.get(userId);
        const currentState = this.userStates.get(userId);

        // ✅ Verificar novamente (state pode ter mudado)
        if (!config || !currentState || currentState.isWaitingContract) {
          this.processingLocks.set(userId, false); // Liberar lock antes de retornar
          return;
        }

        // Obter configuração do modo de negociação
        const modeConfig = this.tradingModeConfigs[config.tradingMode];

        if (analysis.score >= modeConfig.scoreMinimum && analysis.direction) {
          // ✅ Verificar novamente ANTES de tomar decisão
          if (currentState.isWaitingContract) {
            this.processingLocks.set(userId, false); // Liberar lock antes de retornar
            return;
          }

          // Tomar decisão de trade
          const decision = await this.makeTradeDecision(userId, analysis);

          // ✅ Verificar novamente ANTES de executar compra
          const finalState = this.userStates.get(userId);
          if (!finalState || finalState.isWaitingContract) {
            this.processingLocks.set(userId, false); // Liberar lock antes de retornar
            return;
          }

          if (decision.action === 'BUY') {
            // ✅ Log de decisão de compra
            const reasons: string[] = [];
            if (analysis.technical.direction === analysis.direction) {
              reasons.push(`Técnica: ${analysis.technical.direction} (Score: ${analysis.technical.score.toFixed(1)}%)`);
            }
            if (analysis.statistical.direction === analysis.direction) {
              reasons.push(`Estatística: ${analysis.statistical.digitPattern} (Score: ${analysis.statistical.score.toFixed(1)}%)`);
            }

            // ✅ Log de sinal no padrão Orion
            await this.saveLog(
              userId,
              'INFO',
              'DECISION',
              `🎯 SINAL GERADO: ${analysis.direction} | Score: ${analysis.score.toFixed(1)}%`,
            );

            // ✅ Verificar novamente ANTES de executar (última verificação)
            const execState = this.userStates.get(userId);
            if (!execState || execState.isWaitingContract) {
              await this.saveLog(userId, 'INFO', 'DECISION', '⏸️ Compra bloqueada: aguardando resultado de contrato anterior');
              this.processingLocks.set(userId, false); // Liberar lock antes de retornar
              return;
            }

            await this.executeTrade(userId, decision, analysis);
          } else {
            // ✅ Log de motivo para não comprar
            const reasonMsg = decision.reason === 'STOP_LOSS' ? 'Stop Loss ativado' :
              decision.reason === 'STOP_LOSS_BLINDADO' ? 'Stop Loss Blindado ativado' :
                decision.reason === 'INVALID_STAKE' ? 'Stake inválido' :
                  'Aguardando condições ideais';

            await this.saveLog(userId, 'INFO', 'DECISION',
              `⏸️ COMPRA NEGADA | Score: ${analysis.score.toFixed(1)}% | Direção: ${analysis.direction || 'N/A'} | Motivo: ${reasonMsg}`);
          }
        } else {
          // ✅ Log de análise insuficiente com detalhes
          const missingScore = modeConfig.scoreMinimum - analysis.score;
          const reasons: string[] = [];

          // Verificar motivo de direção N/A
          if (!analysis.direction) {
            const techDir = analysis.technical.direction || 'N/A';
            const statDir = analysis.statistical.direction || 'N/A';

            if (techDir === 'N/A' && statDir === 'N/A') {
              reasons.push('Nenhuma análise indicou direção');
            } else if (techDir !== statDir && techDir !== 'N/A' && statDir !== 'N/A') {
              reasons.push(`Análises divergem: Técnica=${techDir}, Estatística=${statDir} (priorizando técnica)`);
            } else {
              reasons.push('Direção indefinida');
            }
          }

          // Verificar score
          if (analysis.score < modeConfig.scoreMinimum) {
            reasons.push(`Score ${analysis.score.toFixed(1)}% abaixo do mínimo ${modeConfig.scoreMinimum}% (faltam ${missingScore.toFixed(1)}%)`);
          }

          const reasonMsg = reasons.length > 0 ? reasons.join(' | ') : 'Análise insuficiente';

          await this.saveLog(userId, 'INFO', 'DECISION',
            `⏸️ COMPRA NEGADA | Score: ${analysis.score.toFixed(1)}% | Direção: ${analysis.direction || 'N/A'} | Motivo: ${reasonMsg}`);
        }
      }
    } finally {
      // ✅ Sempre liberar lock, mesmo em caso de erro ou retorno antecipado
      this.processingLocks.set(userId, false);
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

    // ✅ LÓGICA MELHORADA: Determinar direção de forma mais flexível
    // 1. Se ambas concordam → usar essa direção (melhor caso)
    // 2. Se apenas técnica tem direção → usar técnica (peso 60%)
    // 3. Se apenas estatística tem direção → usar estatística (peso 40%)
    // 4. Se divergem → priorizar técnica (peso maior)
    // 5. Se nenhuma tem direção → null (N/A)
    let direction: 'CALL' | 'PUT' | null = null;

    if (technicalAnalysis.direction && statisticalAnalysis.direction) {
      // Ambas têm direção
      if (technicalAnalysis.direction === statisticalAnalysis.direction) {
        // Concordam → usar essa direção
        direction = technicalAnalysis.direction;
      } else {
        // Divergem → priorizar técnica (peso maior: 60%)
        direction = technicalAnalysis.direction;
      }
    } else if (technicalAnalysis.direction) {
      // Apenas técnica tem direção → usar técnica
      direction = technicalAnalysis.direction;
    } else if (statisticalAnalysis.direction) {
      // Apenas estatística tem direção → usar estatística
      direction = statisticalAnalysis.direction;
    }
    // Se nenhuma tem direção, direction permanece null (N/A)

    // ✅ REMOVIDO: Logs individuais de análise técnica e estatística
    // Agora apenas o log consolidado será exibido após a decisão

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

    // ✅ OTIMIZAÇÃO: Calcular stake ANTES de verificar Stop Loss (evitar chamada duplicada)
    const stake = await this.getNextStake(userId);

    // Verificar se pode operar
    if (stake <= 0) {
      return { action: 'WAIT', reason: 'INVALID_STAKE' };
    }

    // ✅ Verificar Stop Loss passando o stake já calculado (evitar recalcular)
    const stopLossCheck = await this.checkStopLoss(userId, stake);
    if (stopLossCheck.action === 'STOP') {
      return stopLossCheck;
    }

    // ✅ CORREÇÃO CRÍTICA: Usar o stake ajustado (se houver) do checkStopLoss
    const finalStake = stopLossCheck.stake ? stopLossCheck.stake : stake;

    return {
      action: 'BUY',
      stake: finalStake,
      contractType: analysis.direction === 'CALL' ? 'CALL' : 'PUT',
      reason: stopLossCheck.reason === 'STOP_LOSS_ADJUSTED' ? 'STOP_LOSS_ADJUSTED' : 'SIGNAL_FOUND',
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
      const sorosStake = Math.round((state.lastTradeResult.profit + config.initialStake) * 100) / 100;
      await this.saveLog(userId, 'INFO', 'RISK',
        `Ativando Soros Nível ${state.sorosLevel}. stakeanterior=${config.initialStake}, lucro=${state.lastTradeResult.profit.toFixed(2)}, proximostake=${sorosStake.toFixed(2)}`);
      return sorosStake;
    }

    // Se está em recuperação (Martingale), calcular stake de recuperação
    if (state.martingaleLevel > 0) {
      return await this.calculateRecoveryStake(userId);
    }

    // Stake inicial (já deve estar arredondado, mas garantir)
    const initialStake = Math.round(config.initialStake * 100) / 100;
    await this.saveLog(userId, 'INFO', 'RISK', `Verificando entrada normal (M0). Stake inicial: $${initialStake.toFixed(2)}`);
    return initialStake;
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
    // ✅ Arredondar para 2 casas decimais (requisito da API Deriv)
    const recoveryStake = Math.round((target / payout) * 100) / 100;

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
   * @param userId ID do usuário
   * @param nextStake Stake já calculado (opcional, para evitar recalcular)
   */
  private async checkStopLoss(userId: string, nextStake?: number): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
    }

    // ✅ Usar stake fornecido ou calcular se não foi fornecido
    const stake = nextStake !== undefined ? nextStake : await this.getNextStake(userId);

    // Stop Loss Normal
    if (config.stopLossType === 'normal') {
      const totalAtRisk = state.currentLoss + stake;
      if (totalAtRisk >= config.dailyLossLimit) {
        await this.saveLog(userId, 'WARN', 'RISK',
          `Risco de ultrapassar Stop Loss! perdasatuais=${state.currentLoss.toFixed(2)}, proximaentrada_calculada=${stake.toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}`);
        await this.saveLog(userId, 'WARN', 'RISK',
          `Reduzindo stake para ${(config.dailyLossLimit - state.currentLoss).toFixed(2)} e resetando martingale.`);

        // Resetar martingale e reduzir stake
        state.martingaleLevel = 0;
        state.recoveryAttempts = 0;

        // ✅ Arredondar stake para 2 casas decimais (requisito da API Deriv)
        const adjustedStake = Math.round(Math.max(0, config.dailyLossLimit - state.currentLoss) * 100) / 100;

        if (adjustedStake < 0.35) { // Stake mínimo Deriv
          await this.saveLog(userId, 'WARN', 'RISK', `Stop Loss atingido (Margem insuficiente para trade mínimo). Parando.`);
          return { action: 'STOP', reason: 'STOP_LOSS_LIMIT' };
        }

        return {
          action: 'BUY',
          stake: adjustedStake,
          reason: 'STOP_LOSS_ADJUSTED',
        };
      }
    }

    // 2. Stop Loss Blindado (Efeito Catraca - Lógica Atualizada para igualar Falcon)
    if (config.stopLossType === 'blindado') {
      if (!state.stopBlindadoAtivo) {
        // Ativação (40% da Meta)
        if (state.currentProfit >= config.dailyProfitTarget * 0.40) {
          state.stopBlindadoAtivo = true;
          state.picoLucro = state.currentProfit;
          state.pisoBlindado = state.picoLucro * 0.50; // Piso é 50% do pico

          this.logger.log(`[Sentinel][${userId}] 🔒 STOP BLINDADO ATIVADO! Piso: ${state.pisoBlindado.toFixed(2)}`);
          await this.saveLog(userId, 'INFO', 'RISK',
            `Lucro atual: $${state.currentProfit.toFixed(2)}. Ativando Stop Loss Blindado em $${state.pisoBlindado.toFixed(2)}.`);
        }
      } else {
        // Atualização Dinâmica (Trailing Stop)
        if (state.currentProfit > state.picoLucro) {
          state.picoLucro = state.currentProfit;
          state.pisoBlindado = state.picoLucro * 0.50;

          this.logger.log(`[Sentinel][${userId}] 🔒 BLINDAGEM SUBIU! Novo Piso: ${state.pisoBlindado.toFixed(2)}`);
        }

        // Gatilho de Saída
        if (state.currentProfit <= state.pisoBlindado) {
          this.logger.log(`[Sentinel][${userId}] 🛑 STOP BLINDADO ATINGIDO. Encerrando operações.`);

          await this.saveLog(userId, 'WARN', 'RISK',
            `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${state.currentProfit.toFixed(2)}. Encerrando operações do dia.`);

          // ✅ Pausar operações no banco de dados (Status Pausado/Blindado)
          // Mantém is_active = TRUE para permitir reset automático no dia seguinte
          state.isActive = false; // Pausa em memória
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET session_status = 'stopped_blindado', is_active = TRUE WHERE user_id = ?`,
            [userId],
          );

          return { action: 'STOP', reason: 'STOP_LOSS_BLINDADO' };
        }
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

    this.logger.log(`[Sentinel][${userId}] 🎬 executeTrade chamado: action=${decision.action}, stake=$${decision.stake?.toFixed(2) || '0.00'}`);

    if (!config || !state || decision.action !== 'BUY') {
      this.logger.warn(`[Sentinel][${userId}] ⚠️ executeTrade abortado: config=${!!config}, state=${!!state}, action=${decision.action}`);
      return;
    }

    // ✅ Verificar se já está aguardando resultado de contrato (dupla verificação de segurança)
    if (state.isWaitingContract) {
      this.logger.warn(`[Sentinel][${userId}] ⚠️ Tentativa de compra bloqueada: já aguardando resultado de contrato anterior`);
      return;
    }

    // ✅ Verificar Stop Loss antes de executar, passando o stake já calculado
    const stopLossCheck = await this.checkStopLoss(userId, decision.stake || config.initialStake);
    if (stopLossCheck.action === 'STOP') {
      this.logger.warn(`[Sentinel][${userId}] 🛑 executeTrade bloqueado por Stop Loss: ${stopLossCheck.reason}`);
      return;
    }

    const contractType = decision.contractType || (analysis.direction === 'CALL' ? 'CALL' : 'PUT');

    // ✅ Para R_100, sempre usar CALL/PUT (não HIGHER/LOWER)
    const finalContractType = contractType;

    // ✅ Salvar tipo de contrato para usar no log de resultado
    state.lastContractType = finalContractType;

    // ✅ IMPORTANTE: Setar isWaitingContract ANTES de comprar para bloquear qualquer nova análise/compra
    state.isWaitingContract = true;

    // Payout fixo: 92.15%
    const zenixPayout = 0.9215;

    try {
      // ✅ Criar registro de trade ANTES de executar
      const tradeId = await this.createTradeRecord(
        userId,
        {
          contractType: finalContractType,
          stakeAmount: decision.stake || config.initialStake,
          duration: 5,
          analysis: analysis,
          payout: zenixPayout,
          entryPrice: 0, // Será atualizado via proposal_open_contract
        },
      );

      this.logger.log(`[Sentinel][${userId}] 🛒 Chamando buyContract: ${finalContractType} | Stake: $${(decision.stake || config.initialStake).toFixed(2)} | Duration: 5 ticks`);

      const contractId = await this.buyContract(
        userId,
        config.derivToken,
        finalContractType,
        config.symbol,
        decision.stake || config.initialStake,
        5, // duration em ticks
      );

      this.logger.log(`[Sentinel][${userId}] ${contractId ? '✅' : '❌'} buyContract retornou: ${contractId || 'NULL'}`);

      if (contractId) {
        state.currentContractId = contractId;
        state.currentTradeId = tradeId;

        // ✅ Log de operação no padrão Orion
        await this.saveLog(
          userId,
          'INFO',
          'TRADER',
          `⚡ ENTRADA CONFIRMADA: ${finalContractType} | Valor: $${(decision.stake || config.initialStake).toFixed(2)}`,
        );

        // ✅ Atualizar trade com contract_id e entry_price
        await this.updateTradeRecord(tradeId, {
          contractId: contractId,
          entryPrice: 0, // Será atualizado via proposal_open_contract
          status: 'ACTIVE',
        });
      } else {
        // Se falhou, resetar isWaitingContract e atualizar trade com erro
        state.isWaitingContract = false;
        await this.updateTradeRecord(tradeId, {
          status: 'ERROR',
          errorMessage: 'Falha ao comprar contrato',
        });
        await this.saveLog(userId, 'ERROR', 'API', 'Falha ao comprar contrato. Aguardando novo sinal...');
      }
    } catch (error) {
      // Se houve erro, resetar isWaitingContract
      state.isWaitingContract = false;
      this.logger.error(`[Sentinel][${userId}] Erro ao executar trade:`, error);
      await this.saveLog(userId, 'ERROR', 'API', `Erro ao executar trade: ${error.message}. Aguardando novo sinal...`);
    }
  }

  /**
   * Obtém payout de um contrato via Deriv API
   */
  private async getPayout(token: string, contractType: string, symbol: string, duration: number): Promise<number> {
    try {
      // ✅ Obter conexão do pool interno
      const connection = await this.getOrCreateWebSocketConnection(token);

      const response = await connection.sendRequest(
        {
          proposal: 1,
          amount: 1,
          basis: 'stake',
          contract_type: contractType,
          currency: connection.currency || 'USD', // ✅ Usar moeda real da conta
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

      throw new Error('Resposta de proposal inválida');
    } catch (error) {
      this.logger.error(`[Sentinel] Erro ao obter payout:`, error);
      // ✅ Para R_100, sempre retornar 92.15% (payout fixo)
      return 0.9215;
    }
  }

  /**
   * Pré-aquece conexão WebSocket para garantir que esteja pronta
   * Envia um ping simples para forçar criação e autorização da conexão
   */
  private async warmUpConnection(token: string): Promise<void> {
    try {
      // ✅ Obter conexão do pool interno (isso já cria e autoriza a conexão)
      const connection = await this.getOrCreateWebSocketConnection(token);

      // Enviar ping para confirmar que está funcionando
      await connection.sendRequest({ ping: 1 }, 5000);
      this.logger.debug(`[Sentinel] ✅ Conexão WebSocket pré-aquecida com sucesso`);
    } catch (error) {
      // Ignorar erro de ping, o importante é criar a conexão
      // A conexão foi criada mesmo que o ping tenha falhado
      this.logger.debug(`[Sentinel] 🔌 Conexão criada (ping falhou mas conexão foi estabelecida)`);
    }
  }

  /**
   * Compra contrato na Deriv via WebSocket Pool Interno com retry automático
   */
  private async buyContract(
    userId: string,
    token: string,
    contractType: string,
    symbol: string,
    stake: number,
    duration: number,
    maxRetries = 2,
  ): Promise<string | null> {
    const roundedStake = Math.round(stake * 100) / 100;
    let lastError: Error | null = null;

    // ✅ CORREÇÃO: Delay inicial de 3000ms antes da primeira tentativa
    // Isso dá tempo para a conexão WebSocket se estabilizar e AUTORIZAR
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ✅ Retry com backoff exponencial
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // ✅ Backoff exponencial: 1s, 2s, 4s...
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          this.logger.warn(`[Sentinel][${userId}] 🔄 Tentativa ${attempt + 1}/${maxRetries + 1} após ${delayMs}ms | Erro anterior: ${lastError?.message}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // ✅ Obter conexão do pool interno
        const connection = await this.getOrCreateWebSocketConnection(token, userId);

        // ✅ Primeiro, obter proposta (usando timeout de 60s como Orion)
        const proposalResponse = await connection.sendRequest(
          {
            proposal: 1,
            amount: roundedStake,
            basis: 'stake',
            contract_type: contractType,
            currency: connection.currency || 'USD', // ✅ Usar moeda real da conta
            duration: duration,
            duration_unit: 't',
            symbol: symbol,
          },
          60000, // timeout 60s (igual Orion)
        );

        // ✅ Verificar erros na resposta (pode estar em error ou proposal.error) - igual Orion
        const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
        if (errorObj) {
          const errorCode = errorObj?.code || '';
          const errorMessage = errorObj?.message || JSON.stringify(errorObj);

          // ✅ Alguns erros não devem ser retentados (ex: saldo insuficiente, parâmetros inválidos)
          const nonRetryableErrors = ['InvalidAmount', 'InsufficientBalance', 'InvalidContract', 'InvalidSymbol'];
          if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
            this.logger.error(`[Sentinel][${userId}] ❌ Erro não retentável na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
            throw new Error(errorMessage);
          }

          // ✅ Erros retentáveis: tentar novamente
          lastError = new Error(errorMessage);
          if (attempt < maxRetries) {
            this.logger.warn(`[Sentinel][${userId}] ⚠️ Erro retentável na proposta (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
            continue;
          }

          this.logger.error(`[Sentinel][${userId}] ❌ Erro na proposta após ${maxRetries + 1} tentativas: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
          throw lastError;
        }

        const proposalId = proposalResponse.proposal?.id;
        const proposalPrice = Number(proposalResponse.proposal?.ask_price || 0);

        if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
          lastError = new Error('Resposta de proposta inválida');
          if (attempt < maxRetries) {
            this.logger.warn(`[Sentinel][${userId}] ⚠️ Proposta inválida (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(proposalResponse)}`);
            continue;
          }
          this.logger.error(`[Sentinel][${userId}] ❌ Proposta inválida recebida após ${maxRetries + 1} tentativas: ${JSON.stringify(proposalResponse)}`);
          throw lastError;
        }

        // ✅ Enviar compra
        const buyResponse = await connection.sendRequest(
          {
            buy: proposalId,
            price: proposalPrice,
          },
          60000, // timeout 60s (igual Orion)
        );

        // ✅ Verificar erros na resposta - igual Orion
        const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
        if (buyErrorObj) {
          const errorCode = buyErrorObj?.code || '';
          const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);

          // ✅ Alguns erros não devem ser retentados
          const nonRetryableErrors = ['InvalidProposal', 'ProposalExpired', 'InsufficientBalance'];
          if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
            this.logger.error(`[Sentinel][${userId}] ❌ Erro não retentável ao comprar: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
            throw new Error(errorMessage);
          }

          // ✅ Erros retentáveis: tentar novamente (mas precisa obter nova proposta)
          lastError = new Error(errorMessage);
          if (attempt < maxRetries) {
            this.logger.warn(`[Sentinel][${userId}] ⚠️ Erro retentável ao comprar (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
            continue;
          }

          this.logger.error(`[Sentinel][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
          throw lastError;
        }

        const contractId = buyResponse.buy?.contract_id;
        if (!contractId) {
          lastError = new Error('Resposta de compra inválida - sem contract_id');
          if (attempt < maxRetries) {
            this.logger.warn(`[Sentinel][${userId}] ⚠️ Contrato sem contract_id (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(buyResponse)}`);
            continue;
          }
          this.logger.error(`[Sentinel][${userId}] ❌ Contrato criado mas sem contract_id após ${maxRetries + 1} tentativas: ${JSON.stringify(buyResponse)}`);
          throw lastError;
        }

        // ✅ Inscrever para monitorar contrato usando pool interno
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

              // ✅ Log de debug para rastrear atualizações do contrato
              this.logger.debug(`[Sentinel][${userId}] 📊 Atualização do contrato ${contractId}: is_sold=${contract.is_sold} (tipo: ${typeof contract.is_sold}), status=${contract.status}, profit=${contract.profit}`);

              // ✅ Atualizar entry_price quando disponível
              if (contract.entry_spot && state?.currentTradeId) {
                this.updateTradeRecord(state.currentTradeId, {
                  entryPrice: Number(contract.entry_spot),
                }).catch((error) => {
                  this.logger.error(`[Sentinel][${userId}] Erro ao atualizar entry_price:`, error);
                });
              }

              // ✅ Verificar se contrato foi rejeitado, cancelado ou expirado
              if (contract.status === 'rejected' || contract.status === 'cancelled' || contract.status === 'expired') {
                const errorMsg = `Contrato ${contract.status}: ${contract.error_message || 'Sem mensagem de erro'}`;
                this.logger.error(`[Sentinel][${userId}] ❌ Contrato ${contractId} foi ${contract.status}: ${errorMsg}`);

                if (state?.currentTradeId) {
                  this.updateTradeRecord(state.currentTradeId, {
                    status: 'ERROR',
                    errorMessage: errorMsg,
                  }).catch((error) => {
                    this.logger.error(`[Sentinel][${userId}] Erro ao atualizar trade com status ERROR:`, error);
                  });
                }

                if (state) {
                  // ✅ Adicionar cooldown de 15s após erro para evitar spam
                  state.cooldownUntilTs = Date.now() + 15000;
                  this.saveLog(userId, 'ERROR', 'API', `Erro na Corretora ao executar sinal.`);

                  state.isWaitingContract = false;
                  state.currentContractId = null;
                  state.currentTradeId = null;
                }

                // Remover subscription usando pool interno
                connection.removeSubscription(contractId);
                return;
              }

              // ✅ Verificar se contrato foi finalizado (igual Orion)
              // Aceitar tanto is_sold (1 ou true) quanto status ('won', 'lost', 'sold')
              const isFinalized = contract.is_sold === 1 || contract.is_sold === true ||
                contract.status === 'won' || contract.status === 'lost' || contract.status === 'sold';

              if (isFinalized) {
                const profit = Number(contract.profit || 0);
                const win = profit > 0;
                const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);

                this.logger.log(`[Sentinel][${userId}] ✅ Contrato ${contractId} finalizado: ${win ? 'WIN' : 'LOSS'} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Exit: ${exitPrice}`);

                // Processar resultado com userId correto
                this.onContractFinish(
                  userId,
                  { win, profit, contractId, exitPrice },
                ).catch((error) => {
                  this.logger.error(`[Sentinel][${userId}] Erro ao processar resultado:`, error);
                });

                // Remover subscription usando pool interno
                connection.removeSubscription(contractId);
              }
            }
          },
          contractId,
          90000, // timeout 90s
        );

        // ✅ Se chegou aqui, sucesso!
        return contractId;
      } catch (error: any) {
        lastError = error;
        const errorMessage = error?.message || JSON.stringify(error);

        // ✅ Verificar se é erro de timeout ou conexão (retentável)
        const isRetryableError = errorMessage.includes('Timeout') ||
          errorMessage.includes('WebSocket') ||
          errorMessage.includes('Conexão') ||
          errorMessage.includes('not ready') ||
          errorMessage.includes('not open');

        if (isRetryableError && attempt < maxRetries) {
          this.logger.warn(`[Sentinel][${userId}] ⚠️ Erro retentável (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
          continue;
        }

        // ✅ Se não é retentável ou esgotou tentativas, logar e retornar null
        if (attempt >= maxRetries) {
          this.logger.error(`[Sentinel][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${errorMessage}`, error?.stack);
        } else {
          this.logger.error(`[Sentinel][${userId}] ❌ Erro não retentável ao comprar contrato: ${errorMessage}`, error?.stack);
        }
        return null;
      }
    }

    // ✅ Se chegou aqui, todas as tentativas falharam
    this.logger.error(`[Sentinel][${userId}] ❌ Falha ao comprar contrato após ${maxRetries + 1} tentativas: ${lastError?.message || 'Erro desconhecido'}`);
    return null;
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
      this.logger.warn(`[Sentinel][${userId}] ⚠️ onContractFinish chamado mas config ou state não encontrado`);
      return;
    }

    const tradeId = state.currentTradeId;
    // state.isWaitingContract = false; // Removido daqui para evitar race condition
    state.currentContractId = null;
    state.currentTradeId = null;

    this.logger.log(`[Sentinel][${userId}] 📋 Processando resultado do contrato ${result.contractId} | TradeId: ${tradeId} | Win: ${result.win} | Profit: ${result.profit}`);

    // ✅ Atualizar trade no banco com resultado
    if (tradeId) {
      try {
        await this.updateTradeRecord(tradeId, {
          status: result.win ? 'WON' : 'LOST',
          exitPrice: result.exitPrice || 0,
          profitLoss: result.profit,
          closedAt: new Date(),
        });
        this.logger.log(`[Sentinel][${userId}] ✅ Trade ${tradeId} atualizado no banco de dados`);
      } catch (error) {
        this.logger.error(`[Sentinel][${userId}] ❌ Erro ao atualizar trade ${tradeId} no banco:`, error);
      }
    } else {
      this.logger.warn(`[Sentinel][${userId}] ⚠️ onContractFinish chamado mas tradeId é null/undefined`);
    }

    // Atualizar estado primeiro
    if (result.win) {
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

    // ✅ Atualizar estado no banco PRIMEIRO (incluindo total_trades, total_wins, total_losses)
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

    // ✅ Logs detalhados do resultado (formato igual à Orion)
    const status = result.win ? 'WON' : 'LOST';
    const contractType = state.lastContractType || 'CALL'; // Usar último tipo de contrato executado
    const pnl = result.profit >= 0 ? `+$${result.profit.toFixed(2)}` : `-$${Math.abs(result.profit).toFixed(2)}`;

    // ✅ Log de resultado no padrão Orion: ✅ GANHOU ou ❌ PERDEU | direção | P&L: $+X.XX
    await this.saveLog(
      userId,
      'INFO',
      'TRADER',
      `${result.win ? '✅ GANHOU' : '❌ PERDEU'} | ${contractType} | P&L: $${result.profit >= 0 ? '+' : ''}${result.profit.toFixed(2)}`,
    );

    this.logger.log(`[SENTINEL][${userId}] ${status} | P&L: $${result.profit.toFixed(2)}`);

    // Verificar meta de lucro
    if (state.currentProfit >= config.dailyProfitTarget) {
      await this.saveLog(userId, 'INFO', 'RISK',
        `META DE LUCRO ATINGIDA! daily_profit=${state.currentProfit.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)}. Encerrando operações.`);
      await this.saveLog(userId, 'INFO', 'CORE', `Agente em modo de espera. Retornando amanhã.`);

      state.isActive = false; // Pausa em memória para o dia
      // Mantém is_active = TRUE para permitir reset automático no dia seguinte
      try {
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET session_status = 'stopped_profit', is_active = TRUE WHERE user_id = ?`,
          [userId],
        );
      } catch (error) {
        this.logger.error(`[Sentinel][${userId}] ❌ Erro ao atualizar status para profit:`, error);
      }
    }

    // Verificar limite de perda
    if (state.currentLoss >= config.dailyLossLimit) {
      await this.saveLog(userId, 'WARN', 'RISK',
        `LIMITE DE PERDA ATINGIDO! daily_loss=${state.currentLoss.toFixed(2)}, limit=${config.dailyLossLimit.toFixed(2)}. Pausando operações até amanhã.`);

      state.isActive = false; // Pausa em memória para o dia
      // Mantém is_active = TRUE para permitir reset automático no dia seguinte
      try {
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET session_status = 'stopped_loss', is_active = TRUE WHERE user_id = ?`,
          [userId],
        );
      } catch (error) {
        this.logger.error(`[Sentinel][${userId}] ❌ Erro ao atualizar status para loss:`, error);
      }
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
          user_id, session_id, analysis_data, confidence_score, analysis_reasoning,
          contract_type, contract_duration, entry_price, stake_amount,
          martingale_level, payout, symbol, status, strategy, deriv_token, deriv_account_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'sentinel', ?, ?, NOW())`,
        [
          userId,
          config.sessionId || null,
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
          config.derivToken || null, // ✅ Token usado para o trade
          config.currency === 'DEMO' ? 'demo' : 'real', // ✅ Tipo de conta (demo/real) derivado de currency
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
      this.logger.warn(`[Sentinel] ⚠️ Tentativa de atualizar trade ${tradeId} sem campos para atualizar`);
      return;
    }

    updateValues.push(tradeId);

    try {
      this.logger.debug(`[Sentinel] 📝 Atualizando trade ${tradeId}: ${updateFields.join(', ')}`);
      await this.dataSource.query(
        `UPDATE autonomous_agent_trades 
         SET ${updateFields.join(', ')}
         WHERE id = ?`,
        updateValues,
      );
      this.logger.debug(`[Sentinel] ✅ Trade ${tradeId} atualizado com sucesso`);
    } catch (error) {
      this.logger.error(`[Sentinel] ❌ Erro ao atualizar trade ${tradeId}:`, error);
      throw error; // ✅ Re-throw para que o erro seja visível
    }
  }

  /**
   * Salva log no sistema (via LogQueueService que salva no banco)
   * ✅ Evita duplicação: salva apenas uma vez via LogQueueService
   */
  private async saveLog(userId: string, level: string, module: string, message: string): Promise<void> {
    // ✅ Formatar mensagem sem duplicar prefixo do módulo
    let formattedMessage = message;
    // Remover prefixos duplicados se existirem (ex: [CORE] - mensagem)
    formattedMessage = formattedMessage.replace(/^\[.*?\]\s*-\s*/g, '');

    // ✅ Salvar APENAS via LogQueueService (evita duplicação)
    // O LogQueueService já salva no banco de dados automaticamente
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
        message: formattedMessage, // Usar mensagem formatada sem duplicar prefixo
        icon: this.getLogIcon(level),
        details: { symbol: this.userConfigs.get(userId)?.symbol || 'R_100' },
        tableName: 'autonomous_agent_logs',
      });
    }

    this.logger.log(`[Sentinel][${module}][${userId}] ${formattedMessage}`);
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

  // ============================================
  // MÉTODOS DE GERENCIAMENTO DE WEBSOCKET (Pool Interno)
  // Copiados da Orion Strategy
  // ============================================

  /**
   * ✅ Obtém ou cria conexão WebSocket reutilizável por token
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    currency?: string; // ✅ Adicionado
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    // ✅ Verificar se já existe conexão para este token
    const existing = this.wsConnections.get(token);
    if (existing) {
      const readyState = existing.ws.readyState;
      const readyStateText = readyState === WebSocket.OPEN ? 'OPEN' :
        readyState === WebSocket.CONNECTING ? 'CONNECTING' :
          readyState === WebSocket.CLOSING ? 'CLOSING' :
            readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN';

      this.logger.debug(`[SENTINEL] 🔍 [${userId || 'SYSTEM'}] Conexão encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);

      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        this.logger.debug(`[SENTINEL] ♻️ [${userId || 'SYSTEM'}] ✅ Reutilizando conexão WebSocket existente`);

        return {
          ws: existing.ws,
          currency: existing.currency, // ✅ Retornar moeda existente
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
            this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      }
    } else {
      this.logger.debug(`[SENTINEL] 🔍 [${userId || 'SYSTEM'}] Nenhuma conexão existente encontrada para token ${token.substring(0, 8)}`);
    }

    // ✅ Criar nova conexão
    this.logger.debug(`[SENTINEL] 🔌 [${userId || 'SYSTEM'}] Criando nova conexão WebSocket para token`);
    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      let authResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          this.logger.error(`[SENTINEL] ❌ [${userId || 'SYSTEM'}] Timeout na autorização após 20s. Estado: readyState=${socket.readyState}`);
          socket.close();
          this.wsConnections.delete(token);
          reject(new Error('Timeout ao conectar e autorizar WebSocket (20s)'));
        }
      }, 20000);

      // ✅ Listener de mensagens para capturar autorização e outras respostas
      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          // ✅ Ignorar ping/pong
          if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
            return;
          }

          const conn = this.wsConnections.get(token);
          if (!conn) {
            this.logger.warn(`[SENTINEL] ⚠️ [${userId || 'SYSTEM'}] Mensagem recebida mas conexão não encontrada no pool para token ${token.substring(0, 8)}`);
            return;
          }

          // ✅ Processar autorização (apenas durante inicialização)
          if (msg.msg_type === 'authorize' && !authResolved) {
            this.logger.debug(`[SENTINEL] 🔐 [${userId || 'SYSTEM'}] Processando resposta de autorização...`);
            authResolved = true;
            clearTimeout(connectionTimeout);

            if (msg.error || (msg.authorize && msg.authorize.error)) {
              const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autorização';
              this.logger.error(`[SENTINEL] ❌ [${userId || 'SYSTEM'}] Erro na autorização: ${errorMsg}`);
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(`Erro na autorização: ${errorMsg}`));
              return;
            }

            conn.authorized = true;
            conn.currency = msg.authorize?.currency || 'USD'; // ✅ Capturar moeda real
            this.logger.log(`[SENTINEL] ✅ [${userId || 'SYSTEM'}] Autorizado com sucesso | LoginID: ${msg.authorize?.loginid || 'N/A'} | Moeda: ${conn.currency}`);

            // ✅ Iniciar keep-alive
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send(JSON.stringify({ ping: 1 }));
                  this.logger.debug(`[SENTINEL][KeepAlive][${token.substring(0, 8)}] Ping enviado`);
                } catch (error) {
                  // Ignorar erros
                }
              }
            }, 90000);

            resolve({
              ws: socket,
              currency: conn.currency, // ✅ Retornar moeda
              sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
              subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
                this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
              removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
            } as any);
            return;
          }

          // ✅ Processar mensagens de subscription (proposal_open_contract) - PRIORIDADE 1
          if (msg.proposal_open_contract) {
            const contractId = msg.proposal_open_contract.contract_id;
            if (contractId && conn.subscriptions.has(contractId)) {
              const callback = conn.subscriptions.get(contractId)!;
              callback(msg);
              return;
            }
          }

          // ✅ Processar respostas de requisições (ROTEAMENDO POR REQ_ID / PASSTHROUGH) - PRIORIDADE 2
          const reqId = msg.req_id || (msg.echo_req?.passthrough?.req_id);

          if (reqId && conn.pendingRequests.has(reqId)) {
            const pending = conn.pendingRequests.get(reqId);
            if (pending) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(reqId);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                pending.resolve(msg);
              }
              return; // Resolvido
            }
          }

          // ✅ FALLBACK: Processar por tipo se não tiver reqId (Apenas para garantir compatibilidade)
          if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
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
        this.logger.log(`[SENTINEL] ✅ [${userId || 'SYSTEM'}] WebSocket conectado, enviando autorização...`);

        // ✅ Criar entrada no pool
        const conn = {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        };
        this.wsConnections.set(token, conn);

        // ✅ Enviar autorização
        const authPayload = { authorize: token };
        this.logger.debug(`[SENTINEL] 📤 [${userId || 'SYSTEM'}] Enviando autorização: ${JSON.stringify({ authorize: token.substring(0, 8) + '...' })}`);
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
        this.logger.debug(`[SENTINEL] 🔌 [${userId || 'SYSTEM'}] WebSocket fechado`);
        const conn = this.wsConnections.get(token);
        if (conn) {
          if (conn.keepAliveInterval) {
            clearInterval(conn.keepAliveInterval);
          }
          // Rejeitar todas as requisições pendentes
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
          reject(new Error('WebSocket fechado antes da autorização'));
        }
      });
    });

    const conn = this.wsConnections.get(token)!;
    return {
      ws: conn.ws,
      currency: conn.currency, // ✅ Retornar a moeda capturada
      sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
      subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
      removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
    };
  }

  /**
   * ✅ Envia requisição via conexão existente
   */
  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    return new Promise((resolve, reject) => {
      const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });

      // ✅ Garantir que o req_id vá na requisição para roteamento seguro
      const enrichedPayload = {
        ...payload,
        passthrough: {
          ...payload.passthrough,
          req_id: requestId,
          origin: 'autonomous_agent'
        }
      };


      conn.ws.send(JSON.stringify(enrichedPayload));
    });
  }

  /**
   * ✅ Inscreve-se para atualizações via conexão existente
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
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    // ✅ Aguardar primeira resposta para confirmar subscription
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.subscriptions.delete(subId);
        reject(new Error(`Timeout ao inscrever ${subId}`));
      }, timeoutMs);

      // ✅ Callback wrapper que confirma subscription na primeira mensagem
      const wrappedCallback = (msg: any) => {
        // ✅ Primeira mensagem confirma subscription
        if (msg.proposal_open_contract || msg.error) {
          clearTimeout(timeout);
          if (msg.error) {
            conn.subscriptions.delete(subId);
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
          // ✅ Subscription confirmada, substituir por callback original
          conn.subscriptions.set(subId, callback);
          resolve();
          // ✅ Chamar callback original com primeira mensagem
          callback(msg);
          return;
        }
        // ✅ Se não for primeira mensagem, já deve estar usando callback original
        callback(msg);
      };

      conn.subscriptions.set(subId, wrappedCallback);
      conn.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * ✅ Remove subscription da conexão
   */
  private removeSubscriptionFromConnection(token: string, subId: string): void {
    const conn = this.wsConnections.get(token);
    if (conn) {
      conn.subscriptions.delete(subId);
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
  lastContractType?: string; // ✅ Tipo do último contrato executado (para logs)
  picoLucro: number;
  pisoBlindado: number;
  stopBlindadoAtivo: boolean;
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
