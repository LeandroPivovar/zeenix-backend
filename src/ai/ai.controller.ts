import { 
  Controller, 
  Get, 
  Post, 
  Body,
  HttpException, 
  HttpStatus 
} from '@nestjs/common';
import { AiService, Tick } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('start')
  async startMonitoring() {
    try {
      await this.aiService.initialize();
      return {
        success: true,
        message: 'Monitoramento iniciado com sucesso',
        status: this.aiService.getStatus(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao iniciar monitoramento',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('stop')
  stopMonitoring() {
    this.aiService.disconnect();
    return {
      success: true,
      message: 'Monitoramento parado com sucesso',
    };
  }

  @Get('ticks')
  getTicks(): {
    success: boolean;
    data: {
      ticks: Tick[];
      currentPrice: number | null;
      statistics: any;
      status: any;
    };
  } {
    const ticks = this.aiService.getTicks();
    const currentPrice = this.aiService.getCurrentPrice();
    const statistics = this.aiService.getStatistics();
    const status = this.aiService.getStatus();

    return {
      success: true,
      data: {
        ticks,
        currentPrice,
        statistics,
        status,
      },
    };
  }

  @Get('status')
  getStatus() {
    return {
      success: true,
      data: this.aiService.getStatus(),
    };
  }

  @Get('current-price')
  getCurrentPrice() {
    const currentPrice = this.aiService.getCurrentPrice();
    
    if (currentPrice === null) {
      throw new HttpException(
        {
          success: false,
          message: 'Nenhum preço disponível ainda',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      success: true,
      data: {
        currentPrice,
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Post('analyze')
  async analyzeAndGetSignal(@Body() body: { userId: number }) {
    try {
      const signal = await this.aiService.analyzeWithGemini(body.userId);
      return {
        success: true,
        data: signal,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao analisar com Gemini',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('execute-trade')
  async executeTrade(
    @Body() body: { 
      userId: number; 
      signal: any; 
      stakeAmount: number; 
      derivToken: string 
    }
  ) {
    try {
      const tradeId = await this.aiService.executeTrade(
        body.userId,
        body.signal,
        body.stakeAmount,
        body.derivToken,
      );

      return {
        success: true,
        data: {
          tradeId,
          message: 'Trade executado com sucesso',
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao executar trade',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('active-trade')
  async getActiveTrade() {
    try {
      const trade = await this.aiService.getActiveTrade();
      
      return {
        success: true,
        data: trade,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar trade ativo',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('trading-status')
  getTradingStatus() {
    return {
      success: true,
      data: {
        isTrading: this.aiService.getIsTrading(),
      },
    };
  }
}

