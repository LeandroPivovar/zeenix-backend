import { Controller, Get, Post, UseGuards, Req, Body } from '@nestjs/common';
import { NotificationsService, LoginNotificationSummary } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DailySummaryService } from './daily-summary.service';
import { NotificationEntity } from '../infrastructure/database/entities/notification.entity';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly dailySummaryService: DailySummaryService
  ) { }

  /**
   * POST /notifications
   * Cria nova notificação (Admin)
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() data: Partial<NotificationEntity>): Promise<NotificationEntity> {
    // TODO: Adicionar verificação de admin se JwtAuthGuard não lidar com roles
    return this.notificationsService.create(data);
  }

  /**
   * GET /notifications/admin
   * Lista todas as notificações para o Admin
   */
  @Get('admin')
  @UseGuards(JwtAuthGuard)
  async findAllAdmin(@Req() req: any): Promise<NotificationEntity[]> {
    // TODO: Adicionar verificação de admin
    return this.notificationsService.findAll();
  }

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















