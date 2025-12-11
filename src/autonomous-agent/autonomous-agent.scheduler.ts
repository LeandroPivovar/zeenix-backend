import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutonomousAgentService } from './autonomous-agent.service';

@Injectable()
export class AutonomousAgentScheduler {
  private readonly logger = new Logger(AutonomousAgentScheduler.name);

  constructor(private readonly agentService: AutonomousAgentService) {}

  // Executar a cada 30 segundos para processar agentes ativos
  @Cron('*/30 * * * * *')
  async handleProcessAgents() {
    try {
      await this.agentService.processActiveAgents();
    } catch (error) {
      this.logger.error('[Scheduler] Erro ao processar agentes:', error);
    }
  }

  // Verificar e resetar sessões diárias à meia-noite
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleResetDailySessions() {
    try {
      this.logger.log('[Scheduler] Resetando sessões diárias');
      // TODO: Implementar reset de sessões diárias
      // Resetar daily_profit, daily_loss, session_status para 'active'
    } catch (error) {
      this.logger.error('[Scheduler] Erro ao resetar sessões:', error);
    }
  }
}

