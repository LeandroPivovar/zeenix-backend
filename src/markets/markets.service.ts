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
            let activeSymbols: any[] = [];
            let processedCount = 0;
            let totalSymbols = 0;

            ws.on('open', () => {
                this.logger.log('Connected to Deriv WS for markets sync');
                ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
            });

            ws.on('message', async (data) => {
                try {
                    const response = JSON.parse(data.toString());

                    if (response.error) {
                        this.logger.error(`Deriv API Error: ${JSON.stringify(response.error)}`);
                        // Don't close immediately if it's just one contract_for error
                        if (response.msg_type === 'active_symbols') {
                            ws.close();
                            reject(new Error(response.error.message));
                        }
                        return;
                    }

                    if (response.msg_type === 'active_symbols') {
                        activeSymbols = response.active_symbols;
                        this.logger.log(`Received ${activeSymbols.length} symbols. Starting contract details fetch...`);
                        totalSymbols = activeSymbols.length;

                        // Process symbols sequentially to avoid rate limits
                        this.processSymbolsSequentially(ws, activeSymbols, resolve, reject);
                    } else if (response.msg_type === 'contracts_for') {
                        // Handle contracts_for response
                        // This part is tricky with a single listener if we don't have request IDs.
                        // However, we process sequentially, so we can assume the incoming message matches the current request if we are careful.
                        // But strictly speaking, we should use req_id.
                        // For simplicity in this "script-like" service method:
                        // We will handle the persistence inside the sequential processor's callback or here if we map it.
                        // Actually, 'processSymbolsSequentially' will handle the flow.
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

    private async processSymbolsSequentially(ws: WebSocket, symbols: any[], resolve: any, reject: any) {
        let count = 0;

        // Create a map to store pending requests if we were doing parallel, but for sequential:
        for (const symbol of symbols) {
            try {
                // Upsert basic info
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

                // Fetch operations
                const operations = await this.fetchOperationsForSymbol(ws, symbol.symbol);
                market.operations = operations;

                await this.marketRepository.save(market);
                count++;

                // Small delay to respect rate limits (e.g., 200ms)
                await new Promise(r => setTimeout(r, 200));

                if (count % 10 === 0) {
                    this.logger.log(`Processed ${count}/${symbols.length} markets...`);
                }

            } catch (err) {
                this.logger.error(`Failed to process symbol ${symbol.symbol}: ${err.message}`);
                // Continue to next symbol
            }
        }

        ws.close();
        resolve({ count, message: `Successfully synced ${count} markets with operations` });
    }

    private fetchOperationsForSymbol(ws: WebSocket, symbol: string): Promise<string[]> {
        return new Promise((resolve) => {
            const reqId = Math.floor(Math.random() * 100000);

            // Create a one-time listener for this specific request
            const listener = (data: any) => {
                try {
                    const response = JSON.parse(data.toString());
                    if (response.req_id === reqId) {
                        ws.removeListener('message', listener);

                        if (response.error) {
                            this.logger.warn(`Error fetching contracts for ${symbol}: ${response.error.message}`);
                            resolve([]);
                            return;
                        }

                        if (response.contracts_for && response.contracts_for.available) {
                            const contracts = response.contracts_for.available;
                            // Extract unique contract categories or display names
                            const availableOperations = [...new Set(contracts.map((c: any) => c.contract_category_display || c.contract_category))];
                            resolve(availableOperations as string[]);
                        } else {
                            resolve([]);
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors here, main listener handles them or they are from other messages
                }
            };

            ws.on('message', listener);
            ws.send(JSON.stringify({ contracts_for: symbol, req_id: reqId }));

            // Timeout fallback
            setTimeout(() => {
                ws.removeListener('message', listener);
                resolve([]);
            }, 5000);
        });
    }
}
