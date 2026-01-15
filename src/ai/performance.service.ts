import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface WeeklyStats {
  period: {
    start: string;
    end: string;
  };
  sources: {
    ai: number;
    agent: number;
    copy: number;
    manual: number;
  };
  totalProfit: number;
  netResult: number;
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Obtém estatísticas de desempenho da última semana para um usuário
   */
  async getWeeklyStats(userId: string): Promise<WeeklyStats> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    try {
      // 1. IA Statistics (ai_trades)
      const aiStats = await this.dataSource.query(
        `
        SELECT SUM(profit_loss) as total
        FROM ai_trades
        WHERE user_id = ? 
          AND status IN ('WON', 'LOST')
          AND DATE(created_at) BETWEEN ? AND ?
      `,
        [userId, startDateStr, endDateStr],
      );

      // 2. Autonomous Agent Statistics (autonomous_agent_trades)
      const agentStats = await this.dataSource.query(
        `
        SELECT SUM(profit_loss) as total
        FROM autonomous_agent_trades
        WHERE user_id = ?
          AND status IN ('WON', 'LOST')
          AND DATE(created_at) BETWEEN ? AND ?
      `,
        [userId, startDateStr, endDateStr],
      );

      // 3. Copy Trading Statistics (copy_trading_operations)
      const copyStats = await this.dataSource.query(
        `
        SELECT SUM(profit) as total
        FROM copy_trading_operations
        WHERE user_id = ?
          AND result IN ('win', 'loss')
          AND DATE(executed_at) BETWEEN ? AND ?
      `,
        [userId, startDateStr, endDateStr],
      );

      // 4. Manual/Signal Statistics (trades)
      const manualStats = await this.dataSource.query(
        `
        SELECT SUM(profit) as total
        FROM trades
        WHERE user_id = ?
          AND status IN ('won', 'lost')
          AND DATE(created_at) BETWEEN ? AND ?
      `,
        [userId, startDateStr, endDateStr],
      );

      const aiProfit = parseFloat(aiStats[0]?.total) || 0;
      const agentProfit = parseFloat(agentStats[0]?.total) || 0;
      const copyProfit = parseFloat(copyStats[0]?.total) || 0;
      const manualProfit = parseFloat(manualStats[0]?.total) || 0;

      const netResult = aiProfit + agentProfit + copyProfit + manualProfit;

      return {
        period: {
          start: startDate.toLocaleDateString('pt-BR'),
          end: endDate.toLocaleDateString('pt-BR'),
        },
        sources: {
          ai: Number(aiProfit.toFixed(2)),
          agent: Number(agentProfit.toFixed(2)),
          copy: Number(copyProfit.toFixed(2)),
          manual: Number(manualProfit.toFixed(2)),
        },
        totalProfit: Number(netResult.toFixed(2)), // For simplicity, using net as total profit here
        netResult: Number(netResult.toFixed(2)),
      };
    } catch (error) {
      this.logger.error(
        `Erro ao buscar estatísticas semanais para usuário ${userId}:`,
        error,
      );
      throw error;
    }
  }
}
