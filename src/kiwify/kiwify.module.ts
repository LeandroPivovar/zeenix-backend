import { Module } from '@nestjs/common';
import { KiwifyService } from './kiwify.service';
import { KiwifyController } from './kiwify.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [ConfigModule],
    controllers: [KiwifyController],
    providers: [KiwifyService],
    exports: [KiwifyService],
})
export class KiwifyModule { }
