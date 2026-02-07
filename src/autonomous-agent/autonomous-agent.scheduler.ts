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

  constructor(
    private readonly agentService: AutonomousAgentService,
  ) { }

  /**
   * Verifica e reseta sessões diárias a cada hora (Segurança)
   * Se um agente parou no dia anterior (stop loss/win/blindado), reseta para o novo dia
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCheckAndResetDailySessions() {
    try {
      this.logger.log('[Scheduler] Verificando e resetando sessões diárias (Hourly Check)...');
      await this.agentService.checkAndResetDailySessions();
    } catch (error) {
      this.logger.error('[Scheduler] Erro ao verificar e resetar sessões:', error);
    }
  }

  /**
   * Reset Diário Oficial à Meia-Noite
   * Garante que todos os agentes que bateram meta/stop ontem voltem a operar hoje
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleResetDailySessionsAtMidnight() {
    try {
      this.logger.log('[Scheduler] Executando RESET DIÁRIO DE MEIA-NOITE...');
      await this.agentService.checkAndResetDailySessions();
    } catch (error) {
      this.logger.error('[Scheduler] Erro no reset de meia-noite:', error);
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

