import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../user.module';
import { UserSettingsEntity } from '../infrastructure/database/entities/user-settings.entity';
import { UserActivityLogEntity } from '../infrastructure/database/entities/user-activity-log.entity';
import { UserSessionEntity } from '../infrastructure/database/entities/user-session.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { DERIV_SERVICE } from '../constants/tokens';
import { DerivService } from '../broker/deriv.service';
import { BrokerModule } from '../broker/broker.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserSettingsEntity, UserActivityLogEntity, UserSessionEntity]),
    UserModule,
    forwardRef(() => BrokerModule),
  ],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    {
      provide: DERIV_SERVICE,
      useExisting: DerivService,
    },
  ],
  exports: [SettingsService],
})
export class SettingsModule { }




