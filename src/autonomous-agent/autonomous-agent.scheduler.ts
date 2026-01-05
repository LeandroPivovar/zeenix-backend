import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutonomousAgentService } from './autonomous-agent.service';

@Injectable()
export class AutonomousAgentScheduler {
  private readonly logger = new Logger(AutonomousAgentScheduler.name);
  
  // ✅ OTIMIZAÇÃO: Flag para evitar execuções simultâneas
  private isProcessing = false;
  
  // ✅ PAUSA TEMPORÁRIA: Flag para pausar o processamento do agente autônomo
  // Altere para 'true' para pausar temporariamente o processamento
  // Não precisa de .env, apenas mude este valor e reinicie o servidor
  private readonly IS_PAUSED = false; // ⬅️ MUDE PARA 'true' PARA PAUSAR

  constructor(private readonly agentService: AutonomousAgentService) {
    if (this.IS_PAUSED) {
      this.logger.warn('[AutonomousAgentScheduler] ⚠️ PROCESSAMENTO PAUSADO - Agente autônomo está temporariamente desabilitado');
      this.logger.warn('[AutonomousAgentScheduler] Para reativar, altere IS_PAUSED para false neste arquivo');
    }
  }

  // ✅ REATIVADO
  // Executar a cada 1 minuto para processar agentes ativos (24hrs contínuo, como a IA)
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'process-autonomous-agents',
  })
  async handleProcessAgents() {
    // ✅ PAUSA TEMPORÁRIA: Verificar se o processamento está pausado
    if (this.IS_PAUSED) {
      this.logger.debug('[AutonomousAgentScheduler] ⏸️ Processamento pausado (IS_PAUSED=true)');
      return;
    }
    
    // ✅ OTIMIZAÇÃO: Evitar execuções simultâneas
    if (this.isProcessing) {
      this.logger.debug('[AutonomousAgentScheduler] Processamento já em andamento, pulando...');
      return;
    }

    this.isProcessing = true;
    try {
      this.logger.debug('[AutonomousAgentScheduler] Executando processamento de agentes autônomos');
      await this.agentService.processActiveAgents();
    } catch (error) {
      this.logger.error('[Scheduler] Erro ao processar agentes:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  // ✅ REATIVADO
  // Verificar e resetar sessões diárias à meia-noite
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleResetDailySessions() {
    try {
      this.logger.log('[Scheduler] Resetando sessões diárias');
      await this.agentService.resetDailySessions();
    } catch (error) {
      this.logger.error('[Scheduler] Erro ao resetar sessões:', error);
    }
  }
}

