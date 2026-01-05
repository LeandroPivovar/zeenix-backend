import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutonomousAgentController } from './autonomous-agent.controller';
import { AutonomousAgentService } from './autonomous-agent.service';
import { AutonomousAgentScheduler } from './autonomous-agent.scheduler';
import { AutonomousAgentLogsStreamService } from './autonomous-agent-logs-stream.service';
import { SettingsModule } from '../settings/settings.module';
import { BrokerModule } from '../broker/broker.module';
import { AgentManagerService } from './strategies/agent-manager.service';
import { SentinelStrategy } from './strategies/sentinel.strategy';
import { FalconStrategy } from './strategies/falcon.strategy';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    SettingsModule,
    BrokerModule,
  ],
  controllers: [AutonomousAgentController],
  providers: [
    AutonomousAgentService,
    AutonomousAgentScheduler,
    AutonomousAgentLogsStreamService,
    AgentManagerService,
    SentinelStrategy,
    FalconStrategy,
  ],
  exports: [
    AutonomousAgentService,
    AutonomousAgentLogsStreamService,
    AgentManagerService,
  ],
})
export class AutonomousAgentModule {}

