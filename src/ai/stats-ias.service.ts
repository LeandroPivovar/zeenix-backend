import { Injectable, Logger } from '@nestjs/common';

export interface StatsIAsData {
  totalUsers?: number;
  activeUsers?: number;
  totalTrades?: number;
  totalWins?: number;
  totalLosses?: number;
  winRate?: number;
  totalProfit?: number;
  averageProfit?: number;
  topPerformers?: Array<{
    userId: number;
    profit: number;
    winRate: number;
  }>;
  timestamp?: string;
}

@Injectable()
export class StatsIAsService {
  private readonly logger = new Logger(StatsIAsService.name);
  private readonly STATS_API_URL = 'https://iazenix.com/StatsIAs';
  private cache: StatsIAsData | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 60000; // 1 minuto

  /**
   * Obtém estatísticas reais agregadas da tabela ai_sessions (ZENIX v2.0)
   */
  async getAiSessionsStats(dataSource: any, filters: { startDate?: string; endDate?: string; accountType?: string }) {
    try {
      let query = `
        SELECT 
          ai_name as name,
          COUNT(*) as totalSessions,
          SUM(total_trades) as totalTrades,
          SUM(total_wins) as wins,
          SUM(total_losses) as losses,
          SUM(total_profit) as profit
        FROM ai_sessions
        WHERE 1=1
      `;

      const queryParams: any[] = [];

      if (filters.startDate) {
        query += ` AND start_time >= ?`;
        queryParams.push(`${filters.startDate} 00:00:00`);
      }

      if (filters.endDate) {
        query += ` AND start_time <= ?`;
        queryParams.push(`${filters.endDate} 23:59:59`);
      }

      if (filters.accountType && filters.accountType !== 'all') {
        query += ` AND account_type = ?`;
        queryParams.push(filters.accountType);
      }

      query += ` GROUP BY ai_name ORDER BY profit DESC`;

      const botsStats = await dataSource.query(query, queryParams);

      // Calcular agregados globais
      let totalTrades = 0;
      let totalWins = 0;
      let totalLosses = 0;
      let totalProfit = 0;
      let activeBotsSet = new Set();

      const processedStats = botsStats.map((bot: any) => {
        const trades = parseInt(bot.totalTrades) || 0;
        const wins = parseInt(bot.wins) || 0;
        const profit = parseFloat(bot.profit) || 0;

        totalTrades += trades;
        totalWins += wins;
        totalLosses += (parseInt(bot.losses) || 0);
        totalProfit += profit;
        activeBotsSet.add(bot.name);

        return {
          ...bot,
          totalTrades: trades,
          wins: wins,
          losses: parseInt(bot.losses) || 0,
          profit: profit,
          winRate: trades > 0 ? Number(((wins / trades) * 100).toFixed(2)) : 0,
          status: 'active' // Simplified status
        };
      });

      const globalAccuracy = totalTrades > 0
        ? Number(((totalWins / totalTrades) * 100).toFixed(2))
        : 0;

      return {
        bots: processedStats,
        summary: {
          totalActiveIAs: activeBotsSet.size,
          combinedProfit: totalProfit,
          globalAccuracy: globalAccuracy,
          topProfitIA: processedStats.length > 0 ? processedStats[0].name : 'N/A',
          totalTrades,
          totalWins,
          totalLosses
        }
      };
    } catch (error) {
      this.logger.error('Erro ao buscar estatísticas de sessões de IA:', error);
      throw error;
    }
  }

