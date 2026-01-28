import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketsService } from './markets.service';
import { MarketsController } from './markets.controller';
import { MarketEntity } from '../infrastructure/database/entities/market.entity';

import { MarketContractEntity } from '../infrastructure/database/entities/market-contract.entity';

@Module({
    imports: [TypeOrmModule.forFeature([MarketEntity, MarketContractEntity])],
    controllers: [MarketsController],
    providers: [MarketsService],
    exports: [MarketsService],
})
export class MarketsModule { }
