import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiScheduler } from './ai.scheduler';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [AiController],
  providers: [AiService, AiScheduler],
  exports: [AiService],
})
export class AiModule {}

