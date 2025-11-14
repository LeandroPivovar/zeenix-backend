import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}

