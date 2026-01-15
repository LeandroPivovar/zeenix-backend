import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database.module';
import { UserModule } from './user.module';
import { AuthModule } from './auth/auth.module';
import { BrokerModule } from './broker/broker.module';
import { CoursesModule } from './courses/courses.module';
import { SupportModule } from './support/support.module';
import { SettingsModule } from './settings/settings.module';
import { PlansModule } from './plans/plans.module';
import { TradesModule } from './trades/trades.module';
import { GeminiModule } from './gemini/gemini.module';
import { AiModule } from './ai/ai.module';
import { CopyTradingModule } from './copy-trading/copy-trading.module';
import { ClientsModule } from './clients/clients.module';
import { AdminModule } from './presentation/admin.module';
import { ExpertsModule } from './experts/experts.module';
import { WebhookModule } from './webhook/webhook.module';
import { AutonomousAgentModule } from './autonomous-agent/autonomous-agent.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UtilsModule } from './utils/utils.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    UtilsModule, // Módulo global para utilitários (LogQueueService) 
    UserModule, 
    AuthModule, 
    BrokerModule, 
    CoursesModule, 
    SupportModule, 
    SettingsModule, 
    PlansModule, 
    TradesModule, 
    GeminiModule, 
    AiModule,
    CopyTradingModule,
    ClientsModule,
    AdminModule,
    ExpertsModule,
    WebhookModule,
    AutonomousAgentModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
