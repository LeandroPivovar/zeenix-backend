import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../user.module';
import { SettingsModule } from '../settings/settings.module';
import { PlanEntity } from '../infrastructure/database/entities/plan.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlanEntity, UserEntity]),
    UserModule,
    SettingsModule,
  ],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}

