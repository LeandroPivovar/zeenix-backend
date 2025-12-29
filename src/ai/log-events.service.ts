import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

interface LogEventPayload {
  userId: string;
  type: 'log_created';
  log: {
    id?: number;
    timestamp?: string;
    created_at?: string;
    type: string;
    icon: string;
    message: string;
    details?: any;
  };
}

@Injectable()
export class LogEventsService {
  private readonly logger = new Logger(LogEventsService.name);
  private readonly stream$ = new Subject<LogEventPayload>();

  emit(event: LogEventPayload): void {
    this.stream$.next(event);
  }

  subscribe(userId: string): Observable<MessageEvent> {
    return this.stream$.pipe(
      filter((event) => event.userId === userId),
      map((event) => ({ data: event } as MessageEvent)),
    );
  }
}

