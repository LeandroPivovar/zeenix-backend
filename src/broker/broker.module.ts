import { Module } from '@nestjs/common';
import { DerivController } from './deriv.controller';
import { DerivService } from './deriv.service';
import { UserModule } from '../user.module';

@Module({
  imports: [UserModule],
  controllers: [DerivController],
  providers: [DerivService],
})
export class BrokerModule {}


