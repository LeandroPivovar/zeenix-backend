import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DerivWebSocketService } from './deriv-websocket.service';

@Injectable()
export class DerivWebSocketManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(DerivWebSocketManagerService.name);
  private userServices = new Map<string, DerivWebSocketService>();

  getOrCreateService(userId: string): DerivWebSocketService {
    if (!this.userServices.has(userId)) {
      this.logger.log(`Criando novo serviço WebSocket para usuário ${userId}`);
      const service = new DerivWebSocketService();
      this.userServices.set(userId, service);
    }
    return this.userServices.get(userId)!;
  }

  getService(userId: string): DerivWebSocketService | null {
    return this.userServices.get(userId) || null;
  }

  removeService(userId: string): void {
    const service = this.userServices.get(userId);
    if (service) {
      this.logger.log(`Removendo serviço WebSocket para usuário ${userId}`);
      service.disconnect();
      this.userServices.delete(userId);
    }
  }

  onModuleDestroy() {
    this.logger.log('Desconectando todos os serviços WebSocket...');
    for (const [userId, service] of this.userServices.entries()) {
      try {
        service.disconnect();
      } catch (error) {
        this.logger.error(`Erro ao desconectar serviço do usuário ${userId}:`, error);
      }
    }
    this.userServices.clear();
  }
}











