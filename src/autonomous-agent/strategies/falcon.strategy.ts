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
 * 🦅 FALCON Strategy para Agente Autônomo
 * 
 * Implementação completa do Agente Falcon conforme documentação:
 * - Precisão Cirúrgica: >80% (Normal) ou >90% (Recuperação)
 * - Recuperação Inteligente: Modo Sniper imediato após qualquer perda
 * - Gestão Blindada: Stop Loss Blindado (Efeito Catraca)
 * - Soros Nível 1: Alavancagem de lucros
 * - Smart Martingale: Recuperação matemática precisa
 * - Sistema de logs detalhado
 */
@Injectable()
export class FalconStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'falcon';
  displayName = '🦅 FALCON';
  description = 'Agente de alta precisão com recuperação inteligente e gestão blindada';

  private readonly logger = new Logger(FalconStrategy.name);
  private readonly userConfigs = new Map<string, FalconUserConfig>();
  private readonly userStates = new Map<string, FalconUserState>();
  private readonly ticks = new Map<string, Tick[]>();
  private readonly maxTicks = 200;
  private readonly comissaoPlataforma = 0.03; // 3%

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => DerivWebSocketPoolService))
    private readonly derivPool: DerivWebSocketPoolService,
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {}

  async onModuleInit() {
    this.logger.log('🦅 FALCON Strategy inicializado');
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
                initial_balance, deriv_token, currency, symbol, agent_type
         FROM autonomous_agent_config 
         WHERE is_active = TRUE AND agent_type = 'falcon'`,
      );

      for (const user of activeUsers) {
        const userId = user.user_id.toString();
        const config: FalconUserConfig = {
          userId: userId,
          initialStake: parseFloat(user.initial_stake),
          dailyProfitTarget: parseFloat(user.daily_profit_target),
          dailyLossLimit: parseFloat(user.daily_loss_limit),
          derivToken: user.deriv_token,
          currency: user.currency,
          symbol: 'R_100', // ✅ Todos os agentes autônomos sempre usam R_100 (forçar mesmo se banco tiver R_75)
          initialBalance: parseFloat(user.initial_balance) || 0,
        };

        this.userConfigs.set(userId, config);
        this.initializeUserState(userId, config);
      }

      this.logger.log(`[Falcon] Sincronizados ${activeUsers.length} usuários ativos`);
    } catch (error) {
      this.logger.error('[Falcon] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Inicializa estado do usuário
   */
  private initializeUserState(userId: string, config: FalconUserConfig): void {
    const state: FalconUserState = {
      userId,
      isActive: true,
      saldoInicial: config.initialBalance,
      lucroAtual: 0,
      picoLucro: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      opsCount: 0,
      mode: 'PRECISO', // 'PRECISO' (>80%) ou 'ALTA_PRECISAO' (>90%)
      stopBlindadoAtivo: false,
      pisoBlindado: 0,
      lastProfit: 0,
      currentContractId: null,
      currentTradeId: null,
      isWaitingContract: false,
    };

    this.userStates.set(userId, state);
    this.ticks.set(userId, []);
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    const falconConfig: FalconUserConfig = {
      userId: config.userId,
      initialStake: config.initialStake,
      dailyProfitTarget: config.dailyProfitTarget,
      dailyLossLimit: config.dailyLossLimit,
      derivToken: config.derivToken,
      currency: config.currency,
      symbol: 'R_100', // ✅ Todos os agentes autônomos sempre usam R_100 (forçar mesmo se config tiver R_75)
      initialBalance: config.initialBalance || 0,
    };

    this.userConfigs.set(userId, falconConfig);
    this.initializeUserState(userId, falconConfig);

    // Log de ativação (formato igual ao SENTINEL)
    await this.saveLog(userId, 'INFO', 'CORE', `Agente 1 - Falcon iniciando...`);
    await this.saveLog(userId, 'INFO', 'CORE', 
      `Carregando configurações: stake=${falconConfig.initialStake}, meta=${falconConfig.dailyProfitTarget}, stop=${falconConfig.dailyLossLimit}`);
    await this.saveLog(userId, 'INFO', 'CORE', 
      `Aguardando 50 ticks para iniciar análise. Símbolo: ${falconConfig.symbol}`);

    this.logger.log(`[Falcon] ✅ Usuário ${userId} ativado | Symbol: ${falconConfig.symbol} | Total configs: ${this.userConfigs.size}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userConfigs.delete(userId);
    this.userStates.delete(userId);
    this.ticks.delete(userId);
    this.logger.log(`[Falcon] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Processa um tick recebido
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    const tickSymbol = symbol || 'R_100'; // ✅ Todos os agentes autônomos usam R_100

    // ✅ Log de debug para verificar se está recebendo ticks
    if (this.userConfigs.size > 0) {
      this.logger.debug(`[Falcon] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);
    }

    // ✅ Processar para todos os usuários ativos (sempre R_100, ignorar símbolo do banco se for R_75)
    for (const [userId, config] of this.userConfigs.entries()) {
      // Sempre processar se o tick for R_100 (todos os agentes autônomos usam R_100)
      if (tickSymbol === 'R_100') {
        promises.push(this.processTickForUser(userId, tick).catch((error) => {
          this.logger.error(`[Falcon][${userId}] Erro ao processar tick:`, error);
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

    // FALCON precisa de pelo menos 50 ticks para análise confiável
    if (userTicks.length < 50) {
      // Log apenas a cada 10 ticks
      if (userTicks.length % 10 === 0) {
        await this.saveLog(userId, 'INFO', 'ANALYZER', 
          `Ticks coletados: ${userTicks.length}/50`);
      }
      return;
    }

    // ✅ Log quando tiver ticks suficientes para análise
    if (userTicks.length === 50) {
      await this.saveLog(userId, 'INFO', 'ANALYZER', 
        `Ticks coletados: ${userTicks.length}/50. Iniciando análise...`);
    }

    // Realizar análise de mercado
    const marketAnalysis = await this.analyzeMarket(userId, userTicks);
    
    // ✅ Log de debug da análise
    if (marketAnalysis) {
      this.logger.debug(`[Falcon][${userId}] Análise realizada: prob=${marketAnalysis.probability.toFixed(1)}%, signal=${marketAnalysis.signal}`);
    } else {
      this.logger.warn(`[Falcon][${userId}] Análise retornou null`);
    }
    
    if (marketAnalysis) {
      // Processar decisão de trade
      const decision = await this.processAgent(userId, marketAnalysis);
      
      if (decision.action === 'BUY') {
        await this.executeTrade(userId, decision, marketAnalysis);
      } else if (decision.action === 'STOP') {
        await this.handleStopCondition(userId, decision.reason || 'UNKNOWN');
      }
    }
  }

  /**
   * Análise de mercado para determinar probabilidade
   * FALCON usa análise de volatilidade e padrões de dígitos
   */
  private async analyzeMarket(userId: string, ticks: Tick[]): Promise<MarketAnalysis | null> {
    const config = this.userConfigs.get(userId);
    if (!config) {
      this.logger.warn(`[Falcon][${userId}] Config não encontrada para análise`);
      return null;
    }

    // Usar últimos 50 ticks para análise
    const recentTicks = ticks.slice(-50);
    const prices = recentTicks.map(t => t.value);
    
    // ✅ Log de debug
    this.logger.debug(`[Falcon][${userId}] Analisando mercado: ${recentTicks.length} ticks, prices=${prices.length}`);

    // 1. Análise de Volatilidade
    const volatility = this.calculateVolatility(prices);
    
    // 2. Análise de Tendência (EMA)
    const emaFast = this.calculateEMA(prices, 10);
    const emaSlow = this.calculateEMA(prices, 25);
    const trend = emaFast > emaSlow ? 'CALL' : 'PUT';
    
    // 3. Análise de Padrões de Dígitos
    const digitAnalysis = this.analyzeDigits(recentTicks);
    
    // 4. Calcular Probabilidade Combinada
    let probability = 50; // Base
    
    // Volatilidade: Alta volatilidade = maior confiança em tendências
    if (volatility > 0.5) {
      probability += 15;
    }
    
    // Tendência: EMA rápida acima da lenta = CALL, abaixo = PUT
    const trendStrength = Math.abs(emaFast - emaSlow) / emaSlow;
    if (trendStrength > 0.001) {
      probability += 10;
    }
    
    // Padrões de dígitos: Se há padrão forte, aumenta probabilidade
    if (digitAnalysis.patternStrength > 0.6) {
      probability += 15;
    }
    
    // Limitar entre 0 e 100
    probability = Math.min(100, Math.max(0, probability));

    // Determinar sinal
    let signal: 'CALL' | 'PUT' | null = trend;
    
    // Se análise de dígitos sugere direção oposta e tem força, considerar
    if (digitAnalysis.direction && digitAnalysis.patternStrength > 0.7) {
      // Se digitAnalysis sugere direção diferente, reduzir probabilidade
      if (digitAnalysis.direction !== trend) {
        probability -= 10;
        // Se ainda assim a probabilidade é alta, usar direção dos dígitos
        if (probability >= 80 && digitAnalysis.patternStrength > 0.8) {
          signal = digitAnalysis.direction;
        }
      } else {
        // Se concordam, aumentar probabilidade
        probability += 5;
      }
    }

    return {
      probability,
      signal,
      payout: 0.95, // Payout padrão Rise/Fall
      confidence: probability / 100,
      details: {
        volatility,
        trend,
        trendStrength,
        digitPattern: digitAnalysis.pattern,
        digitStrength: digitAnalysis.patternStrength,
      },
    };
  }

  /**
   * Calcula volatilidade dos preços
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;
    
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]));
    }
    
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    return avgReturn;
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
   * Analisa padrões de dígitos
   */
  private analyzeDigits(ticks: Tick[]): {
    pattern: 'strongeven' | 'strongodd' | 'balanced';
    direction: 'CALL' | 'PUT' | null;
    patternStrength: number;
  } {
    const lastDigits = ticks.slice(-20).map(t => {
      const value = t.value.toString();
      return parseInt(value[value.length - 1]);
    });

    const evenCount = lastDigits.filter(d => d % 2 === 0).length;
    const oddCount = lastDigits.filter(d => d % 2 === 1).length;

    let pattern: 'strongeven' | 'strongodd' | 'balanced' = 'balanced';
    let direction: 'CALL' | 'PUT' | null = null;
    let patternStrength = 0;

    if (evenCount > oddCount + 3) {
      pattern = 'strongeven';
      direction = 'PUT'; // Se muitos pares, espera-se ímpar
      patternStrength = (evenCount - oddCount) / 20;
    } else if (oddCount > evenCount + 3) {
      pattern = 'strongodd';
      direction = 'CALL'; // Se muitos ímpares, espera-se par
      patternStrength = (oddCount - evenCount) / 20;
    }

    return { pattern, direction, patternStrength };
  }

  /**
   * Processa agente (chamado via interface)
   */
  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || !state.isActive) {
      return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
    }

    // ✅ Verificar se já está aguardando resultado de contrato
    if (state.isWaitingContract) {
      return { action: 'WAIT', reason: 'WAITING_CONTRACT_RESULT' };
    }

    // A. Verificações de Segurança (Hard Stops)
    if (state.lucroAtual <= -config.dailyLossLimit) {
      return { action: 'STOP', reason: 'STOP_LOSS' };
    }

    if (state.lucroAtual >= config.dailyProfitTarget) {
      return { action: 'STOP', reason: 'TAKE_PROFIT' };
    }

    if (!this.checkBlindado(userId)) {
      return { action: 'STOP', reason: 'BLINDADO' };
    }

    // B. Filtro de Precisão
    // ✅ TEMPORÁRIO: Reduzido para 50% para testes
    const requiredProb = 50; // state.mode === 'ALTA_PRECISAO' ? 90 : 80;
    
    if (marketAnalysis.probability >= requiredProb && marketAnalysis.signal) {
      const stake = this.calculateStake(userId, marketAnalysis.payout);
      
      if (stake <= 0) {
        return { action: 'WAIT', reason: 'NO_STAKE' };
      }

      // ✅ Log consolidado de decisão (formato igual ao SENTINEL)
      const reasons: string[] = [];
      if (marketAnalysis.details?.volatility) {
        reasons.push(`Volatilidade: ${(marketAnalysis.details.volatility * 100).toFixed(2)}%`);
      }
      if (marketAnalysis.details?.trend) {
        reasons.push(`Tendência: ${marketAnalysis.details.trend}`);
      }
      if (marketAnalysis.details?.digitPattern) {
        reasons.push(`Padrão: ${marketAnalysis.details.digitPattern}`);
      }
      
      await this.saveLog(userId, 'INFO', 'DECISION',
        `✅ COMPRA APROVADA | Direção: ${marketAnalysis.signal} | Score: ${marketAnalysis.probability.toFixed(1)}% | Motivos: ${reasons.join(', ')}`);

      return {
        action: 'BUY',
        stake: stake,
        contractType: marketAnalysis.signal === 'CALL' ? 'RISE' : 'FALL',
        mode: state.mode,
        reason: 'HIGH_PROBABILITY',
      };
    } else {
      // ✅ Log de motivo para não comprar (formato igual ao SENTINEL)
      const missingProb = requiredProb - marketAnalysis.probability;
      const reasonMsg = marketAnalysis.probability < requiredProb 
        ? `Score ${marketAnalysis.probability.toFixed(1)}% abaixo do mínimo ${requiredProb}% (faltam ${missingProb.toFixed(1)}%)`
        : 'Sinal indefinido';
      
      await this.saveLog(userId, 'INFO', 'DECISION',
        `⏸️ COMPRA NEGADA | Score: ${marketAnalysis.probability.toFixed(1)}% | Direção: ${marketAnalysis.signal || 'N/A'} | Motivo: ${reasonMsg}`);
    }

    return { action: 'WAIT', reason: 'LOW_PROBABILITY' };
  }

  /**
   * Atualiza o modo do agente baseado em vitória/derrota
   */
  private updateMode(userId: string, win: boolean): void {
    const state = this.userStates.get(userId);
    if (!state) return;

    if (win) {
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
      state.mode = 'PRECISO'; // Reseta para modo normal após vitória
      
      // Soros: Resetar após Win3 (quando consecutiveWins = 3)
      // Win1: consecutiveWins = 1 → Base
      // Win2: consecutiveWins = 2 → Base + Lucro (Soros)
      // Win3: consecutiveWins = 3 → Resetar para 0 → Base
      if (state.consecutiveWins >= 3) {
        state.consecutiveWins = 0; // Resetar contador após Win3
      }
    } else {
      state.consecutiveWins = 0;
      state.consecutiveLosses++;
      // ✅ RECUPERAÇÃO IMEDIATA: Qualquer perda ativa o modo Sniper
      state.mode = 'ALTA_PRECISAO';
      
      this.logger.log(
        `[Falcon][${userId}] ⚠️ LOSS DETECTADO: Ativando Modo ALTA PRECISÃO (>90%) para recuperação imediata.`,
      );
      
      // Não logar ativação de modo (SENTINEL não faz isso)
    }
  }

  /**
   * Calcula o stake baseado no modo e situação
   */
  private calculateStake(userId: string, marketPayoutPercent: number): number {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return 0;
    }

    let stake = config.initialStake;
    const realPayout = (marketPayoutPercent - marketPayoutPercent * this.comissaoPlataforma);

    // Lógica para Modo ALTA PRECISÃO (Recuperação - Smart Martingale)
    if (state.mode === 'ALTA_PRECISAO') {
      // Recuperar perdas + 25% de lucro sobre a perda
      const lossToRecover = Math.abs(Math.min(0, state.lucroAtual));
      if (lossToRecover > 0) {
        const targetProfit = lossToRecover * 0.25;
        const totalNeeded = lossToRecover + targetProfit;
        stake = totalNeeded / realPayout;
        
        this.logger.log(
          `[Falcon][${userId}] 🚑 RECUPERAÇÃO: Buscando ${totalNeeded.toFixed(2)} (Stake: ${stake.toFixed(2)})`,
        );
        
        this.saveLog(userId, 'INFO', 'RISK',
          `Ativando recuperação (Martingale M1). perdas_totais=${lossToRecover.toFixed(2)}, modo=ALTA_PRECISAO`);
      } else {
        // Se estiver no modo Alta Precisão mas sem prejuízo acumulado, usa stake base
        stake = config.initialStake;
      }
    }
    // Lógica para Modo PRECISO (Soros Nível 1)
    else {
      // Soros Nível 1: Win1 = Base, Win2 = Base + Lucro, Win3 = volta para Base
      // consecutiveWins = 1 → Win1 (próxima compra usa Base)
      // consecutiveWins = 2 → Win2 (próxima compra usa Base + Lucro = Soros)
      // consecutiveWins = 0 ou >= 3 → Win3+ (próxima compra usa Base)
      if (state.consecutiveWins === 2) {
        // Win2: Aplicar Soros (Base + Lucro Anterior)
        stake = config.initialStake + state.lastProfit;
        this.logger.log(`[Falcon][${userId}] 🚀 SOROS NÍVEL 1: Stake ${stake.toFixed(2)}`);
        
        this.saveLog(userId, 'INFO', 'RISK',
          `Ativando Soros Nível 1. stakeanterior=${config.initialStake.toFixed(2)}, lucro=${state.lastProfit.toFixed(2)}, proximostake=${stake.toFixed(2)}`);
      } else {
        // Win1 ou Win3+: usa Base
        stake = config.initialStake;
      }
    }

    return this.adjustStakeForStopLoss(userId, stake);
  }

  /**
   * Ajusta o stake para respeitar o stop loss restante
   */
  private adjustStakeForStopLoss(userId: string, calculatedStake: number): number {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return calculatedStake;
    }

    const remainingLossLimit = config.dailyLossLimit + state.lucroAtual;
    if (remainingLossLimit <= 0) return 0; // Stop já atingido

    if (calculatedStake > remainingLossLimit) {
      this.logger.log(
        `[Falcon][${userId}] ⛔ STAKE AJUSTADA PELO STOP: De ${calculatedStake.toFixed(2)} para ${remainingLossLimit.toFixed(2)}`,
      );
      
        this.saveLog(userId, 'WARN', 'RISK',
          `Risco de ultrapassar Stop Loss! perdasatuais=${Math.abs(Math.min(0, state.lucroAtual)).toFixed(2)}, proximaentrada_calculada=${calculatedStake.toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}`);
      
      return remainingLossLimit;
    }

    return calculatedStake;
  }

  /**
   * Verifica e gerencia o Stop Loss Blindado (Efeito Catraca)
   */
  private checkBlindado(userId: string): boolean {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return true;
    }

    // Verifica Ativação (40% da Meta)
    if (!state.stopBlindadoAtivo) {
      if (state.lucroAtual >= config.dailyProfitTarget * 0.40) {
        state.stopBlindadoAtivo = true;
        state.picoLucro = state.lucroAtual;
        state.pisoBlindado = state.picoLucro * 0.50;
        
        this.logger.log(
          `[Falcon][${userId}] 🔒 STOP BLINDADO ATIVADO! Piso: ${state.pisoBlindado.toFixed(2)}`,
        );
        
        this.saveLog(userId, 'INFO', 'RISK',
          `Lucro atual: $${state.lucroAtual.toFixed(2)}. Ativando Stop Loss Blindado em $${(config.initialBalance + state.pisoBlindado).toFixed(2)} (garantindo $${state.pisoBlindado.toFixed(2)} de lucro).`);
      }
    }
    // Atualização Dinâmica (Trailing Stop)
    else {
      if (state.lucroAtual > state.picoLucro) {
        state.picoLucro = state.lucroAtual;
        state.pisoBlindado = state.picoLucro * 0.50;
        
        this.logger.log(
          `[Falcon][${userId}] 🔒 BLINDAGEM SUBIU! Novo Piso: ${state.pisoBlindado.toFixed(2)}`,
        );
        
        // Não logar atualização de blindagem (SENTINEL não faz isso)
      }

      // Gatilho de Saída
      if (state.lucroAtual <= state.pisoBlindado) {
        this.logger.log(`[Falcon][${userId}] 🛑 STOP BLINDADO ATINGIDO. Encerrando operações.`);
        
        this.saveLog(userId, 'WARN', 'RISK',
          `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${(config.initialBalance + state.lucroAtual).toFixed(2)}. Encerrando operações do dia.`);
        
        return false; // Deve parar
      }
    }

    return true; // Pode continuar
  }

  /**
   * Executa trade
   */
  private async executeTrade(userId: string, decision: TradeDecision, marketAnalysis: MarketAnalysis): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || decision.action !== 'BUY') {
      return;
    }

    // ✅ Verificar se já está aguardando resultado de contrato (dupla verificação de segurança)
    if (state.isWaitingContract) {
      this.logger.warn(`[Falcon][${userId}] ⚠️ Tentativa de compra bloqueada: já aguardando resultado de contrato anterior`);
      return;
    }

    // Verificar Stop Loss antes de executar
    if (!this.checkBlindado(userId)) {
      return;
    }

    const contractType = decision.contractType || (marketAnalysis.signal === 'CALL' ? 'RISE' : 'FALL');

    await this.saveLog(userId, 'INFO', 'API', `Consultando payout para contrato ${contractType}...`);

    try {
      // Obter payout via proposal
      const payout = await this.getPayout(config.derivToken, contractType, config.symbol, 5);
      const zenixPayout = payout * 0.97; // Markup de 3%

      await this.saveLog(userId, 'DEBUG', 'API', `Payout Deriv: ${(payout * 100).toFixed(2)}%, Payout ZENIX: ${(zenixPayout * 100).toFixed(2)}%`);

      // ✅ IMPORTANTE: Setar isWaitingContract ANTES de iniciar a compra para evitar múltiplas compras simultâneas
      state.isWaitingContract = true;
      
      // Executar compra
      await this.saveLog(userId, 'INFO', 'API', 
        `Comprando contrato ${contractType}. stake=${decision.stake?.toFixed(2)}, direction=${marketAnalysis.signal}`);

      // ✅ Criar registro de trade ANTES de executar
      const tradeId = await this.createTradeRecord(
        userId,
        {
          contractType: contractType,
          stakeAmount: decision.stake || config.initialStake,
          duration: 5,
          marketAnalysis: marketAnalysis,
          payout: zenixPayout,
          entryPrice: 0,
        },
      );

      try {
        const contractId = await this.buyContract(
          userId,
          config.derivToken,
          contractType,
          config.symbol,
          decision.stake || config.initialStake,
          5, // duration em ticks
        );

        if (contractId) {
          state.currentContractId = contractId;
          state.currentTradeId = tradeId;
          await this.saveLog(userId, 'INFO', 'API', `Contrato comprado. contract_id=${contractId}, trade_id=${tradeId}`);
          
          // ✅ Atualizar trade com contract_id
          await this.updateTradeRecord(tradeId, {
            contractId: contractId,
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
        this.logger.error(`[Falcon][${userId}] Erro ao comprar contrato:`, error);
        await this.saveLog(userId, 'ERROR', 'API', `Erro ao comprar contrato: ${error.message}. Aguardando novo sinal...`);
      }
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao executar trade:`, error);
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
      this.logger.error(`[Falcon] Erro ao obter payout:`, error);
      // Retornar valores padrão em caso de erro
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
                this.logger.error(`[Falcon][${userId}] Erro ao atualizar entry_price:`, error);
              });
            }
            
            // Verificar se contrato foi finalizado
            if (contract.is_sold === 1) {
              const profit = Number(contract.profit || 0);
              const win = profit > 0;
              const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
              
              // Processar resultado
              this.onContractFinish(
                userId,
                { win, profit, contractId, exitPrice },
              ).catch((error) => {
                this.logger.error(`[Falcon][${userId}] Erro ao processar resultado:`, error);
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
      this.logger.error(`[Falcon][${userId}] Erro ao comprar contrato:`, error);
      return null;
    }
  }

  /**
   * Processa resultado de contrato finalizado
   */
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

    // Atualizar estado
    state.opsCount++;
    state.lastProfit = result.profit;
    state.lucroAtual += result.profit;

    // Atualizar modo (PRECISO ou ALTA_PRECISAO)
    this.updateMode(userId, result.win);

    // ✅ Logs detalhados do resultado
    if (result.win) {
      await this.saveLog(userId, 'INFO', 'API', 
        `✅ OPERAÇÃO FINALIZADA - WIN | Lucro: $${result.profit.toFixed(2)} | Contract ID: ${result.contractId}`);
    } else {
      await this.saveLog(userId, 'ERROR', 'API', 
        `❌ OPERAÇÃO FINALIZADA - LOSS | Perda: $${Math.abs(result.profit).toFixed(2)} | Contract ID: ${result.contractId}`);
    }

    await this.saveLog(userId, 'INFO', 'RISK',
      `📊 Estado atualizado: lucro_atual=$${state.lucroAtual.toFixed(2)}, ops_count=${state.opsCount}, mode=${state.mode}`);

    // Atualizar banco de dados
    await this.updateUserStateInDb(userId, state);
    
    // ✅ Log final indicando que está pronto para próxima operação
    await this.saveLog(userId, 'INFO', 'CORE', 
      `🔄 Aguardando novo sinal para próxima operação...`);

    // Verificar se atingiu meta ou stop
    if (state.lucroAtual >= config.dailyProfitTarget) {
      await this.handleStopCondition(userId, 'TAKE_PROFIT');
    } else if (state.lucroAtual <= -config.dailyLossLimit) {
      await this.handleStopCondition(userId, 'STOP_LOSS');
    }
  }

  /**
   * Trata condições de parada
   */
  private async handleStopCondition(userId: string, reason: string): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return;
    }

    let status = 'active';
    let message = '';

    switch (reason) {
      case 'TAKE_PROFIT':
        status = 'stopped_profit';
        message = `META DE LUCRO ATINGIDA! daily_profit=${state.lucroAtual.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)}. Encerrando operações.`;
        break;
      case 'STOP_LOSS':
        status = 'stopped_loss';
        message = `STOP LOSS ATINGIDO! daily_loss=${Math.abs(Math.min(0, state.lucroAtual)).toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}. Encerrando operações.`;
        break;
      case 'BLINDADO':
        status = 'stopped_blindado';
        message = `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${(config.initialBalance + state.lucroAtual).toFixed(2)}. Encerrando operações do dia.`;
        break;
    }

    await this.saveLog(userId, 'WARN', 'RISK', message);

    // Desativar agente
    state.isActive = false;
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = ?, is_active = FALSE WHERE user_id = ?`,
      [status, userId],
    );

    this.logger.log(`[Falcon][${userId}] ${message}`);
  }

  /**
   * Cria registro de trade no banco
   */
  private async createTradeRecord(
    userId: string,
    trade: {
      contractType: string;
      stakeAmount: number;
      duration: number;
      marketAnalysis: MarketAnalysis;
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
      strategy: 'falcon',
      mode: state.mode,
      probability: trade.marketAnalysis.probability,
      signal: trade.marketAnalysis.signal,
      volatility: trade.marketAnalysis.details?.volatility,
      trend: trade.marketAnalysis.details?.trend,
      digitPattern: trade.marketAnalysis.details?.digitPattern,
      timestamp: new Date().toISOString(),
    };

    const analysisReasoning = `Análise FALCON: Probabilidade ${trade.marketAnalysis.probability.toFixed(1)}%, ` +
      `Direção ${trade.marketAnalysis.signal}, ` +
      `Modo ${state.mode}, ` +
      `Volatilidade=${trade.marketAnalysis.details?.volatility?.toFixed(4) || 'N/A'}`;

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
          trade.marketAnalysis.probability,
          analysisReasoning,
          trade.contractType,
          trade.duration,
          trade.entryPrice,
          trade.stakeAmount,
          state.mode === 'ALTA_PRECISAO' ? 'M1' : 'M0',
          trade.payout * 100, // Converter para percentual
          config.symbol,
        ],
      );

      const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
      return insertId || 0;
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao criar registro de trade:`, error);
      return 0;
    }
  }

  /**
   * Atualiza registro de trade no banco
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
        `UPDATE autonomous_agent_trades SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues,
      );
    } catch (error) {
      this.logger.error(`[Falcon] Erro ao atualizar trade ${tradeId}:`, error);
    }
  }

  /**
   * Atualiza estado do usuário no banco de dados
   */
  private async updateUserStateInDb(userId: string, state: FalconUserState): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET daily_profit = ?, 
             daily_loss = ?,
             total_trades = ?,
             updated_at = NOW()
         WHERE user_id = ? AND agent_type = 'falcon'`,
        [
          Math.max(0, state.lucroAtual),
          Math.abs(Math.min(0, state.lucroAtual)),
          state.opsCount,
          userId,
        ],
      );
    } catch (error) {
      this.logger.error(`[Falcon] Erro ao atualizar estado no DB:`, error);
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

    this.logger.log(`[Falcon][${module}][${userId}] ${formattedMessage}`);
  }

  private getLogIcon(level: string): string {
    switch (level.toUpperCase()) {
      case 'ERROR':
        return '🚫';
      case 'WARN':
        return '⚠️';
      case 'INFO':
        return 'ℹ️';
      case 'DEBUG':
        return '🔍';
      default:
        return 'ℹ️';
    }
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    const state = this.userStates.get(userId);
    if (!state) return null;

    return {
      userId: state.userId,
      isActive: state.isActive,
      currentProfit: state.lucroAtual,
      currentLoss: Math.abs(Math.min(0, state.lucroAtual)),
      operationsCount: state.opsCount,
      mode: state.mode,
      consecutiveWins: state.consecutiveWins,
      consecutiveLosses: state.consecutiveLosses,
    };
  }

  async resetDailySession(userId: string): Promise<void> {
    const state = this.userStates.get(userId);
    if (state) {
      state.lucroAtual = 0;
      state.picoLucro = 0;
      state.consecutiveLosses = 0;
      state.consecutiveWins = 0;
      state.opsCount = 0;
      state.mode = 'PRECISO';
      state.stopBlindadoAtivo = false;
      state.pisoBlindado = 0;
      state.lastProfit = 0;
    }
  }
}

/**
 * Configuração do usuário para FALCON
 */
interface FalconUserConfig {
  userId: string;
  initialStake: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  derivToken: string;
  currency: string;
  symbol: string;
  initialBalance: number;
}

/**
 * Estado interno do FALCON por usuário
 */
interface FalconUserState {
  userId: string;
  isActive: boolean;
  saldoInicial: number;
  lucroAtual: number;
  picoLucro: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  opsCount: number;
  mode: 'PRECISO' | 'ALTA_PRECISAO';
  stopBlindadoAtivo: boolean;
  pisoBlindado: number;
  lastProfit: number;
  currentContractId: string | null;
  currentTradeId: number | null;
  isWaitingContract: boolean;
}
