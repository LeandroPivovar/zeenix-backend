import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiService } from './ai.service';

@Injectable()
export class AiScheduler {
  private readonly logger = new Logger(AiScheduler.name);
  
  // ✅ OTIMIZAÇÃO: Flags para evitar execuções simultâneas
  private isProcessingBackground = false;
  private isProcessingFastMode = false;

  constructor(private readonly aiService: AiService) {}

  /**
   * Executa a cada 1 minuto para modos normais
   * Processa IAs em background para todos os usuários com IA ativa
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'process-background-ais',
  })
  async handleBackgroundAIs() {
    // ✅ OTIMIZAÇÃO: Evitar execuções simultâneas
    if (this.isProcessingBackground) {
      this.logger.debug('[Scheduler] Processamento de background já em andamento, pulando...');
      return;
    }

    this.isProcessingBackground = true;
    this.logger.debug('Executando scheduler de IAs em background');

    try {
      await this.aiService.processBackgroundAIs();
    } catch (error) {
      this.logger.error('Erro ao processar IAs em background:', error);
    } finally {
      this.isProcessingBackground = false;
    }
  }

  /**
   * ✅ OTIMIZAÇÃO: Executa a cada 15 segundos (em vez de 10s) para modo fast
   * - Reduz execuções de 6/min para 4/min (33% menos)
   * - Verifica se há usuários ativos ANTES de executar (evita queries desnecessárias)
   * - Adiciona proteção contra execuções simultâneas
   */
  @Cron('*/15 * * * * *', {
    name: 'process-fast-mode-ais',
  })
  async handleFastModeAIs() {
    // ✅ OTIMIZAÇÃO: Evitar execuções simultâneas
    if (this.isProcessingFastMode) {
      this.logger.debug('[Scheduler] Processamento de fast mode já em andamento, pulando...');
      return;
    }

    // ✅ OTIMIZAÇÃO CRÍTICA: Verificar se há usuários ativos ANTES de executar
    const activeUsersCount = await this.aiService.getActiveUsersCount();
    if (activeUsersCount === 0) {
      // Não logar para evitar poluição - apenas retornar silenciosamente
      return;
    }

    this.isProcessingFastMode = true;
    this.logger.debug(`🔄 [Scheduler] Executando processamento de modo fast (${activeUsersCount} usuários ativos)`);
    
    try {
      await this.aiService.processFastModeUsers();
    } catch (error) {
      this.logger.error('❌ [Scheduler] Erro ao processar modo fast:', error);
    } finally {
      this.isProcessingFastMode = false;
    }
  }
}







