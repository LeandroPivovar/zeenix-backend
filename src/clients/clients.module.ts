import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { UserSessionEntity } from '../infrastructure/database/entities/user-session.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, UserSessionEntity]),
  ],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}

