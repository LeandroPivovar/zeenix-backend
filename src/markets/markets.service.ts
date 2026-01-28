import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketEntity } from '../infrastructure/database/entities/market.entity';
import { MarketContractEntity } from '../infrastructure/database/entities/market-contract.entity';
import WebSocket from 'ws';

@Injectable()
export class MarketsService {
    private readonly logger = new Logger(MarketsService.name);

    constructor(
        @InjectRepository(MarketEntity)
        private readonly marketRepository: Repository<MarketEntity>,
        @InjectRepository(MarketContractEntity)
        private readonly marketContractRepository: Repository<MarketContractEntity>,
    ) { }

    async findAll(): Promise<MarketEntity[]> {
        // Now we can fetch with relations if needed, or stick to basic info for the list
        // Maybe we want to load 'contracts' too? The frontend 'markets' list included 'operations'
        // We should map the new contracts relation back to 'operations' JSON or return the relation.
        // For now, let's keep returning the MarketEntity, but we might want to populate 'operations' 
        // with the contract types for backward compatibility or frontend ease.
        const markets = await this.marketRepository.find({
            order: { displayName: 'ASC' },
            relations: ['contracts'] // Assuming we add this relation to MarketEntity
        });

        // Populate the legacy 'operations' column if it's null, or just rely on frontend handling relations
        // If the frontend expects 'operations' as array of strings in the JSON response:
        markets.forEach(m => {
            if (m.contracts && m.contracts.length > 0) {
                // Update the operations column on the fly for the response if needed, 
                // or ensure it's saved in syncMarkets. 
                // We will update syncMarkets to save both for redundancy/ease.
                m.operations = [...new Set(m.contracts.map(c => c.contractType))];
            }
        });

        return markets;
    }

    async syncMarkets(): Promise<{ count: number; message: string }> {
        const appId = 1089; // Default Deriv App ID
        const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            let activeSymbols: any[] = [];
            let count = 0;

            ws.on('open', () => {
                this.logger.log('Connected to Deriv WS for markets sync');
                ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
            });

            ws.on('message', async (data) => {
                try {
                    const response = JSON.parse(data.toString());

                    if (response.error) {
                        this.logger.error(`Deriv API Error: ${JSON.stringify(response.error)}`);
                        if (response.msg_type === 'active_symbols') {
                            ws.close();
                            reject(new Error(response.error.message));
                        }
                        return;
                    }

                    if (response.msg_type === 'active_symbols') {
                        activeSymbols = response.active_symbols;
                        this.logger.log(`Received ${activeSymbols.length} symbols. Starting detailed contract fetch...`);

                        // Process symbols sequentially
                        await this.processSymbolsSequentially(ws, activeSymbols);

                        ws.close();
                        resolve({ count: activeSymbols.length, message: `Successfully synced ${activeSymbols.length} markets and contracts` });
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

    private async processSymbolsSequentially(ws: WebSocket, symbols: any[]) {
        let count = 0;

        for (const symbol of symbols) {
            try {
                // 1. Upsert Market
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

                // 2. Fetch Detailed Contracts
                const contractsData = await this.fetchContractsData(ws, symbol.symbol);

                // 3. Save Market first (to ensure ID/Symbol exists for relation)
                // We typically use symbol as FK.
                market.operations = [...new Set(contractsData.map(c => c.contract_type))]; // simplified for legacy column
                await this.marketRepository.save(market);

                // 4. Update MarketContracts Table
                if (contractsData.length > 0) {
                    // Delete existing contracts for this market to avoid stale data
                    await this.marketContractRepository.delete({ marketSymbol: symbol.symbol });

                    // Bulk insert new contracts
                    const contractEntities = contractsData.map(c => {
                        const entity = new MarketContractEntity();
                        entity.marketSymbol = symbol.symbol;
                        entity.contractType = c.contract_type;
                        entity.contractCategory = c.contract_category;
                        entity.contractDisplay = c.contract_display;
                        entity.minContractDuration = c.min_contract_duration;
                        entity.maxContractDuration = c.max_contract_duration;
                        entity.sentiment = c.sentiment;
                        entity.barriers = c.barriers;
                        entity.exchangeName = c.exchange_name;
                        entity.market = c.market;
                        entity.submarket = c.submarket;
                        entity.payload = c; // Store full object
                        return entity;
                    });

                    await this.marketContractRepository.save(contractEntities);
                }

                count++;
                // Small delay
                await new Promise(r => setTimeout(r, 200));

                if (count % 10 === 0) {
                    this.logger.log(`Processed ${count}/${symbols.length} markets...`);
                }

            } catch (err) {
                this.logger.error(`Failed to process symbol ${symbol.symbol}: ${err.message}`);
            }
        }
    }

    private fetchContractsData(ws: WebSocket, symbol: string): Promise<any[]> {
        return new Promise((resolve) => {
            const reqId = Math.floor(Math.random() * 100000);

            const listener = (data: any) => {
                try {
                    const response = JSON.parse(data.toString());
                    if (response.req_id === reqId) {
                        ws.removeListener('message', listener);

                        if (response.error) {
                            // this.logger.warn(`Error fetching contracts for ${symbol}: ${response.error.message}`);
                            resolve([]);
                            return;
                        }

                        if (response.contracts_for && response.contracts_for.available) {
                            resolve(response.contracts_for.available);
                        } else {
                            resolve([]);
                        }
                    }
                } catch (e) { }
            };

            ws.on('message', listener);
            ws.send(JSON.stringify({ contracts_for: symbol, req_id: reqId }));

            setTimeout(() => {
                ws.removeListener('message', listener);
                resolve([]);
            }, 5000);
        });
    }
}
