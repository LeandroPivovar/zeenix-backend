import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookController } from './webhook.controller';
import { UserModule } from '../user.module';
import { AuthModule } from '../auth/auth.module';
import { WebhookLogEntity } from '../infrastructure/database/entities/webhook-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookLogEntity]),
    UserModule,
    AuthModule,
  ],
  controllers: [WebhookController],
})
export class WebhookModule { }

