import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { DailySummaryService } from './daily-summary.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationEntity } from '../infrastructure/database/entities/notification.entity';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    TypeOrmModule.forFeature([NotificationEntity])
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, DailySummaryService],
  exports: [NotificationsService, DailySummaryService],
})
export class NotificationsModule { }















