import { Module } from '@nestjs/common';
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

@Module({
  imports: [DatabaseModule, UserModule, AuthModule, BrokerModule, CoursesModule, SupportModule, SettingsModule, PlansModule, TradesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
