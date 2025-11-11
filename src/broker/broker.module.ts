import { Module } from '@nestjs/common';
import { DerivController } from './deriv.controller';
import { DerivService } from './deriv.service';
import { UserModule } from '../user.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [UserModule, SettingsModule],
  controllers: [DerivController],
  providers: [DerivService],
})
export class BrokerModule {}


