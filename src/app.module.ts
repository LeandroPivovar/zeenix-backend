import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database.module';
import { UserModule } from './user.module';
import { AuthModule } from './auth/auth.module';
import { BrokerModule } from './broker/broker.module';

@Module({
  imports: [DatabaseModule, UserModule, AuthModule, BrokerModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
