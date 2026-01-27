import { Module } from '@nestjs/common';
import { KiwifyService } from './kiwify.service';
import { KiwifyController } from './kiwify.controller';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { PlanEntity } from '../infrastructure/database/entities/plan.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([UserEntity, PlanEntity])
  ],
  controllers: [KiwifyController],
  providers: [KiwifyService],
  exports: [KiwifyService],
})
export class KiwifyModule { }
