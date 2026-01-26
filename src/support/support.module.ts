import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FaqEntity } from '../infrastructure/database/entities/faq.entity';
import { SystemStatusEntity } from '../infrastructure/database/entities/system-status.entity';
import { SupportItemEntity } from '../infrastructure/database/entities/support-item.entity';
import { AppConfigEntity } from '../infrastructure/database/entities/app-config.entity';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FaqEntity, SystemStatusEntity, SupportItemEntity, AppConfigEntity])],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule implements OnModuleInit {
  constructor(private dataSource: DataSource) { }

  async onModuleInit() {
    try {
      // Tenta alterar a coluna para LONGTEXT se ela existir.
      // Se a tabela não existir, o erro será capturado.
      // Isso é um fix temporário/emergencial pois migrations não estão rodando.
      await this.dataSource.query('ALTER TABLE `support_items` MODIFY `subtitle` LONGTEXT');
      console.log('✅ Migration (auto): support_items.subtitle modified to LONGTEXT successfully');
    } catch (e) {
      console.warn('⚠️ Migration (auto) failed for support_items.subtitle. This might be expected if table does not exist yet or other DB locked issues.', e.message);
    }
  }
}




