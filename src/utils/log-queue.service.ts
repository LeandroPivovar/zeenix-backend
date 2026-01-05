import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface LogEntry {
  userId: string;
  type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro' | 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  details?: any;
  icon?: string;
  sessionId?: string;
  // Para autonomous-agent
  level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  module?: 'CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER';
  metadata?: any;
  tableName?: 'ai_logs' | 'autonomous_agent_logs'; // Tabela de destino
}

/**
 * Serviço centralizado de fila de logs assíncrona
 * Otimiza performance ao agrupar logs em batch e processar em background
 */
@Injectable()
export class LogQueueService implements OnModuleInit {
  private readonly logger = new Logger(LogQueueService.name);
  private logQueue: LogEntry[] = [];
  private logProcessing = false;
  private readonly BATCH_SIZE = 100; // Processar até 100 logs por vez
  private readonly MAX_QUEUE_SIZE = 10000; // Limite máximo da fila

  private readonly icons = {
    info: 'ℹ️',
    tick: '📥',
    analise: '🔍',
    sinal: '🎯',
    operacao: '💰',
    resultado: '✅',
    alerta: '⚠️',
    erro: '🚫',
  };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.logger.log('[LogQueueService] ✅ Serviço de fila de logs inicializado');
  }

  /**
   * Adiciona log à fila de forma assíncrona (não bloqueia execução)
   */
  saveLogAsync(entry: LogEntry): void {
    // Validar parâmetros
    if (!entry.userId || !entry.type || !entry.message || entry.message.trim() === '') {
      return;
    }

    // Limitar tamanho da fila para evitar consumo excessivo de memória
    if (this.logQueue.length >= this.MAX_QUEUE_SIZE) {
      this.logger.warn(`[LogQueue] ⚠️ Fila cheia (${this.MAX_QUEUE_SIZE}), descartando log mais antigo`);
      this.logQueue.shift(); // Remove o mais antigo
    }

    // Adicionar à fila
    this.logQueue.push(entry);

    // Processar fila em background se não estiver processando
    if (!this.logProcessing && this.logQueue.length >= 10) {
      // Processar imediatamente se houver 10+ logs
      setImmediate(() => this.processLogQueue());
    }
  }

  /**
   * Processa fila de logs em batch (otimizado)
   */
  private async processLogQueue(): Promise<void> {
    if (this.logProcessing || this.logQueue.length === 0) {
      return;
    }

    this.logProcessing = true;

    try {
      // Separar logs por tabela de destino
      const aiLogs: LogEntry[] = [];
      const agentLogs: LogEntry[] = [];

      // Processar até BATCH_SIZE logs
      const batch = this.logQueue.splice(0, this.BATCH_SIZE);

      for (const log of batch) {
        if (log.tableName === 'autonomous_agent_logs' || log.level) {
          agentLogs.push(log);
        } else {
          aiLogs.push(log);
        }
      }

      // Processar logs de AI e Agent em paralelo
      await Promise.all([
        aiLogs.length > 0 ? this.saveAiLogsBatch(aiLogs) : Promise.resolve(),
        agentLogs.length > 0 ? this.saveAgentLogsBatch(agentLogs) : Promise.resolve(),
      ]);

      // Se ainda há logs na fila, processar novamente
      if (this.logQueue.length > 0) {
        setImmediate(() => this.processLogQueue());
      }
    } catch (error) {
      this.logger.error(`[LogQueue] ❌ Erro ao processar fila de logs:`, error);
    } finally {
      this.logProcessing = false;
    }
  }

  /**
   * Salva logs de AI em batch
   */
  private async saveAiLogsBatch(logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      // Agrupar por userId para otimizar
      const logsByUser = new Map<string, LogEntry[]>();
      for (const log of logs) {
        if (!logsByUser.has(log.userId)) {
          logsByUser.set(log.userId, []);
        }
        logsByUser.get(log.userId)!.push(log);
      }

      // Processar cada usuário em paralelo
      await Promise.all(
        Array.from(logsByUser.entries()).map(([userId, userLogs]) =>
          this.saveAiLogsForUser(userId, userLogs)
        )
      );
    } catch (error) {
      this.logger.error(`[LogQueue] Erro ao salvar logs de AI:`, error);
    }
  }

  /**
   * Salva logs de AI para um usuário específico
   */
  private async saveAiLogsForUser(userId: string, logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      const sessionId = logs[0].sessionId || userId;

      // Preparar valores para INSERT em batch
      const values = logs.map(log => {
        const icon = log.icon || this.icons[log.type as keyof typeof this.icons] || 'ℹ️';
        return [
          userId,
          log.type,
          icon,
          log.message.substring(0, 5000), // Limitar tamanho
          log.details ? JSON.stringify(log.details).substring(0, 10000) : null,
          sessionId,
        ];
      });

      // INSERT em batch (muito mais rápido que múltiplos INSERTs)
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, NOW(3))').join(', ');
      const flatValues = values.flat();

      await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, type, icon, message, details, session_id, timestamp)
         VALUES ${placeholders}`,
        flatValues,
      );

      this.logger.debug(`[LogQueue] ✅ ${logs.length} logs de AI salvos para usuário ${userId}`);
    } catch (error) {
      this.logger.error(`[LogQueue] Erro ao salvar logs de AI para ${userId}:`, error);
    }
  }

  /**
   * Salva logs de Autonomous Agent em batch
   */
  private async saveAgentLogsBatch(logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      // Agrupar por userId
      const logsByUser = new Map<string, LogEntry[]>();
      for (const log of logs) {
        if (!logsByUser.has(log.userId)) {
          logsByUser.set(log.userId, []);
        }
        logsByUser.get(log.userId)!.push(log);
      }

      // Processar cada usuário em paralelo
      await Promise.all(
        Array.from(logsByUser.entries()).map(([userId, userLogs]) =>
          this.saveAgentLogsForUser(userId, userLogs)
        )
      );
    } catch (error) {
      this.logger.error(`[LogQueue] Erro ao salvar logs de Agent:`, error);
    }
  }

  /**
   * Salva logs de Agent para um usuário específico
   */
  private async saveAgentLogsForUser(userId: string, logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      // Preparar valores para INSERT em batch
      const values = logs.map(log => {
        const now = new Date();
        const timestampMySQL = now
          .toISOString()
          .replace('T', ' ')
          .replace('Z', '')
          .slice(0, 23); // YYYY-MM-DD HH:MM:SS.mmm

        return [
          userId,
          timestampMySQL,
          log.level || 'INFO',
          log.module || 'CORE',
          log.message.substring(0, 5000),
          log.metadata ? JSON.stringify(log.metadata).substring(0, 10000) : null,
        ];
      });

      // INSERT em batch
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      const flatValues = values.flat();

      await this.dataSource.query(
        `INSERT INTO autonomous_agent_logs (user_id, timestamp, log_level, module, message, metadata)
         VALUES ${placeholders}`,
        flatValues,
      );

      this.logger.debug(`[LogQueue] ✅ ${logs.length} logs de Agent salvos para usuário ${userId}`);
    } catch (error) {
      this.logger.error(`[LogQueue] Erro ao salvar logs de Agent para ${userId}:`, error);
    }
  }

  /**
   * Flush periódico da fila (executa a cada 5 segundos)
   * Garante que logs sejam salvos mesmo se não houver muitos logs acumulados
   */
  @Cron('*/5 * * * * *', {
    name: 'flush-log-queue',
  })
  async flushLogQueue(): Promise<void> {
    if (this.logQueue.length > 0 && !this.logProcessing) {
      this.logger.debug(`[LogQueue] 🔄 Flush periódico: ${this.logQueue.length} logs pendentes`);
      await this.processLogQueue();
    }
  }

  /**
   * Força flush imediato da fila (útil para shutdown graceful)
   */
  async flush(): Promise<void> {
    while (this.logQueue.length > 0) {
      await this.processLogQueue();
      // Pequeno delay para evitar sobrecarga
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Retorna tamanho atual da fila (útil para monitoramento)
   */
  getQueueSize(): number {
    return this.logQueue.length;
  }
}

