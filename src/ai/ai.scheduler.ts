import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiService } from './ai.service';

@Injectable()
export class AiScheduler {
  private readonly logger = new Logger(AiScheduler.name);

  constructor(private readonly aiService: AiService) {}

  /**
   * Executa a cada 1 minuto para modos normais
   * Processa IAs em background para todos os usuários com IA ativa
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'process-background-ais',
  })
  async handleBackgroundAIs() {
    this.logger.debug('Executando scheduler de IAs em background');

    try {
      await this.aiService.processBackgroundAIs();
    } catch (error) {
      this.logger.error('Erro ao processar IAs em background:', error);
    }
  }

  /**
   * Executa a cada 5 segundos para modo fast (sem delay)
   * Processa apenas usuários em modo fast para operação contínua
   */
  @Cron('*/5 * * * * *', {
    name: 'process-fast-mode-ais',
  })
  async handleFastModeAIs() {
    try {
      await this.aiService.processFastModeUsers();
    } catch (error) {
      this.logger.error('Erro ao processar modo fast:', error);
    }
  }
}







