import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../user.module';
import { UserSettingsEntity } from '../infrastructure/database/entities/user-settings.entity';
import { UserActivityLogEntity } from '../infrastructure/database/entities/user-activity-log.entity';
import { UserSessionEntity } from '../infrastructure/database/entities/user-session.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserSettingsEntity, UserActivityLogEntity, UserSessionEntity]),
    UserModule,
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}




