import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutonomousAgentService } from './autonomous-agent.service';

/**
 * ✅ Scheduler do Agente Autônomo
 *
 * Responsável por:
 * - Verificar e resetar sessões diárias (quando muda o dia)
 * - Sincronizar agentes ativos do banco
 */
@Injectable()
export class AutonomousAgentScheduler {
  private readonly logger = new Logger(AutonomousAgentScheduler.name);

  constructor(private readonly agentService: AutonomousAgentService) {}

  /**
   * Verifica e reseta sessões diárias a cada hora
   * Se um agente parou no dia anterior (stop loss/win/blindado), reseta para o novo dia
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCheckAndResetDailySessions() {
    try {
      this.logger.log('[Scheduler] Verificando e resetando sessões diárias...');
      await this.agentService.checkAndResetDailySessions();
    } catch (error) {
      this.logger.error(
        '[Scheduler] Erro ao verificar e resetar sessões:',
        error,
      );
    }
  }

  /**
   * Sincroniza agentes ativos do banco a cada 5 minutos
   */
  @Cron('*/5 * * * *')
  async handleSyncActiveAgents() {
    try {
      this.logger.debug('[Scheduler] Sincronizando agentes ativos do banco...');
      await this.agentService.syncActiveAgentsFromDb();
    } catch (error) {
      this.logger.error('[Scheduler] Erro ao sincronizar agentes:', error);
    }
  }
}
