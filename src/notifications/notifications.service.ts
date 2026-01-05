import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface AgentSummary {
  isActive: boolean;
  sessionStatus: string | null; // 'active', 'stopped_profit', 'stopped_loss', 'stopped_blindado', null
  dailyProfit: number;
  dailyLoss: number;
  netResult: number; // dailyProfit - dailyLoss
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  profitTarget: number | null;
  lossLimit: number | null;
  lastTradeAt: Date | null;
}

export interface AISummary {
  isActive: boolean;
  sessionStatus: string | null; // 'active', 'stopped_profit', 'stopped_loss', 'stopped_blindado', null
  sessionBalance: number;
  profitTarget: number | null;
  lossLimit: number | null;
  mode: string | null;
  strategy: string | null;
  lastTradeAt: Date | null;
}

export interface LoginNotificationSummary {
  agent: AgentSummary | null;
  ai: AISummary | null;
  hasNotifications: boolean;
  notifications: Array<{
    type: 'success' | 'warning' | 'error' | 'info';
    title: string;
    message: string;
    source: 'agent' | 'ai';
    timestamp: Date;
  }>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Busca resumo de notificações ao fazer login
   * Verifica status do agente autônomo e da IA
   */
  async getLoginSummary(userId: string): Promise<LoginNotificationSummary> {
    this.logger.log(`[Notifications] Buscando resumo de login para usuário ${userId}`);

    const [agentSummary, aiSummary] = await Promise.all([
      this.getAgentSummary(userId),
      this.getAISummary(userId),
    ]);

    const notifications = this.buildNotifications(agentSummary, aiSummary);

    const summary: LoginNotificationSummary = {
      agent: agentSummary,
      ai: aiSummary,
      hasNotifications: notifications.length > 0,
      notifications,
    };

    // Log detalhado no terminal
    this.logSummaryToTerminal(userId, summary);

    return summary;
  }

