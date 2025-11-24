import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CopyTradingController } from './copy-trading.controller';
import { CopyTradingService } from './copy-trading.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [CopyTradingController],
  providers: [CopyTradingService],
  exports: [CopyTradingService],
})
export class CopyTradingModule {}