  /**
   * Busca estatísticas da API do StatsIAs
   */
  async fetchStats(): Promise<StatsIAsData | null> {
    try {
      // Verificar cache primeiro
      const now = Date.now();
      if (this.cache && (now - this.cacheTimestamp) < this.CACHE_TTL) {
        this.logger.debug('Retornando estatísticas do cache');
        return this.cache;
      }

      this.logger.log('Buscando estatísticas da API StatsIAs...');

      const response = await fetch(this.STATS_API_URL, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Erro ao buscar StatsIAs: ${response.status} ${response.statusText}`,
        );
        return this.cache; // Retorna cache se disponível
      }

      const data = await response.json();

      // Processar e normalizar os dados
      const stats: StatsIAsData = this.normalizeStatsData(data);

      // Atualizar cache
      this.cache = stats;
      this.cacheTimestamp = now;

      this.logger.log('Estatísticas do StatsIAs atualizadas com sucesso');
      return stats;
    } catch (error) {
      this.logger.error('Erro ao buscar estatísticas do StatsIAs:', error);
      // Retorna cache se disponível mesmo em caso de erro
      return this.cache;
    }
  }

  /**
   * Normaliza os dados recebidos da API para o formato esperado
   */
  private normalizeStatsData(data: any): StatsIAsData {
    // Se a API retornar dados em formato diferente, ajustar aqui
    return {
      totalUsers: data.totalUsers || data.total_users || 0,
      activeUsers: data.activeUsers || data.active_users || 0,
      totalTrades: data.totalTrades || data.total_trades || 0,
      totalWins: data.totalWins || data.total_wins || 0,
      totalLosses: data.totalLosses || data.total_losses || 0,
      winRate: data.winRate || data.win_rate || this.calculateWinRate(data),
      totalProfit: data.totalProfit || data.total_profit || 0,
      averageProfit: data.averageProfit || data.average_profit || 0,
      topPerformers: data.topPerformers || data.top_performers || [],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Calcula win rate se não estiver disponível
   */
  private calculateWinRate(data: any): number {
    const wins = data.totalWins || data.total_wins || 0;
    const losses = data.totalLosses || data.total_losses || 0;
    const total = wins + losses;

    if (total === 0) return 0;
    return Number(((wins / total) * 100).toFixed(2));
  }

  /**
   * Busca estatísticas específicas de um usuário (se a API suportar)
   */
  async fetchUserStats(userId: number): Promise<any | null> {
    try {
      const response = await fetch(`${this.STATS_API_URL}/user/${userId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Erro ao buscar stats do usuário ${userId}: ${response.status}`,
        );
        return null;
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`Erro ao buscar stats do usuário ${userId}:`, error);
      return null;
    }
  }

  /**
   * Obtém estatísticas agregadas de todos os usuários do sistema local
   * (como fallback se a API externa não estiver disponível)
   */
  async getLocalAggregatedStats(dataSource: any): Promise<StatsIAsData> {
    try {
      const stats = await dataSource.query(`
        SELECT 
          COUNT(DISTINCT user_id) as totalUsers,
          SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as activeUsers,
          SUM(total_trades) as totalTrades,
          SUM(total_wins) as totalWins,
          SUM(total_losses) as totalLosses
        FROM ai_user_config
      `);

      const result = stats[0] || {};
      const totalTrades = parseInt(result.totalTrades) || 0;
      const totalWins = parseInt(result.totalWins) || 0;
      const totalLosses = parseInt(result.totalLosses) || 0;
      const winRate = totalTrades > 0
        ? Number(((totalWins / totalTrades) * 100).toFixed(2))
        : 0;

      // Buscar lucro total das trades
      const profitStats = await dataSource.query(`
        SELECT 
          SUM(profit_loss) as totalProfit,
          AVG(profit_loss) as averageProfit
        FROM ai_trades
        WHERE status IN ('WON', 'LOST')
          AND profit_loss IS NOT NULL
      `);

      const profit = profitStats[0] || {};
      const totalProfit = parseFloat(profit.totalProfit) || 0;
      const averageProfit = parseFloat(profit.averageProfit) || 0;

      return {
        totalUsers: parseInt(result.totalUsers) || 0,
        activeUsers: parseInt(result.activeUsers) || 0,
        totalTrades,
        totalWins,
        totalLosses,
        winRate,
        totalProfit,
        averageProfit,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Erro ao buscar estatísticas locais:', error);
      return {
        totalUsers: 0,
        activeUsers: 0,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        winRate: 0,
        totalProfit: 0,
        averageProfit: 0,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Limpa o cache (útil para testes ou atualizações forçadas)
   */
  clearCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
    this.logger.debug('Cache de estatísticas limpo');
  }
}

