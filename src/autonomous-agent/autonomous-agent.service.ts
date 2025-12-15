import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import WebSocket from 'ws';
import { AutonomousAgentLogsStreamService } from './autonomous-agent-logs-stream.service';

// ============================================
// INTERFACES E TIPOS
// ============================================

export type ContractType = 'RISE' | 'FALL' | 'HIGHER' | 'LOWER' | 'ONETOUCH' | 'NOTOUCH';
export type MartingaleLevel = 'M0' | 'M1' | 'M2';
export type TradingMode = 'veloz' | 'normal' | 'lento';
export type ManagementMode = 'conservative' | 'balanced' | 'aggressive';
export type StopLossType = 'normal' | 'blindado';

export interface PriceTick {
  value: number;
  epoch: number;
  timestamp: string;
}

interface AutonomousAgentState {
  userId: string;
  derivToken: string;
  currency: string;
  symbol: string;
  initialStake: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  initialBalance: number; // Para Stop Loss Blindado
  isOperationActive: boolean;
  martingaleLevel: MartingaleLevel;
  martingaleCount: number; // Contador para limite M5 no Conservador
  lastLossAmount: number;
  sorosLevel: number; // 0 = inativo, 1, 2
  sorosStake: number;
  sorosProfit: number; // Profit da última operação ganha no Soros (para cálculo de net_loss)
  operationsSincePause: number;
  lastTradeAt: Date | null;
  nextTradeAt: Date | null;
  dailyProfit: number;
  dailyLoss: number;
  profitPeak: number; // Pico de lucro (para Stop Loss Blindado)
  sessionDate: Date;
  tradingMode: TradingMode;
  managementMode: ManagementMode;
  stopLossType: StopLossType;
}

interface TechnicalAnalysis {
  ema10: number;
  ema25: number;
  ema50: number;
  rsi: number;
  momentum: number;
  confidenceScore: number;
  direction: ContractType | null;
  reasoning: string;
}

interface TradeResult {
  profitLoss: number;
  status: 'WON' | 'LOST';
  exitPrice: number;
  contractId: string;
}

// ============================================
// CONFIGURAÇÕES
// ============================================

const SENTINEL_CONFIG = {
  symbol: 'R_75', // Índice de Volatilidade 75
  minIntervalSeconds: 15, // Intervalo mínimo entre operações
  maxIntervalSeconds: 90, // Intervalo máximo entre operações
  pauseAfterOperations: 75, // Pausa após N operações
  pauseMinMinutes: 5, // Pausa mínima em minutos
  pauseMaxMinutes: 15, // Pausa máxima em minutos
  contractDurationMin: 5, // Duração mínima em ticks
  contractDurationMax: 10, // Duração máxima em ticks
  // Trading Mode configurations
  tradingModes: {
    veloz: { ticksRequired: 10, minConfidenceScore: 65 },
    normal: { ticksRequired: 20, minConfidenceScore: 50 },
    lento: { ticksRequired: 50, minConfidenceScore: 80 },
  },
  // Management Mode multipliers
  managementMultipliers: {
    conservative: 1.0, // Recupera 100% (break-even)
    balanced: 1.25, // Recupera 100% + 25%
    aggressive: 1.50, // Recupera 100% + 50%
  },
  // Martingale limits
  martingaleLimits: {
    conservative: 5, // Máximo M5
    balanced: Infinity, // Ilimitado
    aggressive: Infinity, // Ilimitado
  },
};

// ============================================
// SERVICE PRINCIPAL
// ============================================

