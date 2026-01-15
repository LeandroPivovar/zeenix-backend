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
   * ✅ OTIMIZAÇÃO: Executa a cada 10 segundos (em vez de 5s) para modo fast
   * - Reduz execuções de 12/min para 6/min (50% menos)
   * - Ainda mantém boa responsividade (10s é aceitável para fast mode)
   * - Adiciona proteção contra execuções simultâneas
   */
  @Cron('*/10 * * * * *', {
    name: 'process-fast-mode-ais',
  })
  async handleFastModeAIs() {
    // ✅ OTIMIZAÇÃO: Evitar execuções simultâneas
    if (this.isProcessingFastMode) {
      this.logger.debug('[Scheduler] Processamento de fast mode já em andamento, pulando...');
      return;
    }

    this.isProcessingFastMode = true;
    this.logger.debug('🔄 [Scheduler] Executando processamento de modo fast');
    
    try {
      await this.aiService.processFastModeUsers();
    } catch (error) {
      this.logger.error('❌ [Scheduler] Erro ao processar modo fast:', error);
    } finally {
      this.isProcessingFastMode = false;
    }
  }
}







