import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiScheduler } from './ai.scheduler';
import { StatsIAsService } from './stats-ias.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [AiController],
  providers: [AiService, AiScheduler, StatsIAsService],
  exports: [AiService],
})
export class AiModule {}

