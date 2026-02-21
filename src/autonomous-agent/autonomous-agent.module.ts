import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutonomousAgentController } from './autonomous-agent.controller';
import { AutonomousAgentService } from './autonomous-agent.service';
import { AutonomousAgentScheduler } from './autonomous-agent.scheduler';
import { AutonomousAgentLogsStreamService } from './autonomous-agent-logs-stream.service';
import { SettingsModule } from '../settings/settings.module';
import { BrokerModule } from '../broker/broker.module';
import { AiModule } from '../ai/ai.module';
import { AutonomousAgentStrategyManagerService } from './strategies/autonomous-agent-strategy-manager.service';
import { OrionAutonomousStrategy } from './strategies/orion.strategy';
import { SentinelStrategy } from './strategies/sentinel.strategy';
import { FalconStrategy } from './strategies/falcon.strategy';
import { ZeusStrategy } from './strategies/zeus.strategy';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    forwardRef(() => SettingsModule),
    BrokerModule,
    forwardRef(() => AiModule), // ✅ Importar AiModule para usar OrionStrategy
    // ✅ UtilsModule é global, não precisa importar
  ],
  controllers: [AutonomousAgentController],
  providers: [
    AutonomousAgentService,
    AutonomousAgentScheduler,
    AutonomousAgentLogsStreamService,
    // ✅ Estratégias do agente autônomo
    AutonomousAgentStrategyManagerService,
    OrionAutonomousStrategy,
    SentinelStrategy,
    FalconStrategy,
    ZeusStrategy,
  ],
  exports: [
    AutonomousAgentService,
    AutonomousAgentLogsStreamService,
    AutonomousAgentStrategyManagerService,
  ],
})
export class AutonomousAgentModule { }
