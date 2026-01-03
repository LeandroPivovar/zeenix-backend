import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiScheduler } from './ai.scheduler';
import { StatsIAsService } from './stats-ias.service';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';
import { BrokerModule } from '../broker/broker.module';
import { StrategyManagerService } from './strategies/strategy-manager.service';
import { OrionStrategy } from './strategies/orion.strategy';
import { TrinityStrategy } from './strategies/trinity.strategy';
import { AtlasStrategy } from './strategies/atlas.strategy';
import { ApolloStrategy } from './strategies/apollo.strategy';
import { TitanStrategy } from './strategies/titan.strategy';
import { TradeEventsService } from './trade-events.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    forwardRef(() => CopyTradingModule),
    BrokerModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiScheduler,
    StatsIAsService,
    StrategyManagerService,
    OrionStrategy,
    TrinityStrategy,
    AtlasStrategy,
    ApolloStrategy,
    TitanStrategy,
    TradeEventsService,
  ],
  exports: [AiService, StrategyManagerService, TradeEventsService],
})
export class AiModule { }

