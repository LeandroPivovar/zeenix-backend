import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import WebSocket from 'ws';

// ============================================
// INTERFACES E TIPOS
// ============================================

export type ContractType = 'RISE' | 'FALL' | 'HIGHER' | 'LOWER';
export type MartingaleLevel = 'M0' | 'M1';

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
  isOperationActive: boolean;
  martingaleLevel: MartingaleLevel;
  lastLossAmount: number;
  operationsSincePause: number;
  lastTradeAt: Date | null;
  nextTradeAt: Date | null;
  dailyProfit: number;
  dailyLoss: number;
  sessionDate: Date;
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
  minConfidenceScore: 80, // Score mínimo para operar
  contractDurationMin: 5, // Duração mínima em ticks
  contractDurationMax: 10, // Duração máxima em ticks
  payoutRiseFall: 1.90, // Payout Rise/Fall (~190%)
  payoutHigherLower: 2.50, // Payout Higher/Lower (~250%)
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

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
          deriv_token,
          currency,
          symbol,
          martingale_level,
          last_loss_amount,
          operations_since_pause,
          last_trade_at,
          next_trade_at,
          daily_profit,
          daily_loss,
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
        derivToken: agent.deriv_token,
        currency: agent.currency,
        symbol: agent.symbol || SENTINEL_CONFIG.symbol,
        martingaleLevel: agent.martingale_level || 'M0',
        lastLossAmount: parseFloat(agent.last_loss_amount) || 0,
        operationsSincePause: agent.operations_since_pause || 0,
        lastTradeAt: agent.last_trade_at ? new Date(agent.last_trade_at) : null,
        nextTradeAt: agent.next_trade_at ? new Date(agent.next_trade_at) : null,
        dailyProfit: parseFloat(agent.daily_profit) || 0,
        dailyLoss: parseFloat(agent.daily_loss) || 0,
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
    derivToken: string;
    currency: string;
    symbol: string;
    martingaleLevel: MartingaleLevel;
    lastLossAmount: number;
    operationsSincePause: number;
    lastTradeAt: Date | null;
    nextTradeAt: Date | null;
    dailyProfit: number;
    dailyLoss: number;
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
        isOperationActive: false,
        martingaleLevel: config.martingaleLevel,
        lastLossAmount: config.lastLossAmount,
        operationsSincePause: config.operationsSincePause,
        lastTradeAt: config.lastTradeAt,
        nextTradeAt: config.nextTradeAt,
        dailyProfit: config.dailyProfit,
        dailyLoss: config.dailyLoss,
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
    },
  ): Promise<void> {
    try {
      // Verificar se já existe configuração
      const existing = await this.dataSource.query(
        `SELECT id FROM autonomous_agent_config WHERE user_id = ?`,
        [userId],
      );

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (existing && existing.length > 0) {
        // Atualizar existente
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET
            is_active = TRUE,
            initial_stake = ?,
            daily_profit_target = ?,
            daily_loss_limit = ?,
            deriv_token = ?,
            currency = ?,
            session_date = ?,
            daily_profit = 0,
            daily_loss = 0,
            operations_since_pause = 0,
            session_status = 'active',
            next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
            updated_at = NOW()
           WHERE user_id = ?`,
          [
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            config.derivToken,
            config.currency || 'USD',
            today,
            this.getRandomInterval(),
            userId,
          ],
        );
      } else {
        // Criar novo
        await this.dataSource.query(
          `INSERT INTO autonomous_agent_config (
            user_id, is_active, initial_stake, daily_profit_target, daily_loss_limit,
            deriv_token, currency, symbol, session_date, session_status,
            next_trade_at, created_at, updated_at
          ) VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ? SECOND), NOW(), NOW())`,
          [
            userId,
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            config.derivToken,
            config.currency || 'USD',
            SENTINEL_CONFIG.symbol,
            today,
            this.getRandomInterval(),
          ],
        );
      }

      // Sincronizar estado em memória
      await this.syncActiveAgentsFromDb();

      // Estabelecer conexão WebSocket para receber ticks
      await this.ensureWebSocketConnection(userId);

      // Log detalhado
      await this.saveLog(
        userId,
        'INFO',
        'CORE',
        `IA SENTINEL Agent starting... version=2.0`,
        {
          initialStake: config.initialStake,
          dailyProfitTarget: config.dailyProfitTarget,
          dailyLossLimit: config.dailyLossLimit,
          currency: config.currency || 'USD',
        },
      );

      this.logger.log(`[ActivateAgent] ✅ Agente ativado para usuário ${userId}`);
    } catch (error) {
      await this.saveLog(userId, 'ERROR', 'CORE', `Agent activation failed. error=${error.message}`);
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
        await this.saveLog(userId, 'INFO', 'API', 'WebSocket disconnected.');
      }

      // Log detalhado
      await this.saveLog(userId, 'INFO', 'CORE', 'Agent stopped.');

      this.logger.log(`[DeactivateAgent] ✅ Agente desativado para usuário ${userId}`);
    } catch (error) {
      await this.saveLog(userId, 'ERROR', 'CORE', `Agent deactivation failed. error=${error.message}`);
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
      `SELECT session_status, daily_profit, daily_loss, daily_profit_target, daily_loss_limit
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

    // Verificar stop loss
    if (parseFloat(cfg.daily_loss) >= parseFloat(cfg.daily_loss_limit)) {
      await this.handleStopLoss(state.userId);
      return false;
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
      // Obter histórico de preços
      const prices = await this.getPriceHistory(state.userId, state.symbol);
      
      if (prices.length < 50) {
        this.logger.debug(`[ProcessAgent][${state.userId}] Histórico insuficiente (${prices.length}/50)`);
        return;
      }

      // Realizar análise técnica
      const analysis = this.performTechnicalAnalysis(prices, state.userId);

      // Verificar score de confiança
      if (analysis.confidenceScore < SENTINEL_CONFIG.minConfidenceScore) {
        await this.saveLog(
          state.userId,
          'DEBUG',
          'DECISION',
          `Signal invalidated. reason="Confidence score too low", confidence=${analysis.confidenceScore.toFixed(1)}%, min_required=${SENTINEL_CONFIG.minConfidenceScore}%`,
          { confidenceScore: analysis.confidenceScore, minRequired: SENTINEL_CONFIG.minConfidenceScore },
        );
        // Atualizar próximo trade com intervalo aleatório
        const interval = this.getRandomInterval();
        await this.updateNextTradeAt(state.userId, interval);
        await this.saveLog(
          state.userId,
          'DEBUG',
          'HUMANIZER',
          `New random interval set. duration_seconds=${interval}`,
        );
        return;
      }

      // Verificar confirmação estatística (dígitos)
      if (!this.validateStatisticalConfirmation(prices, analysis.direction)) {
        await this.saveLog(
          state.userId,
          'DEBUG',
          'DECISION',
          `Signal invalidated. reason="Statistical confirmation failed"`,
        );
        const interval = this.getRandomInterval();
        await this.updateNextTradeAt(state.userId, interval);
        await this.saveLog(
          state.userId,
          'DEBUG',
          'HUMANIZER',
          `New random interval set. duration_seconds=${interval}`,
        );
        return;
      }

      // Log de sinal encontrado
      await this.saveLog(
        state.userId,
        'INFO',
        'DECISION',
        `Signal found. direction=${analysis.direction}, confidence=${analysis.confidenceScore.toFixed(1)}%`,
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

      // Executar operação
      await this.executeTrade(state, analysis);
    } catch (error) {
      this.logger.error(`[ProcessAgent][${state.userId}] Erro:`, error);
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

    // Alinhamento de EMAs para RISE
    if (ema10 > ema25 && ema25 > ema50) {
      if (rsi < 70 && momentum > 0) {
        direction = 'RISE';
        confidenceScore = this.calculateConfidenceScore(ema10, ema25, ema50, rsi, momentum, 'RISE');
        reasoning = `EMAs alinhadas para alta (EMA10: ${ema10.toFixed(4)} > EMA25: ${ema25.toFixed(4)} > EMA50: ${ema50.toFixed(4)}), RSI: ${rsi.toFixed(2)}, Momentum: ${momentum.toFixed(4)}`;
      }
    }
    // Alinhamento de EMAs para FALL
    else if (ema10 < ema25 && ema25 < ema50) {
      if (rsi > 30 && momentum < 0) {
        direction = 'FALL';
        confidenceScore = this.calculateConfidenceScore(ema10, ema25, ema50, rsi, momentum, 'FALL');
        reasoning = `EMAs alinhadas para baixa (EMA10: ${ema10.toFixed(4)} < EMA25: ${ema25.toFixed(4)} < EMA50: ${ema50.toFixed(4)}), RSI: ${rsi.toFixed(2)}, Momentum: ${momentum.toFixed(4)}`;
      }
    }

    // Log de análise técnica
    this.saveLog(
      userId,
      'DEBUG',
      'ANALYZER',
      `Technical analysis complete. ema_fast=${ema10.toFixed(2)}, ema_slow=${ema50.toFixed(2)}, rsi=${rsi.toFixed(1)}`,
      { ema10, ema25, ema50, rsi, momentum },
    ).catch(() => {}); // Não bloquear se houver erro

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

  private validateStatisticalConfirmation(prices: PriceTick[], direction: ContractType | null): boolean {
    if (!direction) {
      return false;
    }

    // Extrair últimos 20 dígitos
    const last20 = prices.slice(-20);
    const digits = last20.map(p => {
      const str = Math.abs(p.value).toString().replace('.', '');
      return parseInt(str.charAt(str.length - 1), 10);
    });

    // Para RISE: verificar se >60% dos dígitos são altos (5-9)
    if (direction === 'RISE') {
      const highDigits = digits.filter(d => d >= 5).length;
      const highPercent = highDigits / 20;
      if (highPercent <= 0.6) {
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
      if (consecutiveLow >= 4) {
        return false;
      }
    }
    // Para FALL: verificar se >60% dos dígitos são baixos (0-4)
    else if (direction === 'FALL') {
      const lowDigits = digits.filter(d => d < 5).length;
      const lowPercent = lowDigits / 20;
      if (lowPercent <= 0.6) {
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
      if (consecutiveHigh >= 4) {
        return false;
      }
    }

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
      // Determinar tipo de contrato e stake baseado no nível de Martingale
      let contractType: string;
      let stakeAmount: number;
      let payout: number;

      if (state.martingaleLevel === 'M0') {
        // Operação normal: Rise/Fall
        contractType = analysis.direction;
        stakeAmount = state.initialStake;
        payout = SENTINEL_CONFIG.payoutRiseFall;
      } else {
        // Recuperação M1: Higher/Lower
        contractType = analysis.direction === 'RISE' ? 'HIGHER' : 'LOWER';
        stakeAmount = state.initialStake; // Mesmo valor!
        payout = SENTINEL_CONFIG.payoutHigherLower;
      }

      // Duração dinâmica (5-10 ticks)
      const duration = Math.floor(
        Math.random() * (SENTINEL_CONFIG.contractDurationMax - SENTINEL_CONFIG.contractDurationMin + 1) +
          SENTINEL_CONFIG.contractDurationMin,
      );

      // Log de proposta enviada
      await this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Proposal sent. direction=${contractType}, stake=${stakeAmount.toFixed(2)}, duration=${duration}t`,
        {
          direction: contractType,
          stake: stakeAmount,
          duration,
          martingaleLevel: state.martingaleLevel,
        },
      );

      // Criar registro no banco
      const tradeId = await this.createTradeRecord(state, {
        contractType: contractType as ContractType,
        stakeAmount,
        duration,
        analysis,
        payout,
      });

      // Executar na Deriv
      const result = await this.executeTradeOnDeriv({
        tradeId,
        state,
        contractType: contractType as ContractType,
        stakeAmount,
        duration,
      });

      // Log de compra executada
      if (result.contractId) {
        await this.saveLog(
          state.userId,
          'INFO',
          'TRADER',
          `Buy order executed. contract_id=${result.contractId}`,
          { contractId: result.contractId },
        );
      }

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

    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);

      let proposalId: string | null = null;
      let proposalPrice: number | null = null;
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
        this.saveLog(state.userId, 'INFO', 'API', 'WebSocket connection established.').catch(() => {});
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            await this.dataSource.query(
              'UPDATE autonomous_agent_trades SET status = ?, error_message = ? WHERE id = ?',
              ['ERROR', msg.error.message || 'Erro da Deriv', tradeId],
            );
            finalize(new Error(msg.error.message || 'Erro da Deriv'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            this.saveLog(
              state.userId,
              'INFO',
              'API',
              `Authorization successful. account=${msg.authorize?.loginid || 'N/A'}`,
            ).catch(() => {});
            
            const proposalPayload = {
              proposal: 1,
              amount: stakeAmount,
              basis: 'stake',
              contract_type: contractType,
              currency: state.currency,
              duration,
              duration_unit: 't',
              symbol: state.symbol,
            };

            this.logger.log(`[ExecuteTrade] Enviando proposal`, proposalPayload);
            ws.send(JSON.stringify(proposalPayload));
            return;
          }

          if (msg.msg_type === 'proposal') {
            const proposal = msg.proposal;
            if (!proposal || !proposal.id) {
              finalize(new Error('Proposta inválida'));
              return;
            }

            proposalId = proposal.id;
            proposalPrice = Number(proposal.ask_price);
            const payout = Number(proposal.payout || 0);

            // Atualizar entry_price
            const currentPrice = Number(proposal.spot || 0);
            await this.dataSource.query(
              'UPDATE autonomous_agent_trades SET entry_price = ?, payout = ? WHERE id = ?',
              [currentPrice, payout - stakeAmount, tradeId],
            );

            ws.send(
              JSON.stringify({
                buy: proposalId,
                price: proposalPrice,
              }),
            );
            return;
          }

          if (msg.msg_type === 'buy') {
            const buy = msg.buy;
            if (!buy || !buy.contract_id) {
              finalize(new Error('Compra não confirmada'));
              return;
            }

            contractId = buy.contract_id;
            const buyPrice = Number(buy.buy_price);
            const entrySpot = Number(buy.entry_spot || 0);

            await this.dataSource.query(
              `UPDATE autonomous_agent_trades 
               SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
               WHERE id = ?`,
              [contractId, entrySpot, tradeId],
            );

            ws.send(
              JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1,
              }),
            );
            return;
          }

          if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            if (!contract || contract.is_sold !== 1) {
              return;
            }

            const profit = Number(contract.profit || 0);
            const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
            const status = profit >= 0 ? 'WON' : 'LOST';

            // Log de resultado da operação
            this.saveLog(
              state.userId,
              status === 'WON' ? 'INFO' : 'ERROR',
              'TRADER',
              `Trade finished. result=${status}, ${status === 'WON' ? 'profit' : 'loss'}=${Math.abs(profit).toFixed(2)}, contract_id=${contractId}`,
              {
                result: status,
                profit,
                contractId,
                exitPrice,
              },
            ).catch(() => {});

            await this.dataSource.query(
              `UPDATE autonomous_agent_trades
               SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
               WHERE id = ?`,
              [exitPrice, profit, status, tradeId],
            );

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

  private async handleTradeResult(
    state: AutonomousAgentState,
    tradeId: number,
    result: TradeResult,
    stakeAmount: number,
  ): Promise<void> {
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
      // Vitória: resetar Martingale
      state.martingaleLevel = 'M0';
      state.lastLossAmount = 0;
      state.dailyProfit += result.profitLoss;
      state.isOperationActive = false;

      await this.dataSource.query(
        `UPDATE autonomous_agent_config SET
          martingale_level = 'M0',
          last_loss_amount = 0
         WHERE user_id = ?`,
        [state.userId],
      );

      // Log de reset do Martingale
      await this.saveLog(
        state.userId,
        'INFO',
        'RISK',
        `Martingale reset to M0. reason=TradeWin`,
        { previousLevel: 'M1', newLevel: 'M0' },
      );

      this.logger.log(
        `[HandleTradeResult][${state.userId}] ✅ VITÓRIA! Lucro: $${result.profitLoss.toFixed(2)}`,
      );
    } else {
      // Perda: ativar Martingale Inteligente M1
      state.lastLossAmount = stakeAmount;
      state.dailyLoss += Math.abs(result.profitLoss);
      state.isOperationActive = false;

      // Verificar se análise técnica é > 85% favorável para M1
      const prices = await this.getPriceHistory(state.userId, state.symbol);
      if (prices.length >= 50) {
        const analysis = this.performTechnicalAnalysis(prices, state.userId);
        if (analysis.confidenceScore > 85) {
          state.martingaleLevel = 'M1';
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET
              martingale_level = 'M1',
              last_loss_amount = ?
             WHERE user_id = ?`,
            [stakeAmount, state.userId],
          );

          // Log de ativação do Martingale
          await this.saveLog(
            state.userId,
            'WARN',
            'RISK',
            `Martingale activated. level=M1, new_stake=${stakeAmount.toFixed(2)}`,
            { level: 'M1', stake: stakeAmount, confidence: analysis.confidenceScore },
          );

          this.logger.log(
            `[HandleTradeResult][${state.userId}] ❌ PERDA. Ativando M1 (Higher/Lower) para recuperação`,
          );
        } else {
          // Resetar para M0 se análise não for favorável
          state.martingaleLevel = 'M0';
          state.lastLossAmount = 0;
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET
              martingale_level = 'M0',
              last_loss_amount = 0
             WHERE user_id = ?`,
            [state.userId],
          );

          this.logger.log(
            `[HandleTradeResult][${state.userId}] ❌ PERDA. Análise insuficiente para M1, resetando para M0`,
          );
        }
      }
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
      `Random pause activated. duration_minutes=${pauseMinutes}`,
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
      `STOP WIN HIT. daily_profit=${dailyProfit.toFixed(2)}, target=${target.toFixed(2)}. Halting trades for the day.`,
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
      `STOP LOSS HIT. daily_profit=${(-dailyLoss).toFixed(2)}, target=${(-limit).toFixed(2)}. Halting trades for the day.`,
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
        return prices;
      }
    } catch (error) {
      this.logger.error(`[GetPriceHistory] Erro ao buscar histórico:`, error);
    }

    // Retornar array vazio se não houver dados
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
        this.saveLog(userId, 'INFO', 'API', 'WebSocket connection opened.').catch(() => {});
        
        // Autorizar
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            this.logger.error(`[WebSocket][${userId}] ❌ Erro:`, msg.error);
            this.saveLog(userId, 'ERROR', 'API', `WebSocket error. error=${msg.error.message || 'Unknown error'}`).catch(() => {});
            
            // Tentar reconectar após delay
            setTimeout(() => {
              this.establishWebSocketConnection(userId);
            }, 5000);
            return;
          }

          if (msg.msg_type === 'authorize') {
            isAuthorized = true;
            this.logger.log(`[WebSocket][${userId}] ✅ Autorizado: ${msg.authorize?.loginid || 'N/A'}`);
            this.saveLog(userId, 'INFO', 'API', `Authorization successful. account=${msg.authorize?.loginid || 'N/A'}`).catch(() => {});
            
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
              this.saveLog(userId, 'INFO', 'API', `Initial price history received. ticks=${ticks.length}`).catch(() => {});
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
        this.saveLog(userId, 'ERROR', 'API', `WebSocket error. error=${error.message || 'Unknown error'}`).catch(() => {});
      });

      ws.on('close', () => {
        this.logger.warn(`[WebSocket][${userId}] 🔌 Conexão WebSocket fechada`);
        this.wsConnections.delete(userId);
        this.saveLog(userId, 'WARN', 'API', 'WebSocket connection closed.').catch(() => {});

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
      this.saveLog(userId, 'ERROR', 'API', `Failed to establish WebSocket. error=${error.message}`).catch(() => {});
      
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

      // Log de reset
      this.logger.log('[ResetDailySessions] ✅ Sessões diárias resetadas');

      // Re-sincronizar estados em memória
      await this.syncActiveAgentsFromDb();

      // Log para cada agente ativo
      const activeAgents = await this.dataSource.query(
        `SELECT user_id FROM autonomous_agent_config WHERE is_active = TRUE`,
      );

      for (const agent of activeAgents) {
        await this.saveLog(
          agent.user_id.toString(),
          'INFO',
          'CORE',
          'Daily session reset. daily_profit=0, daily_loss=0, session_status=active',
        );
      }
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
        total_trades,
        total_wins,
        total_losses,
        daily_profit,
        daily_loss,
        session_status,
        last_trade_at,
        next_trade_at
       FROM autonomous_agent_config
       WHERE user_id = ?`,
      [userId],
    );

    if (!config || config.length === 0) {
      return null;
    }

    const cfg = config[0];
    return {
      isActive: cfg.is_active === 1 || cfg.is_active === true,
      initialStake: parseFloat(cfg.initial_stake),
      dailyProfitTarget: parseFloat(cfg.daily_profit_target),
      dailyLossLimit: parseFloat(cfg.daily_loss_limit),
      symbol: cfg.symbol,
      totalTrades: cfg.total_trades,
      totalWins: cfg.total_wins,
      totalLosses: cfg.total_losses,
      dailyProfit: parseFloat(cfg.daily_profit) || 0,
      dailyLoss: parseFloat(cfg.daily_loss) || 0,
      sessionStatus: cfg.session_status,
      lastTradeAt: cfg.last_trade_at,
      nextTradeAt: cfg.next_trade_at,
    };
  }

  async getTradeHistory(userId: string, limit: number = 50): Promise<any[]> {
    const trades = await this.dataSource.query(
      `SELECT 
        id, contract_type, contract_duration, entry_price, exit_price,
        stake_amount, profit_loss, status, confidence_score, martingale_level,
        payout, created_at, started_at, closed_at
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
      createdAt: trade.created_at,
      startedAt: trade.started_at,
      closedAt: trade.closed_at,
    }));
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

      // Salvar no banco de dados
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

  async getLogs(userId: string, limit: number = 100): Promise<any[]> {
    try {
      const logs = await this.dataSource.query(
        `SELECT id, timestamp, log_level, module, message, metadata
         FROM autonomous_agent_logs
         WHERE user_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
        [userId, limit],
      );

      return logs.map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        level: log.log_level,
        module: log.module,
        message: log.message,
        metadata: log.metadata ? JSON.parse(log.metadata) : null,
      }));
    } catch (error) {
      this.logger.error(`[GetLogs][${userId}] Erro:`, error);
      return [];
    }
  }
}

