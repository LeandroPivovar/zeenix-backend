import { Controller, Get, Post, Body, UseGuards, Req, Query, Sse, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsEnum, IsNumber, Min, Max, IsOptional } from 'class-validator';
import { TradesService, CreateTradeDto } from './trades.service';
import { TradeType } from '../infrastructure/database/entities/trade.entity';

class CreateTradeRequestDto implements CreateTradeDto {
  @IsString()
  contractType: string;

  @IsString()
  timeType: string;

  @IsString()
  duration: string;

  @IsNumber()
  @Min(1)
  @Max(1000)
  multiplier: number;

  @IsNumber()
  @Min(1)
  entryValue: number;

  @IsEnum(TradeType)
  tradeType: TradeType;
}

@Controller('trades')
@UseGuards(AuthGuard('jwt'))
export class TradesController {
  constructor(private readonly tradesService: TradesService) { }

  @Post()
  async createTrade(@Req() req: any, @Body() body: CreateTradeRequestDto) {
    const userId = req.user.userId;
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    return await this.tradesService.createTrade(userId, body, ipAddress, userAgent);
  }

  @Get()
  async getUserTrades(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getUserTrades(userId);
  }

  @Get('recent')
  async getRecentTrades(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getRecentTrades(userId);
  }

  @Get('today-profit')
  async getTodayProfitLoss(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getTodayProfitLoss(userId);
  }

  @Get('markup')
  async getMarkupData(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('targetUserId') targetUserId?: string,
  ) {
    // Se targetUserId for fornecido, usa ele. Senão, usa o ID do usuário logado (token)
    const contextUserId = targetUserId || req.user.userId;
    return await this.tradesService.getMarkupData(contextUserId, startDate, endDate);
  }
  @Sse('markup/stream')
  sse(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Observable<MessageEvent> {
    return this.tradesService.getMarkupDataStream(startDate, endDate);
  }
}



