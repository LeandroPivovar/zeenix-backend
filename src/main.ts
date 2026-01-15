import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import { join } from 'path';
import { DataSource } from 'typeorm';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // ✅ Executar migrations automaticamente na inicialização
  try {
    const dataSource = app.get(DataSource);
    console.log('🔄 Verificando e executando migrations pendentes...');
    const pendingMigrations = await dataSource.showMigrations();

    if (pendingMigrations) {
      console.log('📦 Migrations pendentes encontradas. Executando...');
      await dataSource.runMigrations();
      console.log('✅ Migrations executadas com sucesso!');
    } else {
      console.log('✅ Nenhuma migration pendente. Banco de dados atualizado!');
    }
  } catch (error) {
    console.error('❌ Erro ao executar migrations:', error);
    console.warn('⚠️ Continuando inicialização mesmo com erro nas migrations...');
  }

  // Para uploads de vídeo, aumentamos para 2GB (multer já tem limite de 1GB configurado)
  app.use(json({ limit: '50mb' })); // JSON continua em 50MB
  app.use(urlencoded({ limit: '2gb', extended: true })); // Aumentado para suportar uploads grandes

  // Servir arquivos estáticos enviados pelos usuários
  // Servir em /uploads/ (nginx faz proxy de /api/uploads/ -> /uploads/)
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
  });

  // Configurar prefixo global /api
  // Nginx faz proxy de /api/ para o backend, então precisamos do prefixo
  app.setGlobalPrefix('api');

  // Configurar validação global
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false, // Permitir campos extras para compatibilidade
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
    skipMissingProperties: false,
    skipNullProperties: false,
    skipUndefinedProperties: true,
  }));

  // CORS
  const corsOrigins = config.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: corsOrigins ? corsOrigins.split(',') : true,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
