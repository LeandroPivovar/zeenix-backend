import { Module } from '@nestjs/common';
import { MarkupService } from './markup.service';
import { MarkupController } from './markup.controller';
import { UserModule } from '../user.module';

import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [UserModule, ConfigModule],
    controllers: [MarkupController],
    providers: [MarkupService],
    exports: [MarkupService],
})
export class MarkupModule { }
