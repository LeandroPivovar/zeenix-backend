import { Module } from '@nestjs/common';
import { MarkupService } from './markup.service';
import { MarkupController } from './markup.controller';
import { UserModule } from '../user.module';

@Module({
    imports: [UserModule],
    controllers: [MarkupController],
    providers: [MarkupService],
    exports: [MarkupService],
})
export class MarkupModule { }