  /**
   * Busca resumo do Agente Autônomo
   */
  private async getAgentSummary(userId: string): Promise<AgentSummary | null> {
    try {
      const result = await this.dataSource.query(
        `SELECT 
          is_active,
          session_status,
          COALESCE(daily_profit, 0) as daily_profit,
          COALESCE(daily_loss, 0) as daily_loss,
          COALESCE(total_trades, 0) as total_trades,
          COALESCE(total_wins, 0) as total_wins,
          COALESCE(total_losses, 0) as total_losses,
          daily_profit_target,
          daily_loss_limit,
          last_trade_at
         FROM autonomous_agent_config
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [userId],
      );

      if (!result || result.length === 0) {
        return null;
      }

      const config = result[0];
      const dailyProfit = parseFloat(config.daily_profit) || 0;
      const dailyLoss = parseFloat(config.daily_loss) || 0;

      return {
        isActive: config.is_active === 1 || config.is_active === true,
        sessionStatus: config.session_status || null,
        dailyProfit,
        dailyLoss,
        netResult: dailyProfit - dailyLoss,
        totalTrades: parseInt(config.total_trades) || 0,
        totalWins: parseInt(config.total_wins) || 0,
        totalLosses: parseInt(config.total_losses) || 0,
        profitTarget: config.daily_profit_target ? parseFloat(config.daily_profit_target) : null,
        lossLimit: config.daily_loss_limit ? parseFloat(config.daily_loss_limit) : null,
        lastTradeAt: config.last_trade_at || null,
      };
    } catch (error) {
      this.logger.error(`[Notifications] Erro ao buscar resumo do agente: ${error.message}`);
      return null;
    }
  }

  /**
   * Busca resumo da IA de Trading
   * Prioriza configurações ativas sobre inativas
   */
  private async getAISummary(userId: string): Promise<AISummary | null> {
    try {
      // Primeiro tenta buscar uma configuração ATIVA
      let result = await this.dataSource.query(
        `SELECT 
          is_active,
          session_status,
          COALESCE(session_balance, 0) as session_balance,
          COALESCE(stake_amount, 0) as stake_amount,
          profit_target,
          loss_limit,
          mode,
          strategy,
          last_trade_at,
          created_at
         FROM ai_user_config
         WHERE user_id = ? AND is_active = 1
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId],
      );

      // Se não encontrou ativa, busca a mais recente (inativa)
      if (!result || result.length === 0) {
        result = await this.dataSource.query(
          `SELECT 
            is_active,
            session_status,
            COALESCE(session_balance, 0) as session_balance,
            COALESCE(stake_amount, 0) as stake_amount,
            profit_target,
            loss_limit,
            mode,
            strategy,
            last_trade_at,
            created_at
           FROM ai_user_config
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId],
        );
      }

      if (!result || result.length === 0) {
        return null;
      }

      const config = result[0];
      const capitalInicial = parseFloat(config.stake_amount) || 0;

      // ✅ Calcular lucro/perda da sessão: sessionBalance atual - capital inicial
      // O session_balance no banco armazena o LUCRO/PERDA da sessão (não o saldo total)
      // Conforme atualizado em orion.strategy.ts linha 2887-2892
      let sessionBalance = parseFloat(config.session_balance) || 0;
      let lucroDaSessao = sessionBalance; // ✅ session_balance já é o lucro/perda da sessão
      
      // ✅ Sempre buscar o lucro real dos trades da sessão atual (mais preciso)
      // Isso funciona tanto para sessões ativas quanto paradas
      if (config.created_at) {
        // Buscar o lucro/perda real da sessão atual baseado nos trades
        const tradesResult = await this.dataSource.query(
          `SELECT 
            COALESCE(SUM(profit_loss), 0) as total_profit_loss
           FROM ai_trades
           WHERE user_id = ?
             AND created_at >= ?
             AND status IN ('WON', 'LOST')`,
          [userId, config.created_at],
        );
        
        if (tradesResult && tradesResult.length > 0) {
          const lucroDosTrades = parseFloat(tradesResult[0].total_profit_loss) || 0;
          // ✅ Usar o lucro dos trades (é mais preciso e confiável)
          // session_balance pode estar desatualizado ou incorreto
          lucroDaSessao = lucroDosTrades;
        }
      }

      return {
        isActive: config.is_active === 1 || config.is_active === true,
        sessionStatus: config.session_status || null,
        sessionBalance: lucroDaSessao, // ✅ Retornar lucro/perda da sessão, não o saldo total
        profitTarget: config.profit_target ? parseFloat(config.profit_target) : null,
        lossLimit: config.loss_limit ? parseFloat(config.loss_limit) : null,
        mode: config.mode || null,
        strategy: config.strategy || null,
        lastTradeAt: config.last_trade_at || null,
      };
    } catch (error) {
      this.logger.error(`[Notifications] Erro ao buscar resumo da IA: ${error.message}`);
      return null;
    }
  }

  /**
   * Constrói lista de notificações baseada nos resumos
   */
  private buildNotifications(
    agent: AgentSummary | null,
    ai: AISummary | null,
  ): LoginNotificationSummary['notifications'] {
    const notifications: LoginNotificationSummary['notifications'] = [];
    const now = new Date();

    // Notificações do Agente Autônomo
    if (agent) {
      if (agent.isActive) {
        notifications.push({
          type: 'info',
          title: '🤖 Agente Autônomo Ativo',
          message: `O agente está rodando. Resultado atual: ${agent.netResult >= 0 ? '+' : ''}$${agent.netResult.toFixed(2)}`,
          source: 'agent',
          timestamp: now,
        });
      } else if (agent.sessionStatus === 'stopped_profit') {
        notifications.push({
          type: 'success',
          title: '🎉 Agente Autônomo - Meta Atingida!',
          message: `O agente parou por atingir a meta diária. Lucro: +$${agent.dailyProfit.toFixed(2)}`,
          source: 'agent',
          timestamp: now,
        });
      } else if (agent.sessionStatus === 'stopped_loss') {
        notifications.push({
          type: 'warning',
          title: '⚠️ Agente Autônomo - Stop Loss',
          message: `O agente parou por atingir o stop loss. Perda: -$${agent.dailyLoss.toFixed(2)}`,
          source: 'agent',
          timestamp: now,
        });
      } else if (agent.sessionStatus === 'stopped_blindado') {
        notifications.push({
          type: 'warning',
          title: '🛡️ Agente Autônomo - Stop Blindado',
          message: `O agente parou pelo stop blindado. Resultado: ${agent.netResult >= 0 ? '+' : ''}$${agent.netResult.toFixed(2)}`,
          source: 'agent',
          timestamp: now,
        });
      } else if (agent.totalTrades > 0) {
        // Tem histórico mas não está ativo
        notifications.push({
          type: 'info',
          title: '🤖 Agente Autônomo Parado',
          message: `Último resultado: ${agent.netResult >= 0 ? '+' : ''}$${agent.netResult.toFixed(2)} (${agent.totalWins}V/${agent.totalLosses}D)`,
          source: 'agent',
          timestamp: now,
        });
      }
    }

    // Notificações da IA de Trading
    if (ai) {
      if (ai.isActive) {
        const strategyName = 'Orion';
        notifications.push({
          type: 'info',
          title: `🧠 IA ${strategyName} Ativa`,
          message: `A IA está rodando no modo ${ai.mode?.toUpperCase() || 'N/A'}. Saldo da sessão: ${ai.sessionBalance >= 0 ? '+' : ''}$${ai.sessionBalance.toFixed(2)}`,
          source: 'ai',
          timestamp: now,
        });
      } else if (ai.sessionStatus === 'stopped_profit') {
        notifications.push({
          type: 'success',
          title: '🎉 IA de Trading - Meta Atingida!',
          message: `A IA parou por atingir a meta. Lucro da sessão: +$${ai.sessionBalance.toFixed(2)}`,
          source: 'ai',
          timestamp: now,
        });
      } else if (ai.sessionStatus === 'stopped_loss') {
        notifications.push({
          type: 'warning',
          title: '⚠️ IA de Trading - Stop Loss',
          message: `A IA parou por atingir o stop loss. Resultado: $${ai.sessionBalance.toFixed(2)}`,
          source: 'ai',
          timestamp: now,
        });
      } else if (ai.sessionStatus === 'stopped_blindado') {
        notifications.push({
          type: 'warning',
          title: '🛡️ IA de Trading - Stop Blindado',
          message: `A IA parou pelo stop blindado. Resultado: ${ai.sessionBalance >= 0 ? '+' : ''}$${ai.sessionBalance.toFixed(2)}`,
          source: 'ai',
          timestamp: now,
        });
      } else if (ai.sessionBalance !== 0) {
        // Tem histórico mas não está ativa
        const strategyName = 'Orion';
        notifications.push({
          type: 'info',
          title: `🧠 IA ${strategyName} Parada`,
          message: `Último resultado da sessão: ${ai.sessionBalance >= 0 ? '+' : ''}$${ai.sessionBalance.toFixed(2)}`,
          source: 'ai',
          timestamp: now,
        });
      }
    }

    return notifications;
  }

  /**
   * Loga o resumo no terminal de forma formatada
   */
  private logSummaryToTerminal(userId: string, summary: LoginNotificationSummary): void {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║           📬 RESUMO DE NOTIFICAÇÕES AO LOGAR                     ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log(`║  Usuário: ${userId.substring(0, 30).padEnd(30)}                    ║`);
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    
    // Agente Autônomo
    console.log('║  🤖 AGENTE AUTÔNOMO:                                              ║');
    if (summary.agent) {
      const statusIcon = summary.agent.isActive ? '🟢' : '🔴';
      const statusText = summary.agent.isActive ? 'RODANDO' : 
                         summary.agent.sessionStatus === 'stopped_profit' ? 'PAROU (META)' :
                         summary.agent.sessionStatus === 'stopped_loss' ? 'PAROU (STOP LOSS)' :
                         summary.agent.sessionStatus === 'stopped_blindado' ? 'PAROU (BLINDADO)' : 'PARADO';
      const resultIcon = summary.agent.netResult >= 0 ? '📈' : '📉';
      const resultColor = summary.agent.netResult >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      
      console.log(`║     Status: ${statusIcon} ${statusText.padEnd(20)}                          ║`);
      console.log(`║     Resultado: ${resultIcon} ${resultColor}${summary.agent.netResult >= 0 ? '+' : ''}$${summary.agent.netResult.toFixed(2)}${reset}`.padEnd(72) + '║');
      console.log(`║     Trades: ${summary.agent.totalWins}V / ${summary.agent.totalLosses}D (${summary.agent.totalTrades} total)`.padEnd(66) + '║');
    } else {
      console.log('║     Sem configuração encontrada                                    ║');
    }
    
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    
    // IA de Trading
    console.log('║  🧠 IA DE TRADING:                                                 ║');
    if (summary.ai) {
      const statusIcon = summary.ai.isActive ? '🟢' : '🔴';
      const statusText = summary.ai.isActive ? 'RODANDO' : 
                         summary.ai.sessionStatus === 'stopped_profit' ? 'PAROU (META)' :
                         summary.ai.sessionStatus === 'stopped_loss' ? 'PAROU (STOP LOSS)' :
                         summary.ai.sessionStatus === 'stopped_blindado' ? 'PAROU (BLINDADO)' : 'PARADA';
      const resultIcon = summary.ai.sessionBalance >= 0 ? '📈' : '📉';
      const resultColor = summary.ai.sessionBalance >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      const strategyName = summary.ai.strategy === 'trinity' ? 'Trinity' : 'Orion';
      
      console.log(`║     Status: ${statusIcon} ${statusText.padEnd(20)}                          ║`);
      console.log(`║     Estratégia: ${strategyName} (${summary.ai.mode || 'N/A'})`.padEnd(66) + '║');
      console.log(`║     Saldo Sessão: ${resultIcon} ${resultColor}${summary.ai.sessionBalance >= 0 ? '+' : ''}$${summary.ai.sessionBalance.toFixed(2)}${reset}`.padEnd(72) + '║');
    } else {
      console.log('║     Sem configuração encontrada                                    ║');
    }
    
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log(`║  📊 Total de Notificações: ${summary.notifications.length}                                      ║`);
    
    if (summary.notifications.length > 0) {
      console.log('╠══════════════════════════════════════════════════════════════════╣');
      summary.notifications.forEach((notif, idx) => {
        const typeIcon = notif.type === 'success' ? '✅' : 
                        notif.type === 'warning' ? '⚠️' : 
                        notif.type === 'error' ? '❌' : 'ℹ️';
        console.log(`║  ${idx + 1}. ${typeIcon} ${notif.title.substring(0, 50).padEnd(50)}       ║`);
        console.log(`║     ${notif.message.substring(0, 55).padEnd(55)}     ║`);
      });
    }
    
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log('\n');
  }
}

