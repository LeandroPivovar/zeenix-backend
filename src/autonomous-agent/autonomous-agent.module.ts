import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutonomousAgentController } from './autonomous-agent.controller';
import { AutonomousAgentService } from './autonomous-agent.service';
import { AutonomousAgentLogsStreamService } from './autonomous-agent-logs-stream.service';
import { UtilsModule } from '../utils/utils.module';

/**
 * ✅ MÓDULO SIMPLIFICADO: Agente Autônomo
 * Removido scheduler e estratégias - apenas endpoints de controle
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    UtilsModule, // Para LogQueueService
  ],
  controllers: [AutonomousAgentController],
  providers: [
    AutonomousAgentService,
    AutonomousAgentLogsStreamService,
  ],
  exports: [
    AutonomousAgentService,
    AutonomousAgentLogsStreamService,
  ],
})
export class AutonomousAgentModule {}

