import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutonomousAgentService } from './autonomous-agent.service';

@Injectable()
export class AutonomousAgentScheduler {
  private readonly logger = new Logger(AutonomousAgentScheduler.name);

  constructor(private readonly agentService: AutonomousAgentService) {}

  // ✅ DESATIVADO TEMPORARIAMENTE
  // Executar a cada 1 minuto para processar agentes ativos (24hrs contínuo, como a IA)
  // @Cron(CronExpression.EVERY_MINUTE, {
  //   name: 'process-autonomous-agents',
  // })
  // async handleProcessAgents() {
  //   try {
  //     this.logger.debug('[AutonomousAgentScheduler] Executando processamento de agentes autônomos');
  //     await this.agentService.processActiveAgents();
  //   } catch (error) {
  //     this.logger.error('[Scheduler] Erro ao processar agentes:', error);
  //   }
  // }

  // ✅ DESATIVADO TEMPORARIAMENTE
  // Verificar e resetar sessões diárias à meia-noite
  // @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  // async handleResetDailySessions() {
  //   try {
  //     this.logger.log('[Scheduler] Resetando sessões diárias');
  //     await this.agentService.resetDailySessions();
  //   } catch (error) {
  //     this.logger.error('[Scheduler] Erro ao resetar sessões:', error);
  //   }
  // }
}

