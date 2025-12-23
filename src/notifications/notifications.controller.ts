import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { NotificationsService, LoginNotificationSummary } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * GET /notifications/login-summary
   * Retorna resumo de notificações ao fazer login
   * Verifica status do agente autônomo e da IA
   */
  @Get('login-summary')
  @UseGuards(JwtAuthGuard)
  async getLoginSummary(@Req() req: any): Promise<LoginNotificationSummary> {
    const userId = req.user?.userId;
    
    if (!userId) {
      return {
        agent: null,
        ai: null,
        hasNotifications: false,
        notifications: [],
      };
    }

    return this.notificationsService.getLoginSummary(userId);
  }

  /**
   * GET /notifications/summary/:userId
   * Retorna resumo de notificações para um usuário específico (para uso interno/admin)
   */
  @Get('summary/:userId')
  @UseGuards(JwtAuthGuard)
  async getSummaryByUserId(@Req() req: any): Promise<LoginNotificationSummary> {
    // Por segurança, usar apenas o userId do token (não do parâmetro)
    const userId = req.user?.userId;
    
    if (!userId) {
      return {
        agent: null,
        ai: null,
        hasNotifications: false,
        notifications: [],
      };
    }

    return this.notificationsService.getLoginSummary(userId);
  }
}






