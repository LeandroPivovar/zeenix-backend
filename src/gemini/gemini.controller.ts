import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GeminiService } from './gemini.service';

interface TickDto {
  value: number;
  epoch: number;
}

interface GetRecommendationDto {
  ticks: TickDto[];
  symbol: string;
  tradeType: string;
  duration: number;
  durationUnit: string;
  amount: number;
  multiplier?: number;
}

@Controller('gemini')
export class GeminiController {
  constructor(private readonly geminiService: GeminiService) { }

  @Post('recommendation')
  @UseGuards(AuthGuard('jwt'))
  async getRecommendation(@Body() body: GetRecommendationDto) {
    if (!body.ticks || !Array.isArray(body.ticks) || body.ticks.length === 0) {
      return {
        error: 'É necessário fornecer pelo menos um tick',
        action: 'CALL',
        confidence: 50
      };
    }

    // Pegar os últimos 50 ticks
    const last50Ticks = body.ticks.slice(-50);

    const recommendation = await this.geminiService.getTradingRecommendation(
      last50Ticks,
      body.symbol,
      body.tradeType,
      body.duration,
      body.durationUnit,
      body.amount,
      body.multiplier
    );

    return recommendation;
  }
}

