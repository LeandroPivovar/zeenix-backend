import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DerivController } from './deriv.controller';
import { DerivService } from './deriv.service';
import { DerivWebSocketService } from './deriv-websocket.service';
import { DerivWebSocketManagerService } from './deriv-websocket-manager.service';
import { UserModule } from '../user.module';
import { SettingsModule } from '../settings/settings.module';
import { TradeEntity } from '../infrastructure/database/entities/trade.entity';

@Module({
  imports: [
    UserModule, 
    SettingsModule,
    TypeOrmModule.forFeature([TradeEntity]),
  ],
  controllers: [DerivController],
  providers: [DerivService, DerivWebSocketService, DerivWebSocketManagerService],
  exports: [DerivWebSocketService, DerivWebSocketManagerService],
})
export class BrokerModule {}


