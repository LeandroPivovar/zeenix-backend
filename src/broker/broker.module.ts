import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DerivController } from './deriv.controller';
import { ManualTradeController } from './manual-trade.controller';
import { DerivService } from './deriv.service';
import { DerivWebSocketService } from './deriv-websocket.service';
import { DerivWebSocketManagerService } from './deriv-websocket-manager.service';
import { DerivWebSocketPoolService } from './deriv-websocket-pool.service';
import { UserModule } from '../user.module';
import { SettingsModule } from '../settings/settings.module';
import { TradeEntity } from '../infrastructure/database/entities/trade.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';

@Module({
  imports: [
    UserModule,
    forwardRef(() => SettingsModule),
    TypeOrmModule.forFeature([TradeEntity, UserEntity]),
    forwardRef(() => CopyTradingModule),
  ],
  controllers: [DerivController, ManualTradeController],
  providers: [
    DerivService,
    DerivWebSocketService,
    DerivWebSocketManagerService,
    DerivWebSocketPoolService,
  ],
  exports: [
    DerivService,
    DerivWebSocketService,
    DerivWebSocketManagerService,
    DerivWebSocketPoolService,
  ],
})
export class BrokerModule { }


