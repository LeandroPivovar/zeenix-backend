import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

interface TradeEventPayload {
  userId: string;
  type: 'created' | 'updated' | 'corrected' | 'stopped_blindado' | 'stopped_loss' | 'blindado_activated';
  tradeId?: number;
  status?: string;
  strategy?: string;
  symbol?: string;
  contractType?: string;
  profitLoss?: number;
  exitPrice?: number;
  isPredicted?: boolean; // ✅ Indica se é uma previsão (não confirmada ainda)
  previousPrediction?: 'WON' | 'LOST' | null; // ✅ Para eventos 'corrected'
  confirmedStatus?: 'WON' | 'LOST'; // ✅ Para eventos 'corrected'
  previousProfit?: number; // ✅ Para eventos 'corrected'
  confirmedProfit?: number; // ✅ Para eventos 'corrected'
  profitProtected?: number; // ✅ Para eventos 'stopped_blindado' - lucro garantido
  profitPeak?: number; // ✅ Para evento 'blindado_activated' - pico de lucro
  protectedAmount?: number; // ✅ Para evento 'blindado_activated' - valor protegido
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


