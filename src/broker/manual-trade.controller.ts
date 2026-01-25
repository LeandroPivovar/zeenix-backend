import {
    Controller,
    Post,
    Body,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { TradeEntity, TradeType, TradeStatus } from '../infrastructure/database/entities/trade.entity';
import { v4 as uuidv4 } from 'uuid';
import { CopyTradingService } from '../copy-trading/copy-trading.service';
import { UserEntity } from '../infrastructure/database/entities/user.entity';

@Controller('broker/manual-trade')
export class ManualTradeController {
    private readonly logger = new Logger(ManualTradeController.name);

    constructor(
        @InjectRepository(TradeEntity)
        private readonly tradeRepository: Repository<TradeEntity>,
        @InjectRepository(UserEntity)
        private readonly userRepository: Repository<UserEntity>,
        private readonly copyTradingService: CopyTradingService,
        private readonly dataSource: DataSource,
    ) { }

    @Post('notify/buy')
    @UseGuards(AuthGuard('jwt'))
    @HttpCode(HttpStatus.OK)
    async notifyBuy(@Body() body: any, @Req() req: any) {
        const userId = req.user.userId;
        this.logger.log(`[ManualTrade] Recording buyer notified by frontend for user ${userId}`);

        try {
            const trade = this.tradeRepository.create({
                id: uuidv4(),
                userId,
                contractType: body.contractType || 'CALL',
                timeType: body.durationUnit === 't' ? 'tick' : 'time',
                duration: String(body.duration || 1),
                multiplier: 1.00,
                entryValue: body.buyPrice || 0,
                entrySpot: body.entrySpot ? Number(body.entrySpot) : null,
                tradeType: TradeType.BUY,
                status: TradeStatus.PENDING,
                derivTransactionId: body.contractId ? String(body.contractId) : null,
                symbol: body.symbol || null,
            });

            const savedTrade = await this.tradeRepository.save(trade);
            this.logger.log(`[ManualTrade] Trade recorded: ${savedTrade.id}, contractId: ${savedTrade.derivTransactionId}`);

            // Replicar para copiadores se for master
            try {
                const isMasterTrader = await this.copyTradingService.isMasterTrader(userId);
                if (isMasterTrader) {
                    const user = await this.userRepository.findOne({ where: { id: userId } });
                    const userBalance = user?.derivBalance ? parseFloat(user.derivBalance) : 0;
                    const percent = userBalance > 0 ? ((body.buyPrice || 0) / userBalance) * 100 : 0;

                    // ✅ [FIX] Salvar na tabela master_trader_operations para exibição no feed/social
                    try {
                        await this.dataSource.query(
                            `INSERT INTO master_trader_operations 
                             (trader_id, symbol, contract_type, barrier, stake, percent, multiplier, duration, duration_unit, trade_type, status, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                            [
                                userId,
                                body.symbol || 'R_100',
                                body.contractType || 'CALL',
                                body.barrier || 0.1,
                                body.buyPrice || 0,
                                percent,
                                1.00, // multiplier
                                body.duration || 1,
                                body.durationUnit || 'm',
                                (body.contractType || 'CALL').includes('CALL') || (body.contractType || '').includes('RISE') ? 'CALL' : 'PUT',
                                'OPEN'
                            ]
                        );
                        this.logger.log(`[ManualTrade] Master operation recorded in master_trader_operations for user ${userId}`);
                    } catch (dbErr) {
                        this.logger.error(`[ManualTrade] Error inserting into master_trader_operations: ${dbErr.message}`);
                    }

                    await this.copyTradingService.replicateManualOperation(userId, {
                        contractId: body.contractId,
                        contractType: body.contractType || 'CALL',
                        symbol: body.symbol,
                        duration: body.duration || 1,
                        durationUnit: body.durationUnit || 'm',
                        stakeAmount: body.buyPrice || 0,
                        percent: percent,
                        entrySpot: body.entrySpot || 0,
                        entryTime: body.entryTime || Math.floor(Date.now() / 1000),
                        barrier: body.barrier || 0.1,
                    });
                }
            } catch (err) {
                this.logger.error(`[ManualTrade] Error in master replication: ${err.message}`);
            }

            return { success: true, tradeId: savedTrade.id };
        } catch (error) {
            this.logger.error(`[ManualTrade] Error recording buy: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    @Post('notify/end')
    @UseGuards(AuthGuard('jwt'))
    @HttpCode(HttpStatus.OK)
    async notifyEnd(@Body() body: any, @Req() req: any) {
        const userId = req.user.userId;
        const contractId = String(body.contractId);
        this.logger.log(`[ManualTrade] Recording result notified by frontend for user ${userId}, contract: ${contractId}`);

        try {
            const trade = await this.tradeRepository.findOne({
                where: { derivTransactionId: contractId, userId },
                order: { createdAt: 'DESC' },
            });

            if (!trade) {
                this.logger.warn(`[ManualTrade] Trade not found for contractId: ${contractId}`);
                return { success: false, message: 'Trade not found' };
            }

            trade.profit = body.profit !== undefined ? Number(body.profit) : trade.profit;
            trade.exitValue = body.sellPrice !== undefined ? Number(body.sellPrice) : trade.exitValue;
            trade.exitSpot = body.exitSpot !== undefined ? Number(body.exitSpot) : trade.exitSpot;

            if (trade.profit !== null && trade.profit !== undefined) {
                trade.status = trade.profit > 0 ? TradeStatus.WON : TradeStatus.LOST;
            }

            const savedTrade = await this.tradeRepository.save(trade);
            this.logger.log(`[ManualTrade] Trade result updated: ${savedTrade.id}, result: ${savedTrade.status}`);

            // Atualizar estatísticas de copy trading se master
            try {
                const isMasterTrader = await this.copyTradingService.isMasterTrader(userId);
                if (isMasterTrader && trade.status !== TradeStatus.PENDING) {
                    const result = trade.status === TradeStatus.WON ? 'win' : 'loss';

                    // ✅ [FIX] Atualizar o registro do Master Trader na tabela master_trader_operations
                    try {
                        await this.dataSource.query(
                            `UPDATE master_trader_operations 
                             SET status = 'CLOSED', result = ?, profit = ?
                             WHERE trader_id = ? AND status = 'OPEN' AND symbol = ?
                             ORDER BY created_at DESC LIMIT 1`,
                            [result, Number(trade.profit || 0), userId, trade.symbol]
                        );
                        this.logger.log(`[ManualTrade] Master operation updated in master_trader_operations for user ${userId}`);
                    } catch (dbErr) {
                        this.logger.error(`[ManualTrade] Error updating master_trader_operations: ${dbErr.message}`);
                    }

                    await this.copyTradingService.updateCopyTradingOperationsResult(
                        userId,
                        contractId,
                        result,
                        Number(trade.profit || 0),
                        Number(trade.entryValue || 0)
                    );
                }
            } catch (err) {
                this.logger.error(`[ManualTrade] Error updating master stats: ${err.message}`);
            }

            return { success: true };
        } catch (error) {
            this.logger.error(`[ManualTrade] Error recording end: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}
