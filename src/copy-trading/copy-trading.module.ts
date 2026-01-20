import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CopyTradingController } from './copy-trading.controller';
import { CopyTradingService } from './copy-trading.service';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ExpertEntity, UserEntity])],
  controllers: [CopyTradingController],
  providers: [CopyTradingService],
  exports: [CopyTradingService],
})
export class CopyTradingModule { }

