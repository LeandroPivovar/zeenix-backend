import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketEntity } from '../infrastructure/database/entities/market.entity';
import WebSocket from 'ws';

@Injectable()
export class MarketsService {
    private readonly logger = new Logger(MarketsService.name);

    constructor(
        @InjectRepository(MarketEntity)
        private readonly marketRepository: Repository<MarketEntity>,
    ) { }

    async findAll(): Promise<MarketEntity[]> {
        return this.marketRepository.find({ order: { displayName: 'ASC' } });
    }

    async syncMarkets(): Promise<{ count: number; message: string }> {
        const appId = 1089; // Default Deriv App ID
        const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);

            ws.on('open', () => {
                this.logger.log('Connected to Deriv WS for markets sync');
                ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
            });

            ws.on('message', async (data) => {
                try {
                    const response = JSON.parse(data.toString());

                    if (response.error) {
                        this.logger.error(`Deriv API Error: ${JSON.stringify(response.error)}`);
                        ws.close();
                        reject(new Error(response.error.message));
                        return;
                    }

                    if (response.active_symbols) {
                        const symbols = response.active_symbols;
                        this.logger.log(`Received ${symbols.length} symbols from Deriv`);

                        let count = 0;

                        for (const symbol of symbols) {
                            // Basic upsert logic
                            // Check if exists
                            let market = await this.marketRepository.findOne({ where: { symbol: symbol.symbol } });

                            if (!market) {
                                market = new MarketEntity();
                                market.symbol = symbol.symbol;
                            }

                            market.displayName = symbol.display_name;
                            market.market = symbol.market;
                            market.marketDisplayName = symbol.market_display_name;
                            market.submarket = symbol.submarket;
                            market.submarketDisplayName = symbol.submarket_display_name;
                            market.isActive = symbol.exchange_is_open === 1 || symbol.exchange_is_open === true;
                            // Note: exchange_is_open might be 0/1 or boolean. API docs say 0/1 usually.
                            // Actually active_symbols doesn't strictly have is_active for the symbol availability globally, 
                            // usually 'exchange_is_open' refers to current market status. 
                            // We'll assume if it's in active_symbols, it's a valid market.
                            // Let's stick strictly to what we have or default to true for availability in our system.

                            await this.marketRepository.save(market);
                            count++;
                        }

                        ws.close();
                        resolve({ count, message: `Successfully synced ${count} markets` });
                    }
                } catch (error) {
                    this.logger.error(`Error processing Deriv response: ${error.message}`);
                    ws.close();
                    reject(error);
                }
            });

            ws.on('error', (error) => {
                this.logger.error(`WebSocket Error: ${error.message}`);
                reject(error);
            });
        });
    }
}
