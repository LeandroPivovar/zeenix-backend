import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DefaultNamingStrategy, NamingStrategyInterface } from 'typeorm';
import { snakeCase } from 'typeorm/util/StringUtils';
import { UserEntity } from './infrastructure/database/entities/user.entity';
import { CourseEntity } from './infrastructure/database/entities/course.entity';
import { ModuleEntity } from './infrastructure/database/entities/module.entity';
import { LessonEntity } from './infrastructure/database/entities/lesson.entity';
import { UserLessonProgressEntity } from './infrastructure/database/entities/user-lesson-progress.entity';
import { FaqEntity } from './infrastructure/database/entities/faq.entity';
import { SystemStatusEntity } from './infrastructure/database/entities/system-status.entity';
import { UserSettingsEntity } from './infrastructure/database/entities/user-settings.entity';
import { UserActivityLogEntity } from './infrastructure/database/entities/user-activity-log.entity';
import { UserSessionEntity } from './infrastructure/database/entities/user-session.entity';
import { PlanEntity } from './infrastructure/database/entities/plan.entity';
import { TradeEntity } from './infrastructure/database/entities/trade.entity';
import { ExpertEntity } from './infrastructure/database/entities/expert.entity';
import { SupportItemEntity } from './infrastructure/database/entities/support-item.entity';

class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  columnName(propertyName: string, customName: string, embeddedPrefixes: string[]): string {
    // Se um nome customizado foi fornecido, use-o exatamente como está (sem conversão)
    // O TypeORM passa o valor do parâmetro 'name' do decorator @Column como customName
    if (customName && customName.trim() !== '') {
      return customName;
    }
    // Caso contrário, converte para snake_case
    return snakeCase(propertyName);
  }
  relationName(propertyName: string): string {
    return snakeCase(propertyName);
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => ({
        type: (configService.get<'mysql' | 'mariadb'>('DB_TYPE') || 'mysql'),
        host: configService.get<string>('DB_HOST'),
        port: Number(configService.get<string>('DB_PORT')),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        entities: [UserEntity, CourseEntity, ModuleEntity, LessonEntity, UserLessonProgressEntity, FaqEntity, SystemStatusEntity, UserSettingsEntity, UserActivityLogEntity, UserSessionEntity, PlanEntity, TradeEntity, ExpertEntity, SupportItemEntity],
        synchronize: false, // Desabilitado porque as tabelas são gerenciadas manualmente via SQL
        logging: configService.get<string>('NODE_ENV') === 'development',
        namingStrategy: new SnakeNamingStrategy(),
      }),
      inject: [ConfigService],
    }),
  ],
})
export class DatabaseModule {}
