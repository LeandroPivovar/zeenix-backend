import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

interface TradeEventPayload {
  userId: string;
  type: 'created' | 'updated' | 'corrected';
  tradeId?: number;
  status?: string;
  strategy?: string;
  symbol?: string;
  contractType?: string;
  profitLoss?: number;
  exitPrice?: number;
  isPredicted?: boolean; // ✅ Indica se é uma previsão (não confirmada ainda)
  previousPrediction?: 'WON' | 'LOST'; // ✅ Para eventos 'corrected'
  confirmedStatus?: 'WON' | 'LOST'; // ✅ Para eventos 'corrected'
  previousProfit?: number; // ✅ Para eventos 'corrected'
  confirmedProfit?: number; // ✅ Para eventos 'corrected'
}

@Injectable()
export class TradeEventsService {
  private readonly logger = new Logger(TradeEventsService.name);
  private readonly stream$ = new Subject<TradeEventPayload>();

  emit(event: TradeEventPayload): void {
    this.stream$.next(event);
  }

  subscribe(userId: string, strategy?: string): Observable<MessageEvent> {
    return this.stream$.pipe(
      filter((event) => {
        if (event.userId !== userId) return false;
        if (strategy) {
          return (event.strategy || '').toLowerCase() === strategy.toLowerCase();
        }
        return true;
      }),
      map((event) => ({ data: event } as MessageEvent)),
    );
  }
}


