import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GeminiService } from './gemini.service';

interface TickDto {
  value: number;
  epoch: number;
}

interface GetRecommendationDto {
  ticks: TickDto[];
}

@Controller('gemini')
export class GeminiController {
  constructor(private readonly geminiService: GeminiService) {}

  @Post('recommendation')
  @UseGuards(AuthGuard('jwt'))
  async getRecommendation(@Body() body: GetRecommendationDto) {
    if (!body.ticks || !Array.isArray(body.ticks) || body.ticks.length === 0) {
      return {
        error: 'É necessário fornecer pelo menos um tick',
        action: 'CALL',
        confidence: 50,
      };
    }

    // Pegar os últimos 10 ticks
    const last10Ticks = body.ticks.slice(-10);

    const recommendation =
      await this.geminiService.getTradingRecommendation(last10Ticks);

    return recommendation;
  }
}
