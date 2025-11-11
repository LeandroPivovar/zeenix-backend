import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FaqEntity } from '../infrastructure/database/entities/faq.entity';
import { SystemStatusEntity } from '../infrastructure/database/entities/system-status.entity';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FaqEntity, SystemStatusEntity])],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}




