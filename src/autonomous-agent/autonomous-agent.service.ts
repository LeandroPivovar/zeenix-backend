import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { LogQueueService } from '../utils/log-queue.service';

/**
 * ✅ VERSÃO SIMPLIFICADA: Service do Agente Autônomo
 * Apenas operações de banco de dados - SEM processamento
 * Mantém apenas os endpoints necessários para o frontend
 */
@Injectable()
export class AutonomousAgentService {
  private readonly logger = new Logger(AutonomousAgentService.name);

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private readonly logQueueService?: LogQueueService,
  ) {}

  /**
   * Ativa o agente autônomo (apenas atualiza banco de dados)
   */
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
      agentType?: string;
    },
  ): Promise<void> {
    try {
      const symbol = config.symbol || 'R_75';
      const strategy = config.strategy || 'arion';
      const riskLevel = config.riskLevel || 'balanced';
      const tradingMode = config.tradingMode || 'normal';
      const stopLossType = config.stopLossType || 'normal';
      const initialBalance = config.initialBalance || 0;
      const agentType = config.agentType || 'sentinel';

      // Verificar se já existe configuração
      const existing = await this.dataSource.query(
        `SELECT id FROM autonomous_agent_config WHERE user_id = ?`,
        [userId],
      );

      if (existing && existing.length > 0) {
        // Atualizar existente
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET
            is_active = TRUE,
            initial_stake = ?,
            daily_profit_target = ?,
            daily_loss_limit = ?,
            initial_balance = ?,
            deriv_token = ?,
            currency = ?,
            symbol = ?,
            agent_type = ?,
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
            updated_at = NOW()
          WHERE user_id = ?`,
          [
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            initialBalance,
            config.derivToken,
            config.currency || 'USD',
            symbol,
            agentType,
            strategy,
            riskLevel,
            tradingMode,
            stopLossType,
            userId,
          ],
        );
      } else {
        // Criar novo
        await this.dataSource.query(
          `INSERT INTO autonomous_agent_config (
            user_id, is_active, initial_stake, daily_profit_target, daily_loss_limit,
            initial_balance, deriv_token, currency, symbol, agent_type, strategy,
            risk_level, trading_mode, stop_loss_type, session_date, session_status,
            daily_profit, daily_loss, profit_peak, operations_since_pause,
            martingale_level, martingale_count, soros_level, soros_stake, created_at, updated_at
          ) VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'active', 0, 0, 0, 0, 'M0', 0, 0, 0, NOW(), NOW())`,
          [
            userId,
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            initialBalance,
            config.derivToken,
            config.currency || 'USD',
            symbol,
            agentType,
            strategy,
            riskLevel,
            tradingMode,
            stopLossType,
          ],
        );
      }

      // Salvar log
      if (this.logQueueService) {
        this.logQueueService.saveLogAsync({
          userId,
          level: 'INFO',
          module: 'CORE',
          message: 'Agente autônomo ativado (modo simplificado - sem processamento)',
          tableName: 'autonomous_agent_logs',
        });
      }

      this.logger.log(`[ActivateAgent] ✅ Agente ativado para usuário ${userId} (apenas banco de dados)`);
    } catch (error) {
      this.logger.error(`[ActivateAgent] ❌ Erro ao ativar agente:`, error);
      throw error;
    }
  }

  /**
   * Desativa o agente autônomo (apenas atualiza banco de dados)
   */
  async deactivateAgent(userId: string): Promise<void> {
    try {
      if (!userId) {
        throw new Error('User ID é obrigatório para desativar agente');
      }

      this.logger.log(`[DeactivateAgent] Desativando agente para usuário ${userId}`);

      // Atualizar banco de dados
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET is_active = FALSE, 
             session_status = 'paused', 
             updated_at = NOW() 
         WHERE user_id = ?`,
        [userId],
      );

      // Salvar log
      if (this.logQueueService) {
        this.logQueueService.saveLogAsync({
          userId,
          level: 'INFO',
          module: 'CORE',
          message: 'Agente parado manualmente pelo usuário (modo simplificado)',
          tableName: 'autonomous_agent_logs',
        });
      }

      this.logger.log(`[DeactivateAgent] ✅ Agente desativado para usuário ${userId}`);
    } catch (error) {
      this.logger.error(`[DeactivateAgent] ❌ Erro ao desativar agente:`, error);
      throw error;
    }
  }

  /**
   * Busca configuração do agente
   */
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

    // Processar session_date
    let sessionDate: string | null = null;
    if (cfg.session_date) {
      try {
        if (cfg.session_date instanceof Date) {
          sessionDate = cfg.session_date.toISOString();
        } else if (typeof cfg.session_date === 'string') {
          if (cfg.session_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
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

    // Processar created_at
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
      sessionDate: sessionDate,
      createdAt: createdAt,
      lastTradeAt: cfg.last_trade_at ? (cfg.last_trade_at instanceof Date ? cfg.last_trade_at.toISOString() : cfg.last_trade_at) : null,
      nextTradeAt: cfg.next_trade_at ? (cfg.next_trade_at instanceof Date ? cfg.next_trade_at.toISOString() : cfg.next_trade_at) : null,
    };
  }

  /**
   * Busca histórico de trades
   */
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
   * Busca estatísticas da sessão
   */
  async getSessionStats(userId: string): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    // Buscar estatísticas do agente autônomo
    const stats = await this.dataSource.query(
      `SELECT 
        COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END) as total_trades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) as total_profit,
        SUM(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE 0 END) as total_loss
       FROM autonomous_agent_trades
       WHERE user_id = ? AND DATE(created_at) = ?
       AND status IN ('WON', 'LOST')`,
      [userId, todayStr],
    );

    // Buscar todas as operações do dia
    const allAutonomousTrades = await this.dataSource.query(
      `SELECT COUNT(*) as total_trades
       FROM autonomous_agent_trades
       WHERE user_id = ? AND DATE(created_at) = ? AND status != 'ERROR'`,
      [userId, todayStr],
    );

    // Buscar configuração
    const config = await this.dataSource.query(
      `SELECT initial_stake, initial_balance, daily_profit, daily_loss
       FROM autonomous_agent_config 
       WHERE user_id = ?`,
      [userId],
    );

    const initialBalance = config && config.length > 0 ? parseFloat(config[0].initial_balance) || 0 : 0;
    const dailyProfit = config && config.length > 0 ? parseFloat(config[0].daily_profit) || 0 : 0;
    const dailyLoss = config && config.length > 0 ? parseFloat(config[0].daily_loss) || 0 : 0;
    const totalCapital = initialBalance > 0 ? initialBalance : 0;

    const result = stats && stats.length > 0 ? stats[0] : {};
    const allTradesResult = allAutonomousTrades && allAutonomousTrades.length > 0 ? allAutonomousTrades[0] : {};

    const totalTrades = parseInt(result.total_trades) || 0;
    const wins = parseInt(result.wins) || 0;
    const losses = parseInt(result.losses) || 0;
    const totalProfit = parseFloat(result.total_profit) || 0;
    const totalLoss = parseFloat(result.total_loss) || 0;
    const netProfit = totalProfit - totalLoss;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const totalOperations = parseInt(allTradesResult.total_trades) || 0;

    return {
      totalTrades,
      wins,
      losses,
      winRate: Math.round(winRate * 100) / 100,
      totalProfit,
      totalLoss,
      netProfit,
      totalCapital,
      initialBalance,
      dailyProfit,
      dailyLoss,
      totalOperations,
    };
  }

  /**
   * Busca histórico de preços (retorna vazio - não há processamento)
   */
  async getPriceHistoryForUser(userId: string, limit: number = 100): Promise<any[]> {
    // Retornar array vazio - não há processamento de ticks
    return [];
  }

  /**
   * Busca logs do agente
   */
  async getLogs(userId: string, limit?: number): Promise<any[]> {
    const limitNum = limit || 100;
    const logs = await this.dataSource.query(
      `SELECT id, timestamp, log_level, module, message, metadata
       FROM autonomous_agent_logs
       WHERE user_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      [userId, limitNum],
    );

    return logs.map((log: any) => ({
      id: log.id,
      timestamp: log.timestamp,
      logLevel: log.log_level,
      module: log.module,
      message: log.message,
      metadata: log.metadata ? JSON.parse(log.metadata) : null,
    }));
  }
}

