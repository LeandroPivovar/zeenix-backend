import { MarketEntity } from '../../infrastructure/database/entities/market.entity';

export interface MarketsRepository {
    create(market: Partial<MarketEntity>): Promise<MarketEntity>;
    findAll(): Promise<MarketEntity[]>;
    findBySymbol(symbol: string): Promise<MarketEntity | null>;
    save(market: MarketEntity): Promise<MarketEntity>;
    update(market: MarketEntity): Promise<MarketEntity>;
    upsert(markets: Partial<MarketEntity>[]): Promise<void>;
}
