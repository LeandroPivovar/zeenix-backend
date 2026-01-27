import { Module, forwardRef } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { DailySummaryService } from './daily-summary.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [NotificationsController],
  providers: [NotificationsService, DailySummaryService],
  exports: [NotificationsService, DailySummaryService],
})
export class NotificationsModule { }















