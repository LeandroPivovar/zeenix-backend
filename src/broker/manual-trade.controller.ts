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
                                body.barrier, // Removido o default de 0.1
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

                    // ✅ [ZENIX v4.0] Cópia direta no controller para evitar barreira forçada e garantir autonomia
                    try {
                        const copiers = await this.dataSource.query(
                            `SELECT 
                                c.*, 
                                u.token_demo, 
                                u.token_real, 
                                u.real_amount, 
                                u.demo_amount,
                                u.deriv_raw, 
                                s.trade_currency, 
                                css.id as session_id
                             FROM copy_trading_config c
                             JOIN users u ON c.user_id = u.id
                             LEFT JOIN user_settings s ON c.user_id = s.user_id
                             JOIN copy_trading_sessions css ON css.user_id = c.user_id AND css.status = 'active'
                             WHERE c.trader_id = ? AND c.is_active = 1 AND c.session_status = 'active'`,
                            [userId],
                        );

                        if (copiers && copiers.length > 0) {
                            this.logger.log(`[ManualTrade] Replicando para ${copiers.length} copiadores (Sem barreira forçada)`);

                            for (const copier of copiers) {
                                // Resolver token do copiador
                                let copierToken = null;
                                const currencyPref = (copier.trade_currency || 'USD').toUpperCase();
                                if (currencyPref === 'DEMO') {
                                    copierToken = copier.token_demo;
                                } else {
                                    copierToken = copier.token_real;
                                }
                                if (!copierToken) copierToken = copier.deriv_token;
                                if (!copierToken) continue;

                                // Calcular Stake
                                let copierStake = 0;
                                if (copier.allocation_type === 'proportion') {
                                    const userBalance = currencyPref === 'DEMO'
                                        ? parseFloat(copier.demo_amount || 0)
                                        : parseFloat(copier.real_amount || 0);
                                    copierStake = (userBalance * percent) / 100;
                                } else {
                                    copierStake = body.buyPrice || 0;
                                }
                                copierStake = Math.round(copierStake * 100) / 100;
                                if (copierStake <= 0) copierStake = 0.35;

                                const entryTime = body.entryTime || Math.floor(Date.now() / 1000);

                                // Executar trade para o copiador
                                this.copyTradingService.executeCopierTrade(copier.user_id, {
                                    symbol: body.symbol,
                                    contractType: body.contractType || 'CALL',
                                    duration: body.duration || 1,
                                    durationUnit: body.durationUnit || 'm',
                                    stakeAmount: copierStake,
                                    derivToken: copierToken,
                                    barrier: body.barrier // Passado diretamente (undefined se não houver)
                                }).then(async (copierContractId) => {
                                    if (copierContractId) {
                                        try {
                                            await this.dataSource.query(
                                                `INSERT INTO copy_trading_operations 
                                                (session_id, user_id, trader_operation_id, operation_type, barrier, symbol, duration,
                                                 stake_amount, result, profit, leverage, allocation_type, allocation_value,
                                                 executed_at)
                                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
                                                [
                                                    copier.session_id,
                                                    copier.user_id,
                                                    body.contractId,
                                                    body.contractType || 'CALL',
                                                    body.barrier,
                                                    body.symbol,
                                                    body.duration || 1,
                                                    copierStake,
                                                    'pending',
                                                    0,
                                                    '1x',
                                                    copier.allocation_type,
                                                    copier.allocation_value,
                                                    entryTime
                                                ]
                                            );
                                            await this.dataSource.query(
                                                `UPDATE copy_trading_sessions 
                                                SET total_operations = total_operations + 1, last_operation_at = NOW()
                                                WHERE id = ?`,
                                                [copier.session_id]
                                            );
                                        } catch (dbErr) {
                                            this.logger.error(`[ManualTrade] Error saving copier operation: ${dbErr.message}`);
                                        }
                                    }
                                }).catch(err => {
                                    this.logger.error(`[ManualTrade] Execution error for copier ${copier.user_id}: ${err.message}`);
                                });
                            }
                        }
                    } catch (replErr) {
                        this.logger.error(`[ManualTrade] Error in direct replication: ${replErr.message}`);
                    }
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
