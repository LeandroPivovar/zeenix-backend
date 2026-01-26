import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../user.module';
import { SettingsModule } from '../settings/settings.module';
import { TradeEntity } from '../infrastructure/database/entities/trade.entity';
import { TradesService } from './trades.service';
import { TradesController } from './trades.controller';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';
import { BrokerModule } from '../broker/broker.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TradeEntity]),
    UserModule,
    SettingsModule,
    BrokerModule,
    forwardRef(() => CopyTradingModule),
  ],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule { }



