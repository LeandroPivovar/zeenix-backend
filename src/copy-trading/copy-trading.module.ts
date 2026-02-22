import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CopyTradingController } from './copy-trading.controller';
import { CopyTradingService } from './copy-trading.service';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { BrokerModule } from '../broker/broker.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExpertEntity, UserEntity]),
    forwardRef(() => BrokerModule),
    forwardRef(() => PlansModule),
  ],
  controllers: [CopyTradingController],
  providers: [CopyTradingService],
  exports: [CopyTradingService],
})
export class CopyTradingModule { }

