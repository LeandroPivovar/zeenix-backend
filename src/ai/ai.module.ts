import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiScheduler } from './ai.scheduler';
import { StatsIAsService } from './stats-ias.service';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';
import { StrategyManagerService } from './strategies/strategy-manager.service';
import { OrionStrategy } from './strategies/orion.strategy';
import { TrinityStrategy } from './strategies/trinity.strategy';

@Module({
  imports: [TypeOrmModule.forFeature([]), forwardRef(() => CopyTradingModule)],
  controllers: [AiController],
  providers: [
    AiService,
    AiScheduler,
    StatsIAsService,
    StrategyManagerService,
    OrionStrategy,
    TrinityStrategy,
  ],
  exports: [AiService, StrategyManagerService],
})
export class AiModule {}