@Injectable()
export class AutonomousAgentService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousAgentService.name);
  private readonly agentStates = new Map<string, AutonomousAgentState>();
  private readonly priceHistory = new Map<string, PriceTick[]>();
  private readonly maxHistorySize = 100;
  private wsConnections = new Map<string, WebSocket>();
  private readonly appId = process.env.DERIV_APP_ID || '1089';

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @Inject(AutonomousAgentLogsStreamService) private readonly logsStreamService?: AutonomousAgentLogsStreamService,
  ) {}

  async onModuleInit() {
    this.logger.log('🚀 Agente Autônomo IA SENTINEL inicializado');
    await this.syncActiveAgentsFromDb();
  }

  // ============================================
  // SINCRONIZAÇÃO COM BANCO
  // ============================================

  async syncActiveAgentsFromDb(): Promise<void> {
    try {
      const activeAgents = await this.dataSource.query(
        `SELECT 
          user_id,
          initial_stake,
          daily_profit_target,
          daily_loss_limit,
          initial_balance,
          deriv_token,
          currency,
          symbol,
          strategy,
          risk_level,
          trading_mode,
          stop_loss_type,
          martingale_level,
          martingale_count,
          last_loss_amount,
          soros_level,
          soros_stake,
          soros_profit,
          operations_since_pause,
          last_trade_at,
          next_trade_at,
          daily_profit,
          daily_loss,
          profit_peak,
          session_date
         FROM autonomous_agent_config
         WHERE is_active = TRUE`,
      );

      this.logger.log(`[SyncAgents] Sincronizando ${activeAgents.length} agentes ativos`);

      for (const agent of activeAgents) {
      this.upsertAgentState({
        userId: agent.user_id.toString(),
        initialStake: parseFloat(agent.initial_stake),
        dailyProfitTarget: parseFloat(agent.daily_profit_target),
        dailyLossLimit: parseFloat(agent.daily_loss_limit),
        initialBalance: parseFloat(agent.initial_balance) || 0,
        derivToken: agent.deriv_token,
        currency: agent.currency,
        symbol: agent.symbol || SENTINEL_CONFIG.symbol,
        tradingMode: (agent.trading_mode || 'normal') as TradingMode,
        managementMode: (agent.risk_level || 'balanced') as ManagementMode,
        stopLossType: (agent.stop_loss_type || 'normal') as StopLossType,
        martingaleLevel: (agent.martingale_level || 'M0') as MartingaleLevel,
        martingaleCount: agent.martingale_count || 0,
        lastLossAmount: parseFloat(agent.last_loss_amount) || 0,
        sorosLevel: agent.soros_level || 0,
        sorosStake: parseFloat(agent.soros_stake) || 0,
        sorosProfit: parseFloat(agent.soros_profit) || 0,
        operationsSincePause: agent.operations_since_pause || 0,
        lastTradeAt: agent.last_trade_at ? new Date(agent.last_trade_at) : null,
        nextTradeAt: agent.next_trade_at ? new Date(agent.next_trade_at) : null,
        dailyProfit: parseFloat(agent.daily_profit) || 0,
        dailyLoss: parseFloat(agent.daily_loss) || 0,
        profitPeak: parseFloat(agent.profit_peak) || 0,
        sessionDate: agent.session_date ? new Date(agent.session_date) : new Date(),
      });

      // Estabelecer conexão WebSocket para agentes ativos
      await this.ensureWebSocketConnection(agent.user_id.toString());
      }
    } catch (error) {
      this.logger.error('[SyncAgents] Erro ao sincronizar agentes:', error);
    }
  }

  private upsertAgentState(config: {
    userId: string;
    initialStake: number;
    dailyProfitTarget: number;
    dailyLossLimit: number;
    initialBalance: number;
    derivToken: string;
    currency: string;
    symbol: string;
    tradingMode: TradingMode;
    managementMode: ManagementMode;
    stopLossType: StopLossType;
    martingaleLevel: MartingaleLevel;
    martingaleCount: number;
    lastLossAmount: number;
    sorosLevel: number;
    sorosStake: number;
    sorosProfit: number;
    operationsSincePause: number;
    lastTradeAt: Date | null;
    nextTradeAt: Date | null;
    dailyProfit: number;
    dailyLoss: number;
    profitPeak: number;
    sessionDate: Date;
  }): void {
    const existing = this.agentStates.get(config.userId);

    if (existing) {
      // Atualizar existente
      Object.assign(existing, config);
    } else {
      // Criar novo
      this.agentStates.set(config.userId, {
        userId: config.userId,
        derivToken: config.derivToken,
        currency: config.currency,
        symbol: config.symbol,
        initialStake: config.initialStake,
        dailyProfitTarget: config.dailyProfitTarget,
        dailyLossLimit: config.dailyLossLimit,
        initialBalance: config.initialBalance,
        isOperationActive: false,
        tradingMode: config.tradingMode,
        managementMode: config.managementMode,
        stopLossType: config.stopLossType,
        martingaleLevel: config.martingaleLevel,
        martingaleCount: config.martingaleCount,
        lastLossAmount: config.lastLossAmount,
        sorosLevel: config.sorosLevel,
        sorosStake: config.sorosStake,
        sorosProfit: config.sorosProfit,
        operationsSincePause: config.operationsSincePause,
        lastTradeAt: config.lastTradeAt,
        nextTradeAt: config.nextTradeAt,
        dailyProfit: config.dailyProfit,
        dailyLoss: config.dailyLoss,
        profitPeak: config.profitPeak,
        sessionDate: config.sessionDate,
      });
    }
  }

  // ============================================
  // ATIVAÇÃO/DESATIVAÇÃO
  // ============================================

  async activateAgent(
    userId: string,
    config: {
      initialStake: number;
      dailyProfitTarget: number;
      dailyLossLimit: number;
      derivToken: string;
      currency?: string;
      symbol?: string;
      strategy?: string;
      riskLevel?: string;
      tradingMode?: string;
      stopLossType?: string;
      initialBalance?: number;
    },
  ): Promise<void> {
    try {
      // Verificar se já existe configuração
      const existing = await this.dataSource.query(
        `SELECT id FROM autonomous_agent_config WHERE user_id = ?`,
        [userId],
      );

      // Usar horário atual (NOW()) para session_date quando ativar o agente
      // Isso permite calcular o tempo ativo corretamente
      const now = new Date();

      const symbol = config.symbol || SENTINEL_CONFIG.symbol;
      const strategy = config.strategy || 'arion';
      const riskLevel = config.riskLevel || 'balanced';
      const tradingMode = config.tradingMode || 'normal';
      const stopLossType = config.stopLossType || 'normal';
      const initialBalance = config.initialBalance || 0;

      if (existing && existing.length > 0) {
        // Atualizar existente
        // Verificar se a coluna soros_profit existe antes de usá-la
        let updateQuery = `UPDATE autonomous_agent_config SET
            is_active = TRUE,
            initial_stake = ?,
            daily_profit_target = ?,
            daily_loss_limit = ?,
            initial_balance = ?,
            deriv_token = ?,
            currency = ?,
            symbol = ?,
            strategy = ?,
            risk_level = ?,
            trading_mode = ?,
            stop_loss_type = ?,
            session_date = NOW(),
            daily_profit = 0,
            daily_loss = 0,
            profit_peak = 0,
            operations_since_pause = 0,
            martingale_level = 'M0',
            martingale_count = 0,
            soros_level = 0,
            soros_stake = 0,
            session_status = 'active',
            next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
            updated_at = NOW()`;
        
        const updateParams = [
          config.initialStake,
          config.dailyProfitTarget,
          config.dailyLossLimit,
          initialBalance,
          config.derivToken,
          config.currency || 'USD',
          symbol,
          strategy,
          riskLevel,
          tradingMode,
          stopLossType,
          this.getRandomInterval(),
        ];

        // Tentar adicionar soros_profit se a coluna existir
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          updateQuery = updateQuery.replace(
            'soros_stake = 0,',
            'soros_stake = 0,\n            soros_profit = 0,'
          );
        } else {
          this.logger.warn(`[ActivateAgent] Coluna soros_profit não existe. Execute a migration: backend/db/add_soros_profit_to_autonomous_agent.sql`);
        }

        updateQuery += '\n           WHERE user_id = ?';
        updateParams.push(userId);

        await this.dataSource.query(updateQuery, updateParams);
      } else {
        // Criar novo
        await this.dataSource.query(
          `INSERT INTO autonomous_agent_config (
            user_id, is_active, initial_stake, daily_profit_target, daily_loss_limit, initial_balance,
            deriv_token, currency, symbol, strategy, risk_level, trading_mode, stop_loss_type,
            session_date, session_status, next_trade_at, created_at, updated_at
          ) VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'active', DATE_ADD(NOW(), INTERVAL ? SECOND), NOW(), NOW())`,
          [
            userId,
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            initialBalance,
            config.derivToken,
            config.currency || 'USD',
            symbol,
            strategy,
            riskLevel,
            tradingMode,
            stopLossType,
            this.getRandomInterval(),
          ],
        );
      }

      // Sincronizar estado em memória
      await this.syncActiveAgentsFromDb();

      // Estabelecer conexão WebSocket para receber ticks
      await this.ensureWebSocketConnection(userId);

      // Logs de validação de modos (formato da documentação)
      const tradingModeName = tradingMode === 'veloz' ? 'Veloz' : tradingMode === 'lento' ? 'Lento' : 'Normal';
      const managementModeName = riskLevel === 'conservative' ? 'Conservador' : riskLevel === 'aggressive' ? 'Agressivo' : 'Moderado';
      const stopLossName = stopLossType === 'blindado' ? 'Blindado' : 'Normal';
      
      await this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Modo de Negociação: ${tradingModeName}`,
      );
      
      await this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Modo de Gestão: ${managementModeName}`,
      );
      
      await this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Tipo de Stop Loss: ${stopLossName}`,
      );
      
      await this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Agente IA SENTINEL iniciando. versão=2.0, estratégia=${strategy}, mercado=${symbol}, entrada=${config.initialStake}, meta_lucro=${config.dailyProfitTarget}, limite_perda=${config.dailyLossLimit}`,
        {
          initialStake: config.initialStake,
          dailyProfitTarget: config.dailyProfitTarget,
          dailyLossLimit: config.dailyLossLimit,
          currency: config.currency || 'USD',
          symbol,
          strategy,
          riskLevel,
        },
      );

      this.logger.log(`[ActivateAgent] ✅ Agente ativado para usuário ${userId}`);
    } catch (error) {
      await this.saveLog(userId, 'ERROR', 'CORE', `Falha ao ativar agente. erro=${error.message}`);
      this.logger.error(`[ActivateAgent] ❌ Erro ao ativar agente:`, error);
      throw error;
    }
  }

  async deactivateAgent(userId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_config SET is_active = FALSE, updated_at = NOW() WHERE user_id = ?`,
        [userId],
      );

      this.agentStates.delete(userId);
      this.priceHistory.delete(userId);

      // Fechar conexão WebSocket se existir
      const ws = this.wsConnections.get(userId);
      if (ws) {
        ws.close();
        this.wsConnections.delete(userId);
        await this.saveLog(userId, 'INFO', 'API', 'WebSocket desconectado.');
      }

      // Log detalhado
      await this.saveLog(userId, 'INFO', 'CORE', 'Agente parado.');

      this.logger.log(`[DeactivateAgent] ✅ Agente desativado para usuário ${userId}`);
    } catch (error) {
      await this.saveLog(userId, 'ERROR', 'CORE', `Falha ao desativar agente. erro=${error.message}`);
      this.logger.error(`[DeactivateAgent] ❌ Erro ao desativar agente:`, error);
      throw error;
    }
  }

  // ============================================
  // PROCESSAMENTO EM BACKGROUND
  // ============================================

  async processActiveAgents(): Promise<void> {
    if (this.agentStates.size === 0) {
      return;
    }
    
    this.logger.debug(`[ProcessActiveAgents] Processando ${this.agentStates.size} agente(s) ativo(s)`);

    const now = new Date();

    for (const [userId, state] of this.agentStates.entries()) {
      try {
        // Verificar se pode processar
        if (!(await this.canProcessAgent(state))) {
          continue;
        }

        // Verificar intervalo
        if (state.nextTradeAt && state.nextTradeAt > now) {
          continue;
        }

        // Verificar se está saindo de uma pausa aleatória
        const config = await this.dataSource.query(
          `SELECT last_pause_at, next_trade_at, operations_since_pause
           FROM autonomous_agent_config WHERE user_id = ? AND is_active = TRUE`,
          [userId],
        );
        
        if (config && config.length > 0 && config[0].last_pause_at && state.nextTradeAt && state.nextTradeAt <= now) {
          // Pausa acabou, logar retomada
          await this.saveLog(
            userId,
            'INFO',
            'HUMANIZER',
            'Pausa aleatória finalizada. Retomando operações.',
            { pauseEndedAt: now.toISOString() },
          );
        }

        // Verificar pausa aleatória
        if (state.operationsSincePause >= SENTINEL_CONFIG.pauseAfterOperations) {
          await this.handleRandomPause(state);
          continue;
        }

        // Processar agente
        await this.processAgent(state);
      } catch (error) {
        this.logger.error(`[ProcessAgent][${userId}] Erro:`, error);
      }
    }
  }

  private async canProcessAgent(state: AutonomousAgentState): Promise<boolean> {
    if (state.isOperationActive) {
      return false;
    }

    // Verificar limites diários
    const config = await this.dataSource.query(
      `SELECT session_status, daily_profit, daily_loss, daily_profit_target, daily_loss_limit,
              stop_loss_type, initial_balance, profit_peak
       FROM autonomous_agent_config WHERE user_id = ? AND is_active = TRUE`,
      [state.userId],
    );

    if (!config || config.length === 0) {
      return false;
    }

    const cfg = config[0];

    // Verificar stop win
    if (parseFloat(cfg.daily_profit) >= parseFloat(cfg.daily_profit_target)) {
      await this.handleStopWin(state.userId);
      return false;
    }

    // Verificar stop loss (Normal ou Blindado)
    if (cfg.stop_loss_type === 'blindado') {
      // Stop Loss Blindado: Proteger 50% do lucro acumulado
      const profitPeak = parseFloat(cfg.profit_peak) || 0;
      const protectedProfit = profitPeak * 0.50; // 50% do pico
      const initialBalance = parseFloat(cfg.initial_balance) || 0;
      const blindBalance = initialBalance + protectedProfit;
      const currentBalance = initialBalance + parseFloat(cfg.daily_profit) - parseFloat(cfg.daily_loss);
      
      if (currentBalance <= blindBalance) {
        await this.saveLog(
          state.userId,
          'WARN',
          'RISK',
          `STOP LOSS BLINDADO ATINGIDO! Saldo atual (${currentBalance.toFixed(2)}) está abaixo do saldo blindado (${blindBalance.toFixed(2)}). Parando operações.`,
        );
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET session_status = 'stopped_loss' WHERE user_id = ?`,
          [state.userId],
        );
        return false;
      }
    } else {
      // Stop Loss Normal: Verificar limite de perda
      if (parseFloat(cfg.daily_loss) >= parseFloat(cfg.daily_loss_limit)) {
        await this.handleStopLoss(state.userId);
        return false;
      }
      
      // Verificar se próxima entrada (com Martingale) ultrapassaria o limite
      if (state.martingaleLevel !== 'M0') {
        // Se estiver em Martingale, verificar se o próximo stake ultrapassaria o limite
        // (Isso será verificado quando calcular o stake de Martingale)
        // Por enquanto, apenas verificar o limite atual
      }
    }

    // Verificar status da sessão
    if (cfg.session_status !== 'active') {
      return false;
    }

    return true;
  }

  // ============================================
  // ANÁLISE TÉCNICA
  // ============================================

  private async processAgent(state: AutonomousAgentState): Promise<void> {
    try {
      // Obter configuração do Trading Mode
      const tradingConfig = SENTINEL_CONFIG.tradingModes[state.tradingMode];
      const ticksRequired = tradingConfig.ticksRequired;
      const minConfidenceScore = tradingConfig.minConfidenceScore;
      
      // Obter histórico de preços
      const prices = await this.getPriceHistory(state.userId, state.symbol);
      
      if (prices.length < ticksRequired) {
        this.logger.debug(`[ProcessAgent][${state.userId}] Histórico insuficiente (${prices.length}/${ticksRequired}). Aguardando mais ticks...`);
        await this.saveLog(
          state.userId,
          'DEBUG',
          'ANALYZER',
          `Histórico de preços insuficiente. atual=${prices.length}, necessário=${ticksRequired}`,
          { currentTicks: prices.length, requiredTicks: ticksRequired, tradingMode: state.tradingMode },
        );
        // Atualizar próximo trade com intervalo menor para verificar novamente
        const interval = Math.min(30, this.getRandomInterval());
        await this.updateNextTradeAt(state.userId, interval);
        return;
      }

      // Usar apenas os últimos N ticks conforme o Trading Mode
      const recentPrices = prices.slice(-ticksRequired);

      // Realizar análise técnica
      const analysis = this.performTechnicalAnalysis(recentPrices, state.userId);

      // Log detalhado da análise
      this.logger.debug(
        `[ProcessAgent][${state.userId}] Análise: direction=${analysis.direction}, confidence=${analysis.confidenceScore.toFixed(1)}%, ema10=${analysis.ema10.toFixed(2)}, ema25=${analysis.ema25.toFixed(2)}, ema50=${analysis.ema50.toFixed(2)}, rsi=${analysis.rsi.toFixed(1)}, momentum=${analysis.momentum.toFixed(4)}`,
      );

      // Verificar score de confiança (usando mínimo do Trading Mode)
      if (analysis.confidenceScore < minConfidenceScore) {
        await this.saveLog(
          state.userId,
          'DEBUG',
          'DECISION',
          `Sinal invalidado. motivo="Pontuação de confiança muito baixa", confiança=${analysis.confidenceScore.toFixed(1)}%, mínimo_requerido=${minConfidenceScore}%`,
          { confidenceScore: analysis.confidenceScore, minRequired: minConfidenceScore, tradingMode: state.tradingMode },
        );
        // Atualizar próximo trade com intervalo aleatório
        const interval = this.getRandomInterval();
        await this.updateNextTradeAt(state.userId, interval);
        await this.saveLog(
          state.userId,
          'DEBUG',
          'HUMANIZER',
          `Novo intervalo aleatório definido. duração_segundos=${interval}`,
        );
        return;
      }

      // Verificar confirmação estatística (dígitos) - mais flexível
      if (!(await this.validateStatisticalConfirmation(prices, analysis.direction, state.userId))) {
        await this.saveLog(
          state.userId,
          'DEBUG',
          'DECISION',
          `Sinal invalidado. motivo="Confirmação estatística falhou"`,
        );
        const interval = this.getRandomInterval();
        await this.updateNextTradeAt(state.userId, interval);
        await this.saveLog(
          state.userId,
          'DEBUG',
          'HUMANIZER',
          `Novo intervalo aleatório definido. duração_segundos=${interval}`,
        );
        return;
      }

      // Log de sinal encontrado (formato da documentação)
      await this.saveLog(
        state.userId,
        'INFO',
        'ANALYZER',
        `Sinal encontrado. direção=${analysis.direction}, confiança=${analysis.confidenceScore.toFixed(1)}%`,
        {
          direction: analysis.direction,
          confidence: analysis.confidenceScore,
          ema10: analysis.ema10,
          ema25: analysis.ema25,
          ema50: analysis.ema50,
          rsi: analysis.rsi,
          momentum: analysis.momentum,
        },
      );

      this.logger.log(`[ProcessAgent][${state.userId}] ✅ Sinal válido encontrado! Executando trade...`);
      if (this.logsStreamService) {
        this.logsStreamService.addLogForUser(state.userId, 'log', 'AutonomousAgentService', `[ProcessAgent] ✅ Sinal válido encontrado! Executando trade...`);
      }

      // Executar operação
      await this.executeTrade(state, analysis);
    } catch (error) {
      this.logger.error(`[ProcessAgent][${state.userId}] Erro:`, error);
      await this.saveLog(
        state.userId,
        'ERROR',
        'CORE',
        `Erro ao processar agente. erro=${error.message}`,
        { error: error.message, stack: error.stack },
      );
    }
  }

  private performTechnicalAnalysis(prices: PriceTick[], userId: string): TechnicalAnalysis {
    const values = prices.map(p => p.value);
    const recent = values.slice(-50);

    // Calcular EMAs
    const ema10 = this.calculateEMA(recent, 10);
    const ema25 = this.calculateEMA(recent, 25);
    const ema50 = this.calculateEMA(recent, 50);

    // Calcular RSI
    const rsi = this.calculateRSI(recent, 14);

    // Calcular Momentum
    const momentum = this.calculateMomentum(recent);

    // Determinar direção
    let direction: ContractType | null = null;
    let confidenceScore = 0;
    let reasoning = '';

    // Calcular pontuação para cada direção (mesmo sem alinhamento perfeito)
    const riseScore = this.calculateDirectionScore(ema10, ema25, ema50, rsi, momentum, 'RISE');
    const fallScore = this.calculateDirectionScore(ema10, ema25, ema50, rsi, momentum, 'FALL');

    // Definir direção baseado na maior pontuação (se atender mínimo)
    const minScoreForDirection = 30; // Mínimo de 30% para considerar uma direção

    if (riseScore >= minScoreForDirection && riseScore > fallScore) {
      direction = 'RISE';
      confidenceScore = riseScore;
      reasoning = `Tendência de alta detectada (EMA10: ${ema10.toFixed(4)}, EMA25: ${ema25.toFixed(4)}, EMA50: ${ema50.toFixed(4)}), RSI: ${rsi.toFixed(2)}, Momentum: ${momentum.toFixed(4)}`;
    } else if (fallScore >= minScoreForDirection && fallScore > riseScore) {
      direction = 'FALL';
      confidenceScore = fallScore;
      reasoning = `Tendência de baixa detectada (EMA10: ${ema10.toFixed(4)}, EMA25: ${ema25.toFixed(4)}, EMA50: ${ema50.toFixed(4)}), RSI: ${rsi.toFixed(2)}, Momentum: ${momentum.toFixed(4)}`;
    }

    // Log de análise técnica (formato da documentação) - mostrar todas as EMAs
    this.saveLog(
      userId,
      'DEBUG',
      'ANALYZER',
      `EMA(10)=${ema10.toFixed(4)}, EMA(25)=${ema25.toFixed(4)}, EMA(50)=${ema50.toFixed(4)}, RSI(14)=${rsi.toFixed(1)}, Momentum=${momentum.toFixed(4)}`,
      { ema10, ema25, ema50, rsi, momentum },
    ).catch(() => {}); // Não bloquear se houver erro

    // Log adicional quando não há direção definida para debug
    if (!direction) {
      this.saveLog(
        userId,
        'DEBUG',
        'ANALYZER',
        `Nenhuma direção definida. Pontuações: RISE=${riseScore.toFixed(1)}%, FALL=${fallScore.toFixed(1)}% (mínimo=${minScoreForDirection}%)`,
        { 
          ema10, ema25, ema50, rsi, momentum,
          riseScore,
          fallScore,
          minScoreForDirection,
        },
      ).catch(() => {});
    } else {
      // Log quando direção é definida
      this.saveLog(
        userId,
        'DEBUG',
        'ANALYZER',
        `Direção ${direction} definida com confiança ${confidenceScore.toFixed(1)}%. Pontuações: RISE=${riseScore.toFixed(1)}%, FALL=${fallScore.toFixed(1)}%`,
        {
          direction,
          confidenceScore,
          riseScore,
          fallScore,
        },
      ).catch(() => {});
    }

    return {
      ema10,
      ema25,
      ema50,
      rsi,
      momentum,
      confidenceScore,
      direction,
      reasoning,
    };
  }

  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) {
      return values[values.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private calculateRSI(values: number[], period: number): number {
    if (values.length < period + 1) {
      return 50; // Neutro
    }

    const changes: number[] = [];
    for (let i = 1; i < values.length; i++) {
      changes.push(values[i] - values[i - 1]);
    }

    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private calculateMomentum(values: number[], period: number = 10): number {
    if (values.length < period) {
      return 0;
    }

    const current = values[values.length - 1];
    const past = values[values.length - period];
    return current - past;
  }

  // Método novo: calcula pontuação para uma direção sem exigir condições perfeitas
  private calculateDirectionScore(
    ema10: number,
    ema25: number,
    ema50: number,
    rsi: number,
    momentum: number,
    direction: ContractType,
  ): number {
    let score = 0;

    // 1. Pontuação das EMAs (40% do total)
    let emaScore = 0;
    if (direction === 'RISE') {
      // Para RISE: ema10 > ema25 > ema50 é ideal
      // Mas damos pontuação parcial mesmo se não estiver perfeito
      const ema10vs25 = ema10 > ema25 ? Math.min(20, ((ema10 - ema25) / ema25) * 1000) : 0;
      const ema25vs50 = ema25 > ema50 ? Math.min(20, ((ema25 - ema50) / ema50) * 1000) : 0;
      // Se ema10 > ema25, já temos tendência de alta (mesmo que ema25 = ema50)
      if (ema10 > ema25) {
        emaScore = ema10vs25 + (ema25vs50 > 0 ? ema25vs50 : ema10vs25 * 0.5); // Bônus se ema25 > ema50
      } else if (ema10 > ema50) {
        // ema10 está acima de ema50 mas não de ema25 - tendência fraca
        emaScore = Math.min(15, ((ema10 - ema50) / ema50) * 500);
      }
    } else {
      // Para FALL: ema10 < ema25 < ema50 é ideal
      const ema25vs10 = ema25 > ema10 ? Math.min(20, ((ema25 - ema10) / ema10) * 1000) : 0;
      const ema50vs25 = ema50 > ema25 ? Math.min(20, ((ema50 - ema25) / ema25) * 1000) : 0;
      // Se ema10 < ema25, já temos tendência de baixa
      if (ema10 < ema25) {
        emaScore = ema25vs10 + (ema50vs25 > 0 ? ema50vs25 : ema25vs10 * 0.5);
      } else if (ema10 < ema50) {
        // ema10 está abaixo de ema50 mas não de ema25 - tendência fraca
        emaScore = Math.min(15, ((ema50 - ema10) / ema10) * 500);
      }
    }
    score += Math.min(40, Math.max(0, emaScore));

    // 2. Pontuação do RSI (30% do total)
    let rsiScore = 0;
    if (direction === 'RISE') {
      // Para RISE: RSI < 70 é bom, ideal entre 30-50
      if (rsi < 30) {
        rsiScore = 0; // RSI muito baixo pode indicar sobrevenda extrema
      } else if (rsi <= 50) {
        rsiScore = 30; // Ideal para alta
      } else if (rsi < 70) {
        rsiScore = 30 * (1 - (rsi - 50) / 20); // Decai de 30 para 0 conforme RSI sobe
      } else {
        rsiScore = 0; // RSI >= 70 não é favorável para alta
      }
    } else {
      // Para FALL: RSI > 30 é bom, ideal entre 50-70
      if (rsi > 70) {
        rsiScore = 0; // RSI muito alto pode indicar sobrecompra extrema
      } else if (rsi >= 50) {
        rsiScore = 30; // Ideal para baixa
      } else if (rsi > 30) {
        rsiScore = 30 * ((rsi - 30) / 20); // Cresce de 0 para 30 conforme RSI sobe
      } else {
        rsiScore = 0; // RSI <= 30 não é favorável para baixa
      }
    }
    score += Math.min(30, Math.max(0, rsiScore));

    // 3. Pontuação do Momentum (30% do total)
    let momentumScore = 0;
    if (direction === 'RISE') {
      // Para RISE: momentum positivo é bom
      if (momentum > 0) {
        momentumScore = Math.min(30, momentum * 2); // Cada unidade de momentum = 2% de score
      } else {
        // Momentum negativo reduz a pontuação, mas não zera completamente
        momentumScore = Math.max(0, 30 + momentum * 1); // Penalidade menor
      }
    } else {
      // Para FALL: momentum negativo é bom
      if (momentum < 0) {
        momentumScore = Math.min(30, Math.abs(momentum) * 2);
      } else {
        // Momentum positivo reduz a pontuação
        momentumScore = Math.max(0, 30 - momentum * 1);
      }
    }
    score += Math.min(30, Math.max(0, momentumScore));

    return Math.min(100, Math.max(0, score));
  }

  // Método original mantido para compatibilidade (usado quando já temos direção confirmada)
  private calculateConfidenceScore(
    ema10: number,
    ema25: number,
    ema50: number,
    rsi: number,
    momentum: number,
    direction: ContractType,
  ): number {
    let score = 0;

    // Peso das EMAs (40%)
    const emaAlignment = direction === 'RISE' 
      ? (ema10 - ema25) / ema25 * 100 + (ema25 - ema50) / ema50 * 100
      : (ema25 - ema10) / ema10 * 100 + (ema50 - ema25) / ema25 * 100;
    score += Math.min(40, Math.max(0, emaAlignment * 2));

    // Peso do RSI (30%)
    const rsiScore = direction === 'RISE'
      ? Math.max(0, (70 - rsi) / 70 * 30)
      : Math.max(0, (rsi - 30) / 70 * 30);
    score += rsiScore;

    // Peso do Momentum (30%)
    const momentumScore = direction === 'RISE'
      ? Math.min(30, Math.max(0, momentum * 10))
      : Math.min(30, Math.max(0, -momentum * 10));
    score += momentumScore;

    return Math.min(100, Math.max(0, score));
  }

  private async validateStatisticalConfirmation(prices: PriceTick[], direction: ContractType | null, userId: string): Promise<boolean> {
    if (!direction) {
      return false;
    }

    // Extrair últimos 20 dígitos
    const last20 = prices.slice(-20);
    const digits = last20.map(p => {
      const str = Math.abs(p.value).toString().replace('.', '');
      return parseInt(str.charAt(str.length - 1), 10);
    });

    let imbalance = '';
    let sequenceOk = false;

    // Para RISE: verificar se >60% dos dígitos são altos (5-9)
    if (direction === 'RISE') {
      const highDigits = digits.filter(d => d >= 5).length;
      const highPercent = highDigits / 20;
      imbalance = `${(highPercent * 100).toFixed(0)}%_UP`;
      
      if (highPercent <= 0.6) {
        // Log de análise estatística (falhou)
        await this.saveLog(
          userId,
          'DEBUG',
          'ANALYZER',
          `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
          { imbalance: highPercent, direction: 'RISE', highDigits, totalDigits: 20 },
        ).catch(() => {});
        return false;
      }

      // Verificar sequência contrária
      let consecutiveLow = 0;
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] < 5) {
          consecutiveLow++;
        } else {
          break;
        }
      }
      sequenceOk = consecutiveLow < 4;
      
      if (consecutiveLow >= 4) {
        // Log de análise estatística (falhou por sequência)
        await this.saveLog(
          userId,
          'DEBUG',
          'ANALYZER',
          `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
          { imbalance: highPercent, direction: 'RISE', consecutiveLow, sequenceOk: false },
        ).catch(() => {});
        return false;
      }
    }
    // Para FALL: verificar se >60% dos dígitos são baixos (0-4)
    else if (direction === 'FALL') {
      const lowDigits = digits.filter(d => d < 5).length;
      const lowPercent = lowDigits / 20;
      imbalance = `${(lowPercent * 100).toFixed(0)}%_DOWN`;
      
      if (lowPercent <= 0.6) {
        // Log de análise estatística (falhou)
        await this.saveLog(
          userId,
          'DEBUG',
          'ANALYZER',
          `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
          { imbalance: lowPercent, direction: 'FALL', lowDigits, totalDigits: 20 },
        ).catch(() => {});
        return false;
      }

      // Verificar sequência contrária
      let consecutiveHigh = 0;
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] >= 5) {
          consecutiveHigh++;
        } else {
          break;
        }
      }
      sequenceOk = consecutiveHigh < 4;
      
      if (consecutiveHigh >= 4) {
        // Log de análise estatística (falhou por sequência)
        await this.saveLog(
          userId,
          'DEBUG',
          'ANALYZER',
          `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
          { imbalance: lowPercent, direction: 'FALL', consecutiveHigh, sequenceOk: false },
        ).catch(() => {});
        return false;
      }
    }

    // Log de análise estatística (sucesso)
    await this.saveLog(
      userId,
      'DEBUG',
      'ANALYZER',
      `📊 Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=${sequenceOk}`,
      { imbalance, direction, sequenceOk },
    ).catch(() => {});

    return true;
  }

  // ============================================
  // EXECUÇÃO DE TRADES
  // ============================================

  private async executeTrade(state: AutonomousAgentState, analysis: TechnicalAnalysis): Promise<void> {
    if (!analysis.direction) {
      return;
    }

    state.isOperationActive = true;

    try {
      // Determinar tipo de contrato baseado no nível de Martingale/Soros
      let contractType: string;
      let stakeAmount: number;
      
      // Verificar se está em modo Soros
      if (state.sorosLevel > 0) {
        // Soros: usar stake calculado do Soros
        contractType = analysis.direction; // Rise/Fall para Soros
        stakeAmount = state.sorosStake;
        
            // Log de Soros ativo (formato da documentação)
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros active. level=${state.sorosLevel}, stake=${stakeAmount.toFixed(2)}, initial_stake=${state.initialStake.toFixed(2)}`,
          {
            sorosLevel: state.sorosLevel,
            sorosStake: stakeAmount,
            initialStake: state.initialStake,
          },
        );
      } else if (state.martingaleLevel === 'M0') {
        // Operação normal: Rise/Fall
        contractType = analysis.direction;
        stakeAmount = state.initialStake;
        
        // Log de operação normal
        await this.saveLog(
          state.userId,
          'DEBUG',
          'RISK',
          `Normal operation (M0). initial_stake=${stakeAmount.toFixed(2)}, contract_type=${contractType}`,
          {
            martingaleLevel: 'M0',
            stake: stakeAmount,
            contractType,
          },
        ).catch(() => {});
      } else if (state.martingaleLevel === 'M1' || state.martingaleLevel === 'M2') {
        // Recuperação M1 ou M2: Precisa consultar payout primeiro para calcular stake
        if (state.martingaleLevel === 'M1') {
          contractType = analysis.direction === 'RISE' ? 'HIGHER' : 'LOWER';
        } else {
          contractType = analysis.direction === 'RISE' ? 'ONETOUCH' : 'NOTOUCH';
        }
        
        // Log antes de calcular stake de Martingale
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Calculating Martingale stake. level=${state.martingaleLevel}, contract_type=${contractType}`,
          {
            martingaleLevel: state.martingaleLevel,
            contractType,
          },
        ).catch(() => {});

        // Consultar payout e calcular stake de recuperação
        stakeAmount = await this.calculateMartingaleStake(state, contractType);
        
        if (stakeAmount <= 0 || !isFinite(stakeAmount)) {
          await this.saveLog(
            state.userId,
            'ERROR',
            'RISK',
            `Erro ao calcular stake de Martingale. calculated_stake=${stakeAmount}, abortando operação.`,
            {
              calculatedStake: stakeAmount,
              martingaleLevel: state.martingaleLevel,
            },
          );
          state.isOperationActive = false;
          return;
        }
        
        // Log após calcular stake de Martingale
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Martingale stake calculated. level=${state.martingaleLevel}, calculated_stake=${stakeAmount.toFixed(2)}`,
          {
            martingaleLevel: state.martingaleLevel,
            calculatedStake: stakeAmount,
          },
        ).catch(() => {});

        // Verificar Stop Loss Normal DEPOIS de calcular stake (conforme documentação)
        const stopLossCheck = await this.checkStopLossAfterStake(state, stakeAmount);
        if (!stopLossCheck.canProceed) {
          await this.saveLog(
            state.userId,
            'WARN',
            'RISK',
            `STOP LOSS NORMAL: Próxima aposta ultrapassaria limite. ${stopLossCheck.message}`,
            {
              calculatedStake: stakeAmount,
              message: stopLossCheck.message,
            },
          );
          // Ajustar stake para não ultrapassar o limite
          const config = await this.dataSource.query(
            `SELECT daily_loss_limit, daily_loss FROM autonomous_agent_config WHERE user_id = ?`,
            [state.userId],
          );
          
          if (config && config.length > 0) {
            const currentLoss = parseFloat(config[0].daily_loss) || 0;
            const lossLimit = parseFloat(config[0].daily_loss_limit) || 0;
            const maxAllowedStake = lossLimit - currentLoss;
            
            if (maxAllowedStake > 0 && maxAllowedStake < stakeAmount) {
              stakeAmount = maxAllowedStake;
              await this.saveLog(
                state.userId,
                'WARN',
                'RISK',
                `Stake ajustado para não ultrapassar limite. novo_stake=${stakeAmount.toFixed(2)}`,
              );
            } else {
              // Não há espaço para operar
              state.isOperationActive = false;
              return;
            }
          } else {
            state.isOperationActive = false;
            return;
          }
        }
      } else {
        // Fallback
        contractType = analysis.direction;
        stakeAmount = state.initialStake;
      }

      // Duração dinâmica (5-10 ticks)
      const duration = Math.floor(
        Math.random() * (SENTINEL_CONFIG.contractDurationMax - SENTINEL_CONFIG.contractDurationMin + 1) +
          SENTINEL_CONFIG.contractDurationMin,
      );

      // Log de proposta enviada (formato da documentação)
      await this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Proposal sent. contract_type=${contractType}, stake=${stakeAmount.toFixed(2)}`,
        {
          direction: contractType,
          stake: stakeAmount,
          duration,
          martingaleLevel: state.martingaleLevel,
        },
      );

      // Criar registro no banco (payout será atualizado após consulta via API)
      const tradeId = await this.createTradeRecord(state, {
        contractType: contractType as ContractType,
        stakeAmount,
        duration,
        analysis,
        payout: 0, // Será atualizado após consulta via API
      });

      // Executar na Deriv
      const result = await this.executeTradeOnDeriv({
        tradeId,
        state,
        contractType: contractType as ContractType,
        stakeAmount,
        duration,
      });

      // Log de compra executada (formato da documentação)
      if (result.contractId) {
        await this.saveLog(
          state.userId,
          'INFO',
          'TRADER',
          `Buy order executed. contract_id=${result.contractId}`,
          { contractId: result.contractId },
        );
      }

      // Log antes de processar resultado
      await this.saveLog(
        state.userId,
        'DEBUG',
        'RISK',
        `Processing trade result. trade_id=${tradeId}, profit_loss=${result.profitLoss.toFixed(2)}, status=${result.status}, stake=${stakeAmount.toFixed(2)}`,
        {
          tradeId,
          profitLoss: result.profitLoss,
          status: result.status,
          stake: stakeAmount,
          martingaleLevel: state.martingaleLevel,
          sorosLevel: state.sorosLevel,
        },
      ).catch(() => {});

      // Processar resultado
      await this.handleTradeResult(state, tradeId, result, stakeAmount);

      // Verificar se precisa de pausa aleatória
      if (state.operationsSincePause >= SENTINEL_CONFIG.pauseAfterOperations) {
        await this.handleRandomPause(state);
        // Log de fim da pausa será feito quando o agente retomar
        return;
      }

      // Atualizar próximo trade com intervalo aleatório
      const interval = this.getRandomInterval();
      await this.updateNextTradeAt(state.userId, interval);
      await this.saveLog(
        state.userId,
        'DEBUG',
        'HUMANIZER',
        `New random interval set. duration_seconds=${interval}`,
      );
      state.operationsSincePause++;
    } catch (error) {
      this.logger.error(`[ExecuteTrade][${state.userId}] Erro:`, error);
      state.isOperationActive = false;
    }
  }

  /**
   * Consulta a API da Deriv para obter detalhes do contrato usando contract_id
   * Retorna entry_price e exit_price se disponíveis
   */
  private async fetchContractDetailsFromDeriv(
    contractId: string,
    derivToken: string,
  ): Promise<{ entryPrice: number; exitPrice: number; profit: number; status: string } | null> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout ao consultar contrato na Deriv'));
      }, 10000); // 10 segundos de timeout

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: derivToken }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.error.message || 'Erro da Deriv'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            // Após autorização, consultar o contrato
            ws.send(
              JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 0, // Não inscrever, apenas consultar
              }),
            );
            return;
          }

          if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            clearTimeout(timeout);
            ws.close();

            if (!contract) {
              resolve(null);
              return;
            }

            const entryPrice = Number(
              contract.entry_spot ||
                contract.entry_tick ||
                contract.spot ||
                0,
            );
            const exitPrice = Number(
              contract.exit_spot ||
                contract.exit_tick ||
                contract.current_spot ||
                contract.spot ||
                0,
            );
            const profit = Number(contract.profit || contract.profit_percentage || 0);
            const status = contract.is_sold === 1 || contract.status === 'sold' ? 'sold' : 'active';

            this.logger.log(
              `[FetchContractDetails] Contrato ${contractId}: entry=${entryPrice}, exit=${exitPrice}, profit=${profit}, status=${status}`,
            );

            resolve({
              entryPrice,
              exitPrice,
              profit,
              status,
            });
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  private async createTradeRecord(
    state: AutonomousAgentState,
    trade: {
      contractType: ContractType;
      stakeAmount: number;
      duration: number;
      analysis: TechnicalAnalysis;
      payout: number;
    },
  ): Promise<number> {
    const analysisData = {
      ema10: trade.analysis.ema10,
      ema25: trade.analysis.ema25,
      ema50: trade.analysis.ema50,
      rsi: trade.analysis.rsi,
      momentum: trade.analysis.momentum,
      reasoning: trade.analysis.reasoning,
    };

    const result = await this.dataSource.query(
      `INSERT INTO autonomous_agent_trades (
        user_id, analysis_data, confidence_score, analysis_reasoning,
        contract_type, contract_duration, entry_price, stake_amount,
        martingale_level, payout, symbol, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())`,
      [
        state.userId,
        JSON.stringify(analysisData),
        trade.analysis.confidenceScore,
        trade.analysis.reasoning,
        trade.contractType,
        trade.duration,
        0, // Será atualizado após proposta
        trade.stakeAmount,
        state.martingaleLevel,
        trade.payout,
        state.symbol,
      ],
    );

    return result.insertId;
  }

  private async executeTradeOnDeriv(params: {
    tradeId: number;
    state: AutonomousAgentState;
    contractType: ContractType;
    stakeAmount: number;
    duration: number;
  }): Promise<TradeResult> {
    const { tradeId, state, contractType, stakeAmount, duration } = params;

    // Verificar se o token existe
    if (!state.derivToken) {
      return Promise.reject(new Error('Token Deriv não configurado'));
    }

    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);

      let contractId: string | null = null;
      let isCompleted = false;

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          ws.close();
          reject(new Error('Timeout ao executar contrato'));
        }
      }, 60000);

      const finalize = async (error?: Error, result?: TradeResult) => {
        if (isCompleted) {
          return;
        }
        isCompleted = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (closeError) {
          this.logger.warn('Erro ao fechar WebSocket:', closeError);
        }
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        }
      };

      ws.on('open', () => {
        this.logger.log(`[ExecuteTrade] WS conectado para trade ${tradeId}`);
        this.saveLog(state.userId, 'INFO', 'API', 'Conexão WebSocket estabelecida.').catch(() => {});
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          // Log de debug: todas as mensagens recebidas
          this.logger.debug(`[ExecuteTrade] Mensagem recebida. msg_type=${msg.msg_type || 'unknown'}, trade_id=${tradeId}`);
          this.logger.debug(`[ExecuteTrade] Mensagem completa:`, JSON.stringify(msg, null, 2));

          // Verificar erros (pode estar em msg.error ou em msg.echo_req com error)
          if (msg.error) {
            const errorMessage = msg.error.message || msg.error.code || JSON.stringify(msg.error);
            this.logger.error(`[ExecuteTrade] Erro recebido da Deriv API. trade_id=${tradeId}, error=`, msg.error);
            await this.saveLog(
              state.userId,
              'ERROR',
              'API',
              `Erro da Deriv API. erro=${errorMessage}`,
              { error: msg.error, fullMessage: msg, tradeId },
            ).catch(() => {});
            await this.dataSource.query(
              'UPDATE autonomous_agent_trades SET status = ?, error_message = ? WHERE id = ?',
              ['ERROR', errorMessage, tradeId],
            );
            finalize(new Error(errorMessage));
            return;
          }

          if (msg.msg_type === 'authorize') {
            await this.saveLog(
              state.userId,
              'INFO',
              'API',
              `Autorização bem-sucedida. conta=${msg.authorize?.loginid || 'N/A'}`,
              { loginid: msg.authorize?.loginid, tradeId },
            ).catch(() => {});

            // Compra direta (conforme MUDANCA_FLUXO_COMPRA_DIRETA.md e padrão da IA)
            // Enviar buy diretamente com parâmetros do contrato (sem proposal prévia)
            const buyPayload = {
              buy: 1,
              price: stakeAmount,
              parameters: {
                contract_type: contractType,
                duration: duration,
                duration_unit: 't',
                symbol: state.symbol,
              },
            };

            this.logger.log(`[ExecuteTrade] Enviando compra direta para trade ${tradeId}`, buyPayload);
            await this.saveLog(
              state.userId,
              'INFO',
              'TRADER',
              `Querying payout for contract_type=${contractType}`,
              {
                contractType,
                martingaleLevel: state.martingaleLevel,
                sorosLevel: state.sorosLevel,
              },
            ).catch(() => {});
            
            await this.saveLog(
              state.userId,
              'DEBUG',
              'TRADER',
              `Sending direct buy order. trade_id=${tradeId}, contract_type=${contractType}, stake=${stakeAmount.toFixed(2)}`,
              {
                tradeId,
                contractType,
                stake: stakeAmount,
                duration,
              },
            ).catch(() => {});
            
            ws.send(JSON.stringify(buyPayload));
            return;
          }

          // Processar resposta do buy (compra direta - conforme MUDANCA_FLUXO_COMPRA_DIRETA.md)
          if (msg.msg_type === 'buy') {
            const buy = msg.buy;
            if (!buy || !buy.contract_id) {
              await this.saveLog(
                state.userId,
                'ERROR',
                'TRADER',
                `Compra não confirmada. trade_id=${tradeId}`,
                { tradeId, buy },
              ).catch(() => {});
              finalize(new Error('Compra não confirmada'));
              return;
            }

            contractId = buy.contract_id;
            const buyPrice = Number(buy.buy_price || stakeAmount);
            const entrySpot = Number(buy.entry_spot || 0);
            
            // Extrair payout da resposta do buy (se disponível)
            const payoutAbsolute = Number(buy.payout || 0);
            if (payoutAbsolute > 0) {
              // Atualizar payout no banco (lucro líquido = payout - stakeAmount)
              const payoutLiquido = payoutAbsolute - stakeAmount;
              await this.dataSource.query(
                'UPDATE autonomous_agent_trades SET payout = ? WHERE id = ?',
                [payoutLiquido, tradeId],
              );

              // Calcular payout percentual para logs
              const payoutPercentual = buyPrice > 0 
                ? ((payoutAbsolute / buyPrice - 1) * 100) 
                : 0;
              const payoutCliente = payoutPercentual - 3;
              
              // Logs de payout (formato da documentação)
              await this.saveLog(
                state.userId,
                'DEBUG',
                'TRADER',
                `Payout from Deriv (buy response): ${payoutPercentual.toFixed(2)}%`,
                {
                  payoutPercentual,
                  payoutAbsolute,
                  buyPrice,
                },
              ).catch(() => {});
              
              await this.saveLog(
                state.userId,
                'DEBUG',
                'TRADER',
                `Payout ZENIX (after 3% markup): ${payoutCliente.toFixed(2)}%`,
                {
                  payoutCliente,
                  payoutPercentual,
                  markup: 3,
                },
              ).catch(() => {});
            }

            this.logger.log(
              `[ExecuteTrade] Atualizando entry_price | tradeId=${tradeId} | entrySpot=${entrySpot} | buy.entry_spot=${buy.entry_spot}`,
            );

            await this.dataSource.query(
              `UPDATE autonomous_agent_trades 
               SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
               WHERE id = ?`,
              [contractId, entrySpot, tradeId],
            );
            
            this.logger.log(`[ExecuteTrade] ✅ entry_price atualizado no banco | tradeId=${tradeId} | entryPrice=${entrySpot}`);

            // Inscrever para monitorar contrato (seguindo padrão do AiService)
            await this.saveLog(
              state.userId,
              'DEBUG',
              'TRADER',
              `Subscribing to contract. trade_id=${tradeId}, contract_id=${contractId}`,
              {
                tradeId,
                contractId,
              },
            ).catch(() => {});
            
            ws.send(
              JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1,
              }),
            );
            
            this.logger.log(
              `[ExecuteTrade] Compra confirmada | trade=${tradeId} | contrato=${contractId} | preço=${buyPrice}`,
            );
            
            await this.saveLog(
              state.userId,
              'INFO',
              'TRADER',
              `Buy order executed. contract_id=${contractId}, trade_id=${tradeId}, entry_price=${entrySpot.toFixed(2)}`,
              {
                tradeId,
                contractId,
                entryPrice: entrySpot,
                buyPrice,
              },
            ).catch(() => {});
            
            return;
          }

          // Processar proposal_open_contract (seguindo padrão do AiService)
          if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            
            // Se contrato ainda não foi vendido, verificar se podemos obter payout
            if (!contract || contract.is_sold !== 1) {
              // Obter payout via proposal_open_contract se não foi obtido na resposta do buy
              if (contract.payout && contract.buy_price) {
                const payoutAbsolute = Number(contract.payout || 0);
                const buyPrice = Number(contract.buy_price || stakeAmount);
                
                if (payoutAbsolute > 0) {
                  // Atualizar payout no banco (lucro líquido = payout - stakeAmount)
                  const payoutLiquido = payoutAbsolute - stakeAmount;
                  await this.dataSource.query(
                    'UPDATE autonomous_agent_trades SET payout = ? WHERE id = ?',
                    [payoutLiquido, tradeId],
                  ).catch(() => {});

                  // Calcular payout percentual para logs
                  const payoutPercentual = buyPrice > 0 
                    ? ((payoutAbsolute / buyPrice - 1) * 100) 
                    : 0;
                  const payoutCliente = payoutPercentual - 3;
                  
                  // Logs de payout (formato da documentação)
                  await this.saveLog(
                    state.userId,
                    'DEBUG',
                    'TRADER',
                    `Payout from Deriv (proposal_open_contract): ${payoutPercentual.toFixed(2)}%`,
                    {
                      payoutPercentual,
                      payoutAbsolute,
                      buyPrice,
                    },
                  ).catch(() => {});
                  
                  await this.saveLog(
                    state.userId,
                    'DEBUG',
                    'TRADER',
                    `Payout ZENIX (after 3% markup): ${payoutCliente.toFixed(2)}%`,
                    {
                      payoutCliente,
                      payoutPercentual,
                      markup: 3,
                    },
                  ).catch(() => {});
                }
              }
              
              // Log de atualização do contrato (seguindo padrão do AiService)
              await this.saveLog(
                state.userId,
                'DEBUG',
                'TRADER',
                `Contract update received. trade_id=${tradeId}, contract_id=${contract.contract_id || contractId}, is_sold=${contract.is_sold || 0}, status=${contract.status || 'active'}`,
                {
                  tradeId,
                  contractId: contract.contract_id || contractId,
                  isSold: contract.is_sold || 0,
                  status: contract.status || 'active',
                },
              ).catch(() => {});
              
              return;
            }

            // Contrato foi vendido - processar resultado
            const profit = Number(contract.profit || 0);
            const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
            const status = profit >= 0 ? 'WON' : 'LOST';

            this.logger.log(
              `[ExecuteTrade] Atualizando exit_price | tradeId=${tradeId} | exitPrice=${exitPrice} | profit=${profit} | status=${status}`,
            );

            await this.dataSource.query(
              `UPDATE autonomous_agent_trades
               SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
               WHERE id = ?`,
              [exitPrice, profit, status, tradeId],
            );

            // Log de resultado (seguindo padrão do AiService)
            if (status === 'WON') {
              await this.saveLog(
                state.userId,
                'INFO',
                'RISK',
                `Trade WIN. profit=${profit.toFixed(2)}`,
                {
                  result: status,
                  profit,
                  contractId: contract.contract_id || contractId,
                  exitPrice,
                },
              ).catch(() => {});
            } else {
              await this.saveLog(
                state.userId,
                'ERROR',
                'RISK',
                `Trade LOSS. loss=${Math.abs(profit).toFixed(2)}`,
                {
                  result: status,
                  profit,
                  contractId: contract.contract_id || contractId,
                  exitPrice,
                },
              ).catch(() => {});
            }

            // Finalizar com resultado
            finalize(undefined, {
              profitLoss: profit,
              status,
              exitPrice,
              contractId: contract.contract_id || contractId || '',
            });
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (error) => {
        finalize(error);
      });

      ws.on('close', () => {
        if (!isCompleted) {
          finalize(new Error('WebSocket fechado inesperadamente'));
        }
      });
    });
  }

  /**
   * Verifica se a coluna soros_profit existe no banco de dados
   * Retorna true se existir, false caso contrário
   */
  private async hasSorosProfitColumn(): Promise<boolean> {
    try {
      const result = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'autonomous_agent_config' 
         AND COLUMN_NAME = 'soros_profit'`
      );
      return result && result.length > 0 && result[0].count > 0;
    } catch (error) {
      this.logger.warn(`[HasSorosProfitColumn] Erro ao verificar coluna: ${error.message}`);
      return false;
    }
  }

  // Verificar Stop Loss Normal DEPOIS de calcular stake (conforme documentação)
  private async checkStopLossAfterStake(
    state: AutonomousAgentState,
    calculatedStake: number,
  ): Promise<{ canProceed: boolean; message?: string }> {
    try {
      // Obter configuração do Stop Loss
      const config = await this.dataSource.query(
        `SELECT stop_loss_type, daily_loss_limit, daily_loss FROM autonomous_agent_config WHERE user_id = ?`,
        [state.userId],
      );

      if (config && config.length > 0) {
        const cfg = config[0];

        // Se for Stop Loss Blindado, não verificar aqui (é verificado após vitória)
        if (cfg.stop_loss_type === 'blindado') {
          return { canProceed: true };
        }

        // Para Stop Loss Normal: verificar se o stake calculado ultrapassaria o limite
        const currentLoss = parseFloat(cfg.daily_loss) || 0;
        const lossLimit = parseFloat(cfg.daily_loss_limit) || 0;

        if (currentLoss >= lossLimit) {
          return {
            canProceed: false,
            message: `Limite de perda diária atingido (${currentLoss.toFixed(2)} >= ${lossLimit.toFixed(2)})`,
          };
        }

        // Verificar se a próxima perda potencial (stake calculado) ultrapassaria o limite
        const potentialLoss = currentLoss + calculatedStake;
        if (potentialLoss > lossLimit) {
          return {
            canProceed: false,
            message: `Stake calculado (${calculatedStake.toFixed(2)}) ultrapassaria limite. perda_atual=${currentLoss.toFixed(2)}, limite=${lossLimit.toFixed(2)}, potencial=${potentialLoss.toFixed(2)}`,
          };
        }
      }

      return { canProceed: true };
    } catch (error) {
      this.logger.error(`[CheckStopLossAfterStake][${state.userId}] Erro:`, error);
      return { canProceed: true }; // Em caso de erro, permitir prosseguir
    }
  }

  // Método auxiliar para consultar payout e calcular stake de Martingale
  private async calculateMartingaleStake(state: AutonomousAgentState, contractType: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);
      let isCompleted = false;

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          ws.close();
          reject(new Error('Timeout ao consultar payout'));
        }
      }, 10000);

      const finalize = (error?: Error, stake?: number) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (e) {}
        if (error) {
          reject(error);
        } else {
          resolve(stake || 0);
        }
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            finalize(new Error(msg.error.message || 'Erro ao consultar payout'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            // Log de consulta de payout (formato da documentação)
            await this.saveLog(
              state.userId,
              'INFO',
              'TRADER',
              `Querying payout for contract_type=${contractType}`,
            ).catch(() => {});
            
            // Enviar proposal para consultar payout (usar stake mínimo para consulta)
            ws.send(JSON.stringify({
              proposal: 1,
              amount: 1, // Stake mínimo para consulta
              basis: 'stake',
              contract_type: contractType,
              currency: state.currency,
              duration: 7,
              duration_unit: 't',
              symbol: state.symbol,
            }));
            return;
          }

          if (msg.msg_type === 'proposal') {
            const proposal = msg.proposal;
            if (!proposal) {
              finalize(new Error('Proposta inválida'));
              return;
            }

            const askPrice = Number(proposal.ask_price || 1);
            const payoutAbsolute = Number(proposal.payout || 0);
            
            // Calcular payout percentual: (payout / ask_price - 1) × 100
            const payoutPercentual = askPrice > 0 
              ? ((payoutAbsolute / askPrice - 1) * 100) 
              : 0;
            
            // Calcular payout_cliente = payout_original - 3%
            const payoutCliente = payoutPercentual - 3;

            // Logs de payout (formato da documentação)
            await this.saveLog(
              state.userId,
              'DEBUG',
              'TRADER',
              `Payout from Deriv: ${payoutPercentual.toFixed(2)}%`,
            ).catch(() => {});
            
            await this.saveLog(
              state.userId,
              'DEBUG',
              'TRADER',
              `Payout ZENIX (after 3% markup): ${payoutCliente.toFixed(2)}%`,
            ).catch(() => {});

            if (payoutCliente <= 0) {
              finalize(new Error('Payout cliente inválido'));
              return;
            }

            // Obter perdas acumuladas
            const config = await this.dataSource.query(
              `SELECT daily_loss, risk_level FROM autonomous_agent_config WHERE user_id = ?`,
              [state.userId],
            );
            
            const totalLosses = config && config.length > 0 
              ? parseFloat(config[0].daily_loss) || 0 
              : 0;
            
            const mode = config && config.length > 0 
              ? config[0].risk_level || 'balanced' 
              : 'balanced';
            
            // Obter multiplicador do modo
            const multiplier = SENTINEL_CONFIG.managementMultipliers[mode as ManagementMode] || 1.25;
            
            // Calcular meta de lucro
            const targetProfit = totalLosses * multiplier;
            
            // Calcular stake: (meta × 100) / payout_cliente
            const recoveryStake = (targetProfit * 100) / payoutCliente;

            // Log do cálculo (formato da documentação)
            const modeName = mode === 'conservative' ? 'Conservador' : mode === 'aggressive' ? 'Agressivo' : 'Moderado';
            await this.saveLog(
              state.userId,
              'INFO',
              'RISK',
              `Calculating recovery stake. total_losses=${totalLosses.toFixed(2)}, mode=${modeName}, multiplier=${multiplier.toFixed(2)}`,
              {
                totalLosses,
                mode: modeName,
                multiplier,
              },
            ).catch(() => {});
            
            await this.saveLog(
              state.userId,
              'DEBUG',
              'RISK',
              `Target profit: ${targetProfit.toFixed(2)}, payout: ${payoutCliente.toFixed(2)}%, stake: ${recoveryStake.toFixed(2)}`,
              {
                targetProfit,
                payoutCliente,
                recoveryStake,
                calculation: `(targetProfit * 100) / payoutCliente = (${targetProfit.toFixed(2)} * 100) / ${payoutCliente.toFixed(2)} = ${recoveryStake.toFixed(2)}`,
              },
            ).catch(() => {});

            finalize(undefined, recoveryStake);
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (error) => finalize(error));
      ws.on('close', () => {
        if (!isCompleted) {
          finalize(new Error('WebSocket fechado inesperadamente'));
        }
      });
    });
  }

  private async handleTradeResult(
    state: AutonomousAgentState,
    tradeId: number,
    result: TradeResult,
    stakeAmount: number,
  ): Promise<void> {
    // Log de entrada no handleTradeResult
    this.logger.log(`[HandleTradeResult][${state.userId}] Iniciando processamento. trade_id=${tradeId}, status=${result.status}, profit_loss=${result.profitLoss.toFixed(2)}`);
    
    await this.saveLog(
      state.userId,
      'DEBUG',
      'RISK',
      `handleTradeResult called. trade_id=${tradeId}, status=${result.status}, profit_loss=${result.profitLoss.toFixed(2)}, stake=${stakeAmount.toFixed(2)}, martingale=${state.martingaleLevel}, soros=${state.sorosLevel}`,
      {
        tradeId,
        result: result.status,
        profitLoss: result.profitLoss,
        stake: stakeAmount,
        martingaleLevelBefore: state.martingaleLevel,
        sorosLevelBefore: state.sorosLevel,
      },
    ).catch(() => {});

    const won = result.status === 'WON';

    // Atualizar estatísticas
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET
        total_trades = total_trades + 1,
        ${won ? 'total_wins = total_wins + 1' : 'total_losses = total_losses + 1'},
        daily_profit = daily_profit + ?,
        daily_loss = daily_loss + ?,
        last_trade_at = NOW(),
        operations_since_pause = operations_since_pause + 1,
        updated_at = NOW()
       WHERE user_id = ?`,
      [won ? result.profitLoss : 0, won ? 0 : Math.abs(result.profitLoss), state.userId],
    );

    if (won) {
      // Vitória: Processar Soros ou resetar Martingale
      // Seguindo a ordem exata da documentação:
      // 1. Verificar Soros primeiro
      // 2. Se não estiver em Soros, verificar Martingale
      // 3. Se estiver em Martingale, resetar E ativar Soros
      // 4. Se não estiver em Martingale, ativar Soros
      state.dailyProfit += result.profitLoss;
      
      // Atualizar profit_peak para Stop Loss Blindado
      if (state.dailyProfit > state.profitPeak) {
        state.profitPeak = state.dailyProfit;
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET profit_peak = ? WHERE user_id = ?`,
          [state.profitPeak, state.userId],
        );
      }

      // 1. Verificar Soros primeiro (conforme documentação)
      if (state.sorosLevel === 1) {
        // Vitória no Soros 1 -> Vai para o Nível 2
        // Armazenar profit da última operação (conforme documentação)
        const nextStake = stakeAmount + result.profitLoss;
        state.sorosLevel = 2;
        state.sorosStake = nextStake;
        state.sorosProfit = result.profitLoss; // Profit da última operação ganha
        
        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 2, soros_stake = ?, soros_profit = ? WHERE user_id = ?`,
            [nextStake, result.profitLoss, state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 2, soros_stake = ? WHERE user_id = ?`,
            [nextStake, state.userId],
          );
        }
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros active. level=2, stake=${nextStake.toFixed(2)}, previous_stake=${stakeAmount.toFixed(2)}, profit=${result.profitLoss.toFixed(2)}`,
          {
            sorosLevelBefore: 1,
            sorosLevelAfter: 2,
            sorosStakeBefore: stakeAmount,
            sorosStakeAfter: nextStake,
            profit: result.profitLoss,
          },
        );
      } else if (state.sorosLevel === 2) {
        // Vitória no Soros 2 -> Ciclo completo!
        state.sorosLevel = 0;
        state.sorosStake = 0;
        state.sorosProfit = 0.0; // Resetar profit (conforme documentação)
        
        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0, soros_profit = 0 WHERE user_id = ?`,
            [state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0 WHERE user_id = ?`,
            [state.userId],
          );
        }
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros complete. Cycle finished. Returning to initial stake. profit=${result.profitLoss.toFixed(2)}, initial_stake=${state.initialStake.toFixed(2)}`,
          {
            sorosLevelBefore: 2,
            sorosLevelAfter: 0,
            profit: result.profitLoss,
            initialStake: state.initialStake,
          },
        );
      } else if (state.martingaleLevel !== 'M0') {
        // 2. Se não estiver em Soros, verificar Martingale
        // 3. Vitória na recuperação -> Reseta tudo e ativa Soros 1
        const martingaleLevelBefore = state.martingaleLevel;
        state.martingaleLevel = 'M0';
        state.martingaleCount = 0;
        state.lastLossAmount = 0;
        
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET
            martingale_level = 'M0',
            martingale_count = 0,
            last_loss_amount = 0
           WHERE user_id = ?`,
          [state.userId],
        );

        // Log de reset do Martingale
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Martingale resetado. motivo=OperaçãoGanhou, lucro=${result.profitLoss.toFixed(2)}, level_anterior=${martingaleLevelBefore}`,
          {
            martingaleLevelBefore,
            martingaleLevelAfter: 'M0',
            profit: result.profitLoss,
            reason: 'OperaçãoGanhou',
          },
        );

        // Ativar Soros Nível 1 após resetar Martingale
        const sorosStake = state.initialStake + result.profitLoss;
        state.sorosLevel = 1;
        state.sorosStake = sorosStake;
        state.sorosProfit = result.profitLoss; // Armazenar profit da última operação
        
        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ?, soros_profit = ? WHERE user_id = ?`,
            [sorosStake, result.profitLoss, state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ? WHERE user_id = ?`,
            [sorosStake, state.userId],
          );
        }
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros activated (level 1). initial_stake=${state.initialStake.toFixed(2)}, profit=${result.profitLoss.toFixed(2)}, soros_stake=${sorosStake.toFixed(2)}`,
          {
            sorosLevel: 1,
            initialStake: state.initialStake,
            profit: result.profitLoss,
            sorosStake,
          },
        );
      } else {
        // 4. Vitória normal (M0 e não em Soros) -> Ativa Soros 1
        const sorosStake = state.initialStake + result.profitLoss;
        state.sorosLevel = 1;
        state.sorosStake = sorosStake;
        state.sorosProfit = result.profitLoss; // Armazenar profit da última operação
        
        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ?, soros_profit = ? WHERE user_id = ?`,
            [sorosStake, result.profitLoss, state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ? WHERE user_id = ?`,
            [sorosStake, state.userId],
          );
        }
        await this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros activated (level 1). initial_stake=${state.initialStake.toFixed(2)}, profit=${result.profitLoss.toFixed(2)}, soros_stake=${sorosStake.toFixed(2)}`,
          {
            sorosLevel: 1,
            initialStake: state.initialStake,
            profit: result.profitLoss,
            sorosStake,
          },
        );
      }

      state.isOperationActive = false;

      await this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Operação finalizada. resultado=VITÓRIA, lucro=${result.profitLoss.toFixed(2)}`,
      );

      this.logger.log(
        `[HandleTradeResult][${state.userId}] ✅ VITÓRIA! Lucro: $${result.profitLoss.toFixed(2)}`,
      );
    } else {
      // Perda: Se estava em Soros, entrar em recuperação. Senão, ativar Martingale
      state.dailyLoss += Math.abs(result.profitLoss);
      state.isOperationActive = false;

      // Log de perda detectada
      await this.saveLog(
        state.userId,
        'ERROR',
        'RISK',
        `Trade LOSS detected. loss=${Math.abs(result.profitLoss).toFixed(2)}, stake=${stakeAmount.toFixed(2)}, current_martingale=${state.martingaleLevel}, current_soros=${state.sorosLevel}`,
        {
          loss: Math.abs(result.profitLoss),
          stake: stakeAmount,
          martingaleLevel: state.martingaleLevel,
          sorosLevel: state.sorosLevel,
        },
      ).catch(() => {});

      // Se estava em Soros, entrar em recuperação imediatamente
      if (state.sorosLevel > 0) {
        // Salvar estado antes de resetar
        const sorosLevelBefore = state.sorosLevel;
        const sorosStakeBefore = state.sorosStake;
        const sorosProfitBefore = state.sorosProfit;
        
        // Calcular perda líquida: stake atual - profit da última operação ganha (conforme documentação)
        // net_loss = stake - soros_profit
        const netLoss = stakeAmount - state.sorosProfit;
        
        await this.saveLog(
          state.userId,
          'DEBUG',
          'RISK',
          `Soros loss calculation. soros_stake=${sorosStakeBefore.toFixed(2)}, soros_profit=${sorosProfitBefore.toFixed(2)}, stake_lost=${stakeAmount.toFixed(2)}, net_loss=${netLoss.toFixed(2)}`,
        ).catch(() => {});
        
        // Resetar Soros
        state.sorosLevel = 0;
        state.sorosStake = 0;
        state.sorosProfit = 0;
        
        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0, soros_profit = 0 WHERE user_id = ?`,
            [state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0 WHERE user_id = ?`,
            [state.userId],
          );
        }
        
        await this.saveLog(
          state.userId,
          'WARN',
          'RISK',
          `Soros failed! Entering recovery. martingale_level=M1, martingale_losses=${netLoss.toFixed(2)}`,
          {
            sorosLevelBefore,
            sorosStakeBefore,
            netLoss,
            nextMartingaleLevel: 'M1',
          },
        );
        
        // Atualizar lastLossAmount para o cálculo de Martingale
        state.lastLossAmount = netLoss;
      }

      // Obter configuração do modo
      const config = await this.dataSource.query(
        `SELECT daily_loss, risk_level, martingale_count FROM autonomous_agent_config WHERE user_id = ?`,
        [state.userId],
      );
      
      const totalLosses = config && config.length > 0 
        ? parseFloat(config[0].daily_loss) || 0 
        : 0;
      
      const mode = config && config.length > 0 
        ? config[0].risk_level || 'balanced' 
        : 'balanced';
      
      const currentMartingaleCount = config && config.length > 0 
        ? (config[0].martingale_count || 0) 
        : 0;

      // Verificar limite M5 para Conservador
      const martingaleLimit = SENTINEL_CONFIG.martingaleLimits[mode as ManagementMode] || Infinity;
      
      if (mode === 'conservative' && currentMartingaleCount >= martingaleLimit) {
        // Limite M5 atingido: aceitar perda e resetar
        state.martingaleLevel = 'M0';
        state.martingaleCount = 0;
        state.lastLossAmount = 0;
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET
            martingale_level = 'M0',
            martingale_count = 0,
            last_loss_amount = 0
           WHERE user_id = ?`,
          [state.userId],
        );
        
        await this.saveLog(
          state.userId,
          'WARN',
          'RISK',
          `Limite M5 atingido no modo Conservador. Aceitando perda e resetando para M0.`,
        );
        
        // Pausa de 15-30 segundos
        const pauseSeconds = 15 + Math.floor(Math.random() * 16); // 15-30 segundos
        await this.updateNextTradeAt(state.userId, pauseSeconds);
        await this.saveLog(
          state.userId,
          'INFO',
          'HUMANIZER',
          `Pausa após M5. duração_segundos=${pauseSeconds}`,
        );
        
        this.logger.log(
          `[HandleTradeResult][${state.userId}] ❌ PERDA. Limite M5 atingido, resetando para M0`,
        );
        return;
      }

      // Verificar se análise técnica é favorável para Martingale
      const prices = await this.getPriceHistory(state.userId, state.symbol);
      const tradingConfig = SENTINEL_CONFIG.tradingModes[state.tradingMode];
      const minTicks = tradingConfig.ticksRequired;
      
      if (prices.length >= minTicks) {
        const recentPrices = prices.slice(-minTicks);
        const analysis = this.performTechnicalAnalysis(recentPrices, state.userId);
        
        // Para Martingale, exigir confiança maior (80% mínimo)
        if (analysis.confidenceScore >= 80) {
          // Determinar próximo nível de Martingale
          let nextLevel: MartingaleLevel;
          if (state.martingaleLevel === 'M0') {
            nextLevel = 'M1';
          } else if (state.martingaleLevel === 'M1') {
            nextLevel = 'M2';
          } else {
            // Já está em M2, manter
            nextLevel = 'M2';
          }
          
          const newCount = currentMartingaleCount + 1;
          state.martingaleLevel = nextLevel;
          state.martingaleCount = newCount;
          state.lastLossAmount = stakeAmount;
          
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET
              martingale_level = ?,
              martingale_count = ?,
              last_loss_amount = ?
             WHERE user_id = ?`,
            [nextLevel, newCount, stakeAmount, state.userId],
          );

          const modeName = mode === 'conservative' ? 'Conservador' : mode === 'aggressive' ? 'Agressivo' : 'Moderado';
          
          await this.saveLog(
            state.userId,
            'WARN',
            'RISK',
            `Martingale activated. level=${nextLevel}, losses=${totalLosses.toFixed(2)}, count=${newCount}`,
            {
              martingaleLevelBefore: state.martingaleLevel,
              martingaleLevelAfter: nextLevel,
              martingaleCount: newCount,
              totalLosses,
              mode: modeName,
              lastLossAmount: stakeAmount,
            },
          );

          this.logger.log(
            `[HandleTradeResult][${state.userId}] ❌ PERDA. Ativando ${nextLevel} para recuperação`,
          );
        } else {
          // Análise insuficiente: resetar para M0
          state.martingaleLevel = 'M0';
          state.martingaleCount = 0;
          state.lastLossAmount = 0;
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET
              martingale_level = 'M0',
              martingale_count = 0,
              last_loss_amount = 0
             WHERE user_id = ?`,
            [state.userId],
          );

          await this.saveLog(
            state.userId,
            'DEBUG',
            'RISK',
            `Análise insuficiente para Martingale (confiança=${analysis.confidenceScore.toFixed(1)}%). Resetando para M0.`,
          );

          this.logger.log(
            `[HandleTradeResult][${state.userId}] ❌ PERDA. Análise insuficiente, resetando para M0`,
          );
        }
      }

      await this.saveLog(
        state.userId,
        'ERROR',
        'TRADER',
        `Operação finalizada. resultado=PERDA, perda=${Math.abs(result.profitLoss).toFixed(2)}`,
      );
    }

    // Verificar limites diários
    await this.checkDailyLimits(state);
  }

  // ============================================
  // UTILITÁRIOS
  // ============================================

  private getRandomInterval(): number {
    return Math.floor(
      Math.random() * (SENTINEL_CONFIG.maxIntervalSeconds - SENTINEL_CONFIG.minIntervalSeconds + 1) +
        SENTINEL_CONFIG.minIntervalSeconds,
    );
  }

  private async updateNextTradeAt(userId: string, intervalSeconds: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE user_id = ?`,
      [intervalSeconds, userId],
    );

    const state = this.agentStates.get(userId);
    if (state) {
      state.nextTradeAt = new Date(Date.now() + intervalSeconds * 1000);
    }
  }

  private async handleRandomPause(state: AutonomousAgentState): Promise<void> {
    const pauseMinutes =
      Math.floor(
        Math.random() * (SENTINEL_CONFIG.pauseMaxMinutes - SENTINEL_CONFIG.pauseMinMinutes + 1) +
          SENTINEL_CONFIG.pauseMinMinutes,
      );

    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET
        last_pause_at = NOW(),
        operations_since_pause = 0,
        next_trade_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
       WHERE user_id = ?`,
      [pauseMinutes, state.userId],
    );

    state.operationsSincePause = 0;
    state.nextTradeAt = new Date(Date.now() + pauseMinutes * 60 * 1000);

    // Log de pausa aleatória
    await this.saveLog(
      state.userId,
      'INFO',
      'HUMANIZER',
      `Pausa aleatória ativada. duração_minutos=${pauseMinutes}`,
      { durationMinutes: pauseMinutes },
    );

    this.logger.log(`[RandomPause][${state.userId}] ⏸️ Pausa aleatória de ${pauseMinutes} minutos`);
  }

  private async handleStopWin(userId: string): Promise<void> {
    const state = this.agentStates.get(userId);
    const dailyProfit = state?.dailyProfit || 0;
    const target = state?.dailyProfitTarget || 0;

    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = 'stopped_profit' WHERE user_id = ?`,
      [userId],
    );

    // Log de Stop Win
    await this.saveLog(
      userId,
      'INFO',
      'RISK',
      `STOP WIN ATINGIDO. lucro_diário=${dailyProfit.toFixed(2)}, meta=${target.toFixed(2)}. Parando operações pelo resto do dia.`,
      { dailyProfit, target },
    );

    this.logger.log(`[StopWin][${userId}] 🎯 STOP WIN ATINGIDO! Parando agente até próximo dia`);
  }

  private async handleStopLoss(userId: string): Promise<void> {
    const state = this.agentStates.get(userId);
    const dailyLoss = state?.dailyLoss || 0;
    const limit = state?.dailyLossLimit || 0;

    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = 'stopped_loss' WHERE user_id = ?`,
      [userId],
    );

    // Log de Stop Loss
    await this.saveLog(
      userId,
      'ERROR',
      'RISK',
      `STOP LOSS ATINGIDO. perda_diária=${(-dailyLoss).toFixed(2)}, limite=${(-limit).toFixed(2)}. Parando operações pelo resto do dia.`,
      { dailyLoss, limit },
    );

    this.logger.log(`[StopLoss][${userId}] 🛑 STOP LOSS ATINGIDO! Parando agente até próximo dia`);
  }

  private async checkDailyLimits(state: AutonomousAgentState): Promise<void> {
    const config = await this.dataSource.query(
      `SELECT daily_profit, daily_loss, daily_profit_target, daily_loss_limit
       FROM autonomous_agent_config WHERE user_id = ?`,
      [state.userId],
    );

    if (config && config.length > 0) {
      const cfg = config[0];
      if (parseFloat(cfg.daily_profit) >= parseFloat(cfg.daily_profit_target)) {
        await this.handleStopWin(state.userId);
      } else if (parseFloat(cfg.daily_loss) >= parseFloat(cfg.daily_loss_limit)) {
        await this.handleStopLoss(state.userId);
      }
    }
  }

  private async getPriceHistory(userId: string, symbol: string): Promise<PriceTick[]> {
    // Retornar histórico em memória se existir
    const cached = this.priceHistory.get(userId);
    if (cached && cached.length >= 50) {
      this.logger.debug(`[GetPriceHistory][${userId}] Usando cache: ${cached.length} ticks`);
      return cached;
    }

    // Se não houver cache suficiente, buscar do banco (últimas operações)
    // ou retornar array vazio (será preenchido quando houver ticks via WebSocket)
    try {
      const recentTrades = await this.dataSource.query(
        `SELECT entry_price, created_at 
         FROM autonomous_agent_trades 
         WHERE user_id = ? AND entry_price > 0 
         ORDER BY created_at DESC 
         LIMIT 50`,
        [userId],
      );

      if (recentTrades && recentTrades.length > 0) {
        const prices: PriceTick[] = recentTrades
          .reverse()
          .map((trade: any) => ({
            value: parseFloat(trade.entry_price),
            epoch: Math.floor(new Date(trade.created_at).getTime() / 1000),
            timestamp: new Date(trade.created_at).toISOString(),
          }));

        // Armazenar em cache
        this.priceHistory.set(userId, prices);
        this.logger.debug(`[GetPriceHistory][${userId}] Histórico do banco: ${prices.length} ticks`);
        return prices;
      }
    } catch (error) {
      this.logger.error(`[GetPriceHistory] Erro ao buscar histórico:`, error);
    }

    // Retornar histórico em memória mesmo que seja menor que 50
    if (cached && cached.length > 0) {
      this.logger.debug(`[GetPriceHistory][${userId}] Cache parcial: ${cached.length} ticks (aguardando mais ticks via WebSocket)`);
      return cached;
    }

    // Retornar array vazio se não houver dados
    this.logger.warn(`[GetPriceHistory][${userId}] ⚠️ Nenhum histórico disponível. Aguardando ticks via WebSocket...`);
    return [];
  }

  // Método para atualizar histórico de preços via WebSocket (chamado internamente)
  private async updatePriceHistory(userId: string, tick: PriceTick): Promise<void> {
    const cached = this.priceHistory.get(userId) || [];
    cached.push(tick);

    // Manter apenas os últimos N ticks
    if (cached.length > this.maxHistorySize) {
      cached.shift();
    }

    this.priceHistory.set(userId, cached);
  }

  // ============================================
  // CONEXÃO WEBSOCKET PERSISTENTE PARA TICKS
  // ============================================

  private async ensureWebSocketConnection(userId: string): Promise<void> {
    const state = this.agentStates.get(userId);
    if (!state) {
      return;
    }

    // Verificar se já existe conexão ativa
    const existingWs = this.wsConnections.get(userId);
    if (existingWs && existingWs.readyState === WebSocket.OPEN) {
      this.logger.debug(`[EnsureWebSocket][${userId}] Conexão WebSocket já está ativa`);
      return;
    }

    // Fechar conexão anterior se existir e estiver aberta
    if (existingWs) {
      try {
        if (existingWs.readyState === WebSocket.OPEN) {
          existingWs.close();
          // Aguardar um pouco para garantir que a conexão foi fechada
          await new Promise(resolve => setTimeout(resolve, 100));
        } else if (existingWs.readyState === WebSocket.CONNECTING) {
          // Se ainda estiver conectando, aguardar um pouco e verificar novamente
          await new Promise(resolve => setTimeout(resolve, 200));
          if (existingWs.readyState === WebSocket.OPEN) {
            existingWs.close();
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            // Se ainda estiver em CONNECTING, remover do map e deixar que expire naturalmente
            this.wsConnections.delete(userId);
          }
        } else {
          // Se estiver CLOSING ou CLOSED, apenas remover do map
          this.wsConnections.delete(userId);
        }
      } catch (error) {
        this.logger.warn(`[EnsureWebSocket][${userId}] Erro ao fechar conexão anterior:`, error);
        this.wsConnections.delete(userId);
      }
    }

    // Estabelecer nova conexão
    await this.establishWebSocketConnection(userId);
  }

  private async establishWebSocketConnection(userId: string): Promise<void> {
    const state = this.agentStates.get(userId);
    if (!state) {
      return;
    }

    try {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);

      let isAuthorized = false;
      let subscriptionId: string | null = null;

      ws.on('open', () => {
        this.logger.log(`[WebSocket][${userId}] ✅ Conexão estabelecida`);
        this.saveLog(userId, 'INFO', 'API', 'Conexão WebSocket aberta.').catch(() => {});
        
        // Autorizar
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            this.logger.error(`[WebSocket][${userId}] ❌ Erro:`, msg.error);
            this.saveLog(userId, 'ERROR', 'API', `❌ Erro no WebSocket. erro=${msg.error.message || 'Erro desconhecido'}`).catch(() => {});
            
            // Tentar reconectar após delay
            setTimeout(() => {
              this.establishWebSocketConnection(userId);
            }, 5000);
            return;
          }

          if (msg.msg_type === 'authorize') {
            isAuthorized = true;
            this.logger.log(`[WebSocket][${userId}] ✅ Autorizado: ${msg.authorize?.loginid || 'N/A'}`);
            this.saveLog(userId, 'INFO', 'API', `✅ Autorização bem-sucedida. conta=${msg.authorize?.loginid || 'N/A'}`).catch(() => {});
            
            // Subscribir aos ticks
            ws.send(JSON.stringify({
              ticks_history: state.symbol,
              adjust_start_time: 1,
              count: 50,
              end: 'latest',
              subscribe: 1,
              style: 'ticks',
            }));
            return;
          }

          if (msg.msg_type === 'history') {
            const history = msg.history;
            if (history && history.prices) {
              subscriptionId = history.id || null;
              
              // Processar histórico inicial
              const ticks: PriceTick[] = history.prices.map((price: number, index: number) => ({
                value: parseFloat(price.toString()),
                epoch: history.times ? history.times[index] : Math.floor(Date.now() / 1000),
                timestamp: history.times 
                  ? new Date(history.times[index] * 1000).toISOString()
                  : new Date().toISOString(),
              }));

              this.priceHistory.set(userId, ticks);
              this.logger.log(`[WebSocket][${userId}] 📊 Histórico inicial recebido: ${ticks.length} ticks`);
              this.saveLog(userId, 'INFO', 'API', `📊 Histórico inicial de preços recebido. ticks=${ticks.length}`).catch(() => {});
            }
            return;
          }

          if (msg.msg_type === 'tick') {
            const tick = msg.tick;
            if (tick && tick.quote !== undefined) {
              const priceTick: PriceTick = {
                value: parseFloat(tick.quote),
                epoch: tick.epoch || Math.floor(Date.now() / 1000),
                timestamp: tick.epoch 
                  ? new Date(tick.epoch * 1000).toISOString()
                  : new Date().toISOString(),
              };

              await this.updatePriceHistory(userId, priceTick);
            }
            return;
          }
        } catch (error) {
          this.logger.error(`[WebSocket][${userId}] Erro ao processar mensagem:`, error);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[WebSocket][${userId}] ❌ Erro no WebSocket:`, error);
        this.saveLog(userId, 'ERROR', 'API', `❌ Erro no WebSocket. erro=${error.message || 'Erro desconhecido'}`).catch(() => {});
      });

      ws.on('close', () => {
        this.logger.warn(`[WebSocket][${userId}] 🔌 Conexão WebSocket fechada`);
        this.wsConnections.delete(userId);
        this.saveLog(userId, 'WARN', 'API', '🔌 Conexão WebSocket fechada.').catch(() => {});

        // Tentar reconectar se o agente ainda estiver ativo
        const currentState = this.agentStates.get(userId);
        if (currentState) {
          setTimeout(() => {
            this.ensureWebSocketConnection(userId);
          }, 5000);
        }
      });

      this.wsConnections.set(userId, ws);
    } catch (error) {
      this.logger.error(`[EstablishWebSocket][${userId}] ❌ Erro ao estabelecer conexão:`, error);
      this.saveLog(userId, 'ERROR', 'API', `❌ Falha ao estabelecer WebSocket. erro=${error.message}`).catch(() => {});
      
      // Tentar reconectar após delay
      setTimeout(() => {
        this.establishWebSocketConnection(userId);
      }, 10000);
    }
  }

  // ============================================
  // RESET DE SESSÕES DIÁRIAS
  // ============================================

  async resetDailySessions(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Buscar agentes ativos antes do reset para obter saldo inicial
      const activeAgentsBefore = await this.dataSource.query(
        `SELECT user_id, daily_profit, daily_loss FROM autonomous_agent_config WHERE is_active = TRUE`,
      );

      // Resetar todas as sessões ativas
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET 
           daily_profit = 0,
           daily_loss = 0,
           operations_since_pause = 0,
           session_date = ?,
           session_status = 'active',
           next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
           updated_at = NOW()
         WHERE is_active = TRUE`,
        [today, this.getRandomInterval()],
      );

      // Re-sincronizar estados em memória
      await this.syncActiveAgentsFromDb();

      // Log de reset diário para cada agente (conforme documentação)
      for (const agent of activeAgentsBefore) {
        const balanceStartDay = (parseFloat(agent.daily_profit) || 0) - (parseFloat(agent.daily_loss) || 0);
        await this.saveLog(
          agent.user_id.toString(),
          'INFO',
          'CORE',
          `Reset diário executado. saldo_início_dia=${balanceStartDay.toFixed(2)}, data=${today.toISOString().split('T')[0]}`,
          {
            balanceStartDay,
            date: today.toISOString().split('T')[0],
          },
        );
      }

      this.logger.log('[ResetDailySessions] ✅ Sessões diárias resetadas');
    } catch (error) {
      this.logger.error('[ResetDailySessions] ❌ Erro:', error);
      throw error;
    }
  }

  // ============================================
  // MÉTODOS PÚBLICOS PARA API
  // ============================================

  async getAgentConfig(userId: string): Promise<any> {
    const config = await this.dataSource.query(
      `SELECT 
        is_active,
        initial_stake,
        daily_profit_target,
        daily_loss_limit,
        symbol,
        strategy,
        risk_level,
        total_trades,
        total_wins,
        total_losses,
        daily_profit,
        daily_loss,
        session_status,
        session_date,
        last_trade_at,
        next_trade_at,
        created_at
       FROM autonomous_agent_config
       WHERE user_id = ?`,
      [userId],
    );

    if (!config || config.length === 0) {
      return null;
    }

    const cfg = config[0];
    
    // Garantir que session_date seja retornado como string ISO se existir
    let sessionDate: string | null = null;
    if (cfg.session_date) {
      try {
        if (cfg.session_date instanceof Date) {
          sessionDate = cfg.session_date.toISOString();
        } else if (typeof cfg.session_date === 'string') {
          // Se já for string, garantir formato ISO
          // Se for apenas data (YYYY-MM-DD), adicionar hora atual
          if (cfg.session_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
            // É apenas data, usar hora atual
            const dateOnly = new Date(cfg.session_date);
            const now = new Date();
            dateOnly.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
            sessionDate = dateOnly.toISOString();
          } else {
            sessionDate = new Date(cfg.session_date).toISOString();
          }
        } else {
          sessionDate = new Date(cfg.session_date).toISOString();
        }
      } catch (error) {
        this.logger.warn(`[GetAgentConfig] Erro ao processar session_date:`, error);
        sessionDate = null;
      }
    }
    
    let createdAt: string | null = null;
    if (cfg.created_at) {
      if (cfg.created_at instanceof Date) {
        createdAt = cfg.created_at.toISOString();
      } else if (typeof cfg.created_at === 'string') {
        createdAt = new Date(cfg.created_at).toISOString();
      } else {
        createdAt = String(cfg.created_at);
      }
    }
    
    return {
      isActive: cfg.is_active === 1 || cfg.is_active === true,
      initialStake: parseFloat(cfg.initial_stake),
      dailyProfitTarget: parseFloat(cfg.daily_profit_target),
      dailyLossLimit: parseFloat(cfg.daily_loss_limit),
      symbol: cfg.symbol,
      strategy: cfg.strategy || 'arion',
      riskLevel: cfg.risk_level || 'balanced',
      totalTrades: cfg.total_trades || 0,
      totalWins: cfg.total_wins || 0,
      totalLosses: cfg.total_losses || 0,
      dailyProfit: parseFloat(cfg.daily_profit) || 0,
      dailyLoss: parseFloat(cfg.daily_loss) || 0,
      sessionStatus: cfg.session_status,
      sessionDate: sessionDate, // Retornar como ISO string
      createdAt: createdAt, // Retornar como ISO string
      lastTradeAt: cfg.last_trade_at ? (cfg.last_trade_at instanceof Date ? cfg.last_trade_at.toISOString() : cfg.last_trade_at) : null,
      nextTradeAt: cfg.next_trade_at ? (cfg.next_trade_at instanceof Date ? cfg.next_trade_at.toISOString() : cfg.next_trade_at) : null,
    };
  }

  async getTradeHistory(userId: string, limit: number = 50): Promise<any[]> {
    const trades = await this.dataSource.query(
      `SELECT 
        id, contract_type, contract_duration, entry_price, exit_price,
        stake_amount, profit_loss, status, confidence_score, martingale_level,
        payout, contract_id, created_at, started_at, closed_at
       FROM autonomous_agent_trades
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit],
    );

    return trades.map((trade: any) => ({
      id: trade.id,
      contractType: trade.contract_type,
      duration: trade.contract_duration,
      entryPrice: parseFloat(trade.entry_price),
      exitPrice: trade.exit_price ? parseFloat(trade.exit_price) : null,
      stakeAmount: parseFloat(trade.stake_amount),
      profitLoss: trade.profit_loss ? parseFloat(trade.profit_loss) : null,
      status: trade.status,
      confidenceScore: parseFloat(trade.confidence_score),
      martingaleLevel: trade.martingale_level,
      payout: trade.payout ? parseFloat(trade.payout) : null,
      contractId: trade.contract_id,
      createdAt: trade.created_at,
      startedAt: trade.started_at,
      closedAt: trade.closed_at,
    }));
  }

  /**
   * Atualiza trades com valores zerados consultando a API da Deriv
   * Útil para corrigir trades antigos que não tiveram os valores capturados corretamente
   */
  async updateTradesWithMissingPrices(userId: string, limit: number = 10): Promise<{ updated: number; errors: number }> {
    // Buscar trades com entry_price ou exit_price zerados e que tenham contract_id
    const tradesToUpdate = await this.dataSource.query(
      `SELECT id, contract_id, entry_price, exit_price, status
       FROM autonomous_agent_trades
       WHERE user_id = ? 
         AND contract_id IS NOT NULL 
         AND contract_id != ''
         AND (entry_price = 0 OR exit_price = 0 OR entry_price IS NULL OR exit_price IS NULL)
         AND status IN ('WON', 'LOST', 'ACTIVE')
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit],
    );

    if (tradesToUpdate.length === 0) {
      this.logger.log(`[UpdateTradesWithMissingPrices] Nenhum trade encontrado para atualizar para userId=${userId}`);
      return { updated: 0, errors: 0 };
    }

    // Obter o token do usuário
    const state = this.agentStates.get(userId);
    if (!state || !state.derivToken) {
      this.logger.warn(`[UpdateTradesWithMissingPrices] Token não encontrado para userId=${userId}`);
      return { updated: 0, errors: tradesToUpdate.length };
    }

    // Type assertion explícita para garantir que TypeScript reconhece que não é null
    const derivToken: string = state.derivToken as string;
    let updated = 0;
    let errors = 0;

    for (const trade of tradesToUpdate) {
      try {
        this.logger.log(`[UpdateTradesWithMissingPrices] Consultando contrato ${trade.contract_id} para trade ${trade.id}`);
        const contractDetails = await this.fetchContractDetailsFromDeriv(trade.contract_id, derivToken);
        
        if (contractDetails) {
          const updates: string[] = [];
          const values: any[] = [];
          
          if ((trade.entry_price === 0 || trade.entry_price === null) && contractDetails.entryPrice > 0) {
            updates.push('entry_price = ?');
            values.push(contractDetails.entryPrice);
            this.logger.log(`[UpdateTradesWithMissingPrices] Trade ${trade.id}: entry_price atualizado para ${contractDetails.entryPrice}`);
          }
          
          if ((trade.exit_price === 0 || trade.exit_price === null) && contractDetails.exitPrice > 0) {
            updates.push('exit_price = ?');
            values.push(contractDetails.exitPrice);
            this.logger.log(`[UpdateTradesWithMissingPrices] Trade ${trade.id}: exit_price atualizado para ${contractDetails.exitPrice}`);
          }
          
          if (updates.length > 0) {
            values.push(trade.id);
            await this.dataSource.query(
              `UPDATE autonomous_agent_trades SET ${updates.join(', ')} WHERE id = ?`,
              values,
            );
            updated++;
          }
        } else {
          this.logger.warn(`[UpdateTradesWithMissingPrices] Não foi possível obter detalhes do contrato ${trade.contract_id}`);
          errors++;
        }
      } catch (error) {
        this.logger.error(`[UpdateTradesWithMissingPrices] Erro ao atualizar trade ${trade.id}:`, error);
        errors++;
      }
      
      // Pequeno delay entre requisições para não sobrecarregar a API
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.logger.log(`[UpdateTradesWithMissingPrices] Atualização concluída: ${updated} atualizados, ${errors} erros`);
    return { updated, errors };
  }

  async getSessionStats(userId: string): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stats = await this.dataSource.query(
      `SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) as total_profit,
        SUM(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE 0 END) as total_loss
       FROM autonomous_agent_trades
       WHERE user_id = ? AND DATE(created_at) = DATE(?)
       AND status IN ('WON', 'LOST')`,
      [userId, today],
    );

    if (!stats || stats.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalProfit: 0,
        totalLoss: 0,
        netProfit: 0,
      };
    }

    const s = stats[0];
    const totalTrades = parseInt(s.total_trades) || 0;
    const wins = parseInt(s.wins) || 0;
    const losses = parseInt(s.losses) || 0;
    const totalProfit = parseFloat(s.total_profit) || 0;
    const totalLoss = parseFloat(s.total_loss) || 0;

    return {
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      totalProfit,
      totalLoss,
      netProfit: totalProfit - totalLoss,
    };
  }

  // ============================================
  // HISTÓRICO DE PREÇOS PARA GRÁFICOS
  // ============================================

  async getPriceHistoryForUser(userId: string, limit: number = 100): Promise<PriceTick[]> {
    try {
      const state = this.agentStates.get(userId);
      if (!state) {
        return [];
      }

      // Buscar histórico por userId (não por symbol)
      const prices = this.priceHistory.get(userId) || [];
      return prices.slice(-limit);
    } catch (error) {
      this.logger.error(`[GetPriceHistoryForUser][${userId}] Erro:`, error);
      return [];
    }
  }

  // ============================================
  // SISTEMA DE LOGS DETALHADOS
  // ============================================

  private async saveLog(
    userId: string,
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
    module: 'CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER',
    message: string,
    metadata?: any,
  ): Promise<void> {
    try {
      const now = new Date();
      const timestampISO = now.toISOString();
      
      // Formato da documentação: [TIMESTAMP] [LOG_LEVEL] [MÓDULO] - MENSAGEM
      // A mensagem já deve vir formatada, apenas adicionamos o prefixo
      const logMessage = `[${timestampISO}] [${level}] [${module}] - ${message}`;
      
      // Log no console também
      switch (level) {
        case 'ERROR':
          this.logger.error(logMessage);
          break;
        case 'WARN':
          this.logger.warn(logMessage);
          break;
        case 'DEBUG':
          this.logger.debug(logMessage);
          break;
        default:
          this.logger.log(logMessage);
      }

      // Converter para formato MySQL: YYYY-MM-DD HH:MM:SS.mmm
      const timestampMySQL = now
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
        .slice(0, 23); // YYYY-MM-DD HH:MM:SS.mmm (23 caracteres)

      // Salvar no banco de dados (salvar apenas a mensagem, sem o prefixo, pois será reconstruído no frontend)
      await this.dataSource.query(
        `INSERT INTO autonomous_agent_logs (user_id, timestamp, log_level, module, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, timestampMySQL, level, module, message, metadata ? JSON.stringify(metadata) : null],
      );
    } catch (error) {
      // Não falhar se houver erro ao salvar log
      this.logger.error(`[SaveLog][${userId}] Erro ao salvar log:`, error);
    }
  }

  async getLogs(userId: string, limit: number = 2000): Promise<any[]> {
    try {
      // Buscar logs (a tabela não tem created_at, apenas timestamp)
      const logs = await this.dataSource.query(
        `SELECT id, timestamp, log_level, module, message, metadata
         FROM autonomous_agent_logs
         WHERE user_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
        [userId, limit],
      );

      // Mapear log_level e module para type e icon (formato igual à IA)
      const levelToType: Record<string, string> = {
        'INFO': 'info',
        'DEBUG': 'analise',
        'WARN': 'alerta',
        'ERROR': 'erro',
        'LOG': 'info',
      };

      const moduleToIcon: Record<string, string> = {
        'CORE': '🚀',
        'ANALYZER': '🔍',
        'DECISION': '🎯',
        'TRADER': '💰',
        'API': '📡',
        'RISK': '⚠️',
        'HUMANIZER': '⏸️',
      };

      return logs.map(log => {
        let metadata = null;
        if (log.metadata) {
          try {
            if (typeof log.metadata === 'string') {
              metadata = JSON.parse(log.metadata);
            } else {
              metadata = log.metadata;
            }
          } catch (error) {
            this.logger.warn(`[GetLogs] Erro ao parsear metadata do log ${log.id}:`, error);
            metadata = null;
          }
        }

        // Mapear log_level para type
        const type = levelToType[log.log_level] || 'info';
        
        // Obter icon baseado no módulo ou type
        const icon = moduleToIcon[log.module] || (type === 'erro' ? '🚫' : type === 'alerta' ? '⚠️' : 'ℹ️');

        // Formatar timestamp como HH:mm:ss (horário de Brasília)
        let date: Date;
        if (typeof log.timestamp === 'string') {
          date = new Date(log.timestamp);
        } else if (log.timestamp instanceof Date) {
          date = log.timestamp;
        } else {
          date = new Date();
        }

        const formattedTime = date.toLocaleTimeString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        
        return {
          id: log.id,
          timestamp: formattedTime,
          created_at: log.timestamp, // Usar timestamp como created_at (a tabela não tem created_at)
          type,
          icon,
          message: log.message,
          details: metadata,
          level: log.log_level, // Para exibição no formato [LEVEL]
          module: log.module,   // Para exibição no formato [MODULE]
          log_level: log.log_level, // Manter compatibilidade
        };
      });
    } catch (error) {
      this.logger.error(`[GetLogs][${userId}] Erro:`, error);
      return [];
    }
  }
}

