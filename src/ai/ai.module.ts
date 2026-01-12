import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiScheduler } from './ai.scheduler';
import { StatsIAsService } from './stats-ias.service';
import { PerformanceService } from './performance.service';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';
import { BrokerModule } from '../broker/broker.module';
import { StrategyManagerService } from './strategies/strategy-manager.service';
import { OrionStrategy } from './strategies/orion.strategy';
import { AtlasStrategy } from './strategies/atlas.strategy';
import { ApolloStrategy } from './strategies/apollo.strategy';
import { TitanStrategy } from './strategies/titan.strategy';
import { NexusStrategy } from './strategies/nexus.strategy';
import { TradeEventsService } from './trade-events.service';
import { AutonomousAgentModule } from '../autonomous-agent/autonomous-agent.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    forwardRef(() => CopyTradingModule),
    forwardRef(() => AutonomousAgentModule), // ✅ Importar para compartilhar ticks
    BrokerModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiScheduler,
    StatsIAsService,
    StrategyManagerService,
    OrionStrategy,
    AtlasStrategy,
    ApolloStrategy,
    TitanStrategy,
    NexusStrategy,
    PerformanceService,
    TradeEventsService,
  ],
  exports: [AiService, StrategyManagerService, TradeEventsService, OrionStrategy], // ✅ Exportar OrionStrategy para uso no agente autônomo
})
export class AiModule { }

