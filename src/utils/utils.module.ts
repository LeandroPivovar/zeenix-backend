import { Global, Module } from '@nestjs/common';
import { LogQueueService } from './log-queue.service';

@Global()
@Module({
  providers: [LogQueueService],
  exports: [LogQueueService],
})
export class UtilsModule {}







