import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './controllers/admin.controller';
import { AdminService } from './services/admin.service';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { PlanEntity } from '../infrastructure/database/entities/plan.entity';
import { UserActivityLogEntity } from '../infrastructure/database/entities/user-activity-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, PlanEntity, UserActivityLogEntity]),
    PassportModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}

