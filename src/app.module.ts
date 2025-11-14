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

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule, 
    UserModule, 
    AuthModule, 
    BrokerModule, 
    CoursesModule, 
    SupportModule, 
    SettingsModule, 
    PlansModule, 
    TradesModule, 
    GeminiModule, 
    AiModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
