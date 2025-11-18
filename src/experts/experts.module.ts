import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { ExpertsController } from './experts.controller';
import { ExpertsService } from './experts.service';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExpertEntity]),
    PassportModule,
  ],
  controllers: [ExpertsController],
  providers: [ExpertsService],
  exports: [ExpertsService],
})
export class ExpertsModule {}

