import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutonomousAgentController } from './autonomous-agent.controller';
import { AutonomousAgentService } from './autonomous-agent.service';
import { AutonomousAgentScheduler } from './autonomous-agent.scheduler';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [AutonomousAgentController],
  providers: [AutonomousAgentService, AutonomousAgentScheduler],
  exports: [AutonomousAgentService],
})
export class AutonomousAgentModule {}

