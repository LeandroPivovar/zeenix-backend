import { Injectable, Logger } from '@nestjs/common';

export interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  level: 'log' | 'error' | 'warn' | 'debug';
  context: string;
  message: string;
  data?: any;
}

@Injectable()
export class AutonomousAgentLogsStreamService {
  private readonly logger = new Logger(AutonomousAgentLogsStreamService.name);
  private readonly logBuffer: Map<string, ConsoleLogEntry[]> = new Map();
  private readonly maxBufferSize = 1000; // Máximo de logs por usuário
  private readonly subscribers: Map<
    string,
    Set<(log: ConsoleLogEntry) => void>
  > = new Map();

  // Interceptar logs do Logger do NestJS
  private originalLogMethods: {
    log?: (message: any, ...optionalParams: any[]) => void;
    error?: (message: any, ...optionalParams: any[]) => void;
    warn?: (message: any, ...optionalParams: any[]) => void;
    debug?: (message: any, ...optionalParams: any[]) => void;
  } = {};

  constructor() {
    // Interceptar métodos do Logger do NestJS
    this.setupLoggerInterception();
  }

  private setupLoggerInterception() {
    // Criar um Logger customizado que intercepta as chamadas
    const originalLogger = Logger.prototype.log;
    const originalError = Logger.prototype.error;
    const originalWarn = Logger.prototype.warn;
    const originalDebug = Logger.prototype.debug;

    // Interceptar logs do AutonomousAgentService
    const self = this;
    Logger.prototype.log = function (message: any, ...optionalParams: any[]) {
      originalLogger.call(this, message, ...optionalParams);
      if (
        this.context === 'AutonomousAgentService' ||
        this.context?.includes('AutonomousAgent')
      ) {
        self.addLog('log', this.context, message, optionalParams);
      }
    };

    Logger.prototype.error = function (message: any, ...optionalParams: any[]) {
      originalError.call(this, message, ...optionalParams);
      if (
        this.context === 'AutonomousAgentService' ||
        this.context?.includes('AutonomousAgent')
      ) {
        self.addLog('error', this.context, message, optionalParams);
      }
    };

    Logger.prototype.warn = function (message: any, ...optionalParams: any[]) {
      originalWarn.call(this, message, ...optionalParams);
      if (
        this.context === 'AutonomousAgentService' ||
        this.context?.includes('AutonomousAgent')
      ) {
        self.addLog('warn', this.context, message, optionalParams);
      }
    };

    Logger.prototype.debug = function (message: any, ...optionalParams: any[]) {
      originalDebug.call(this, message, ...optionalParams);
      if (
        this.context === 'AutonomousAgentService' ||
        this.context?.includes('AutonomousAgent')
      ) {
        self.addLog('debug', this.context, message, optionalParams);
      }
    };
  }

  private addLog(
    level: 'log' | 'error' | 'warn' | 'debug',
    context: string,
    message: any,
    optionalParams?: any[],
  ) {
    try {
      // Extrair userId do contexto da mensagem se possível
      const userId = this.extractUserIdFromMessage(message, context);
      if (!userId) {
        // Se não conseguir extrair userId, não adiciona ao buffer
        return;
      }

      const logEntry: ConsoleLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        level,
        context: context || 'Unknown',
        message:
          typeof message === 'string' ? message : JSON.stringify(message),
        data:
          optionalParams && optionalParams.length > 0
            ? optionalParams
            : undefined,
      };

      // Adicionar ao buffer do usuário
      if (!this.logBuffer.has(userId)) {
        this.logBuffer.set(userId, []);
      }

      const userLogs = this.logBuffer.get(userId)!;
      userLogs.push(logEntry);

      // Limitar tamanho do buffer
      if (userLogs.length > this.maxBufferSize) {
        userLogs.shift();
      }

      // Notificar subscribers
      this.notifySubscribers(userId, logEntry);
    } catch (error) {
      // Não falhar se houver erro ao processar log
      this.logger.warn(`[AddLog] Erro ao processar log:`, error);
    }
  }

  private extractUserIdFromMessage(
    message: any,
    context: string,
  ): string | null {
    try {
      const messageStr =
        typeof message === 'string' ? message : JSON.stringify(message);

      // Tentar extrair userId de padrões como [ProcessAgent][userId] ou [userId]
      const userIdMatch =
        messageStr.match(/\[.*?\]\[(.*?)\]/) || messageStr.match(/\[(.*?)\]/);
      if (userIdMatch && userIdMatch[1]) {
        const potentialUserId = userIdMatch[1];
        // Verificar se parece um UUID ou ID numérico
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            potentialUserId,
          ) ||
          /^\d+$/.test(potentialUserId)
        ) {
          return potentialUserId;
        }
      }

      // Tentar extrair de contextos específicos
      if (context.includes('userId') || messageStr.includes('userId')) {
        const userIdMatch = messageStr.match(/userId[:\s=]+([0-9a-f-]+|\d+)/i);
        if (userIdMatch && userIdMatch[1]) {
          return userIdMatch[1];
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // Método público para adicionar log manualmente (quando temos userId explícito)
  addLogForUser(
    userId: string,
    level: 'log' | 'error' | 'warn' | 'debug',
    context: string,
    message: string,
    data?: any,
  ) {
    const logEntry: ConsoleLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      data,
    };

    if (!this.logBuffer.has(userId)) {
      this.logBuffer.set(userId, []);
    }

    const userLogs = this.logBuffer.get(userId)!;
    userLogs.push(logEntry);

    if (userLogs.length > this.maxBufferSize) {
      userLogs.shift();
    }

    this.notifySubscribers(userId, logEntry);
  }

  private notifySubscribers(userId: string, logEntry: ConsoleLogEntry) {
    const userSubscribers = this.subscribers.get(userId);
    if (userSubscribers) {
      userSubscribers.forEach((callback) => {
        try {
          callback(logEntry);
        } catch (error) {
          this.logger.warn(
            `[NotifySubscribers] Erro ao notificar subscriber:`,
            error,
          );
        }
      });
    }
  }

  subscribe(
    userId: string,
    callback: (log: ConsoleLogEntry) => void,
  ): () => void {
    if (!this.subscribers.has(userId)) {
      this.subscribers.set(userId, new Set());
    }

    this.subscribers.get(userId)!.add(callback);

    // Retornar função de unsubscribe
    return () => {
      const userSubscribers = this.subscribers.get(userId);
      if (userSubscribers) {
        userSubscribers.delete(callback);
        if (userSubscribers.size === 0) {
          this.subscribers.delete(userId);
        }
      }
    };
  }

  getLogs(userId: string, limit: number = 500): ConsoleLogEntry[] {
    const userLogs = this.logBuffer.get(userId) || [];
    return userLogs.slice(-limit);
  }

  clearLogs(userId: string) {
    this.logBuffer.delete(userId);
  }
}
