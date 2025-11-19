import { 
  Controller, 
  Get, 
  Post, 
  Body,
  Param,
  HttpException, 
  HttpStatus 
} from '@nestjs/common';
import { AiService, DigitParity, Tick } from './ai.service';

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

  private normalizeOperation(value: string): DigitParity {
    const sanitized = value
      .toString()
      .trim()
      .toUpperCase()
      .replace('Í', 'I');

    if (['PAR', 'DIGITEVEN', 'EVEN'].includes(sanitized)) {
      return 'PAR';
    }

    if (['IMPAR', 'DIGITODD', 'ODD'].includes(sanitized)) {
      return 'IMPAR';
    }

    throw new Error(`Operação inválida (${value}). Utilize PAR ou ÍMPAR.`);
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
      const diagnostics = await this.aiService.getVelozDiagnostics(body.userId);
      return {
        success: true,
        data: diagnostics,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao analisar setup veloz',
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
      operation?: DigitParity | 'DIGITEVEN' | 'DIGITODD' | 'even' | 'odd';
      signal?: { signal?: string; operation?: string };
    }
  ) {
    try {
      const requestedOperation =
        body.operation ||
        body.signal?.operation ||
        body.signal?.signal;

      if (!requestedOperation) {
        throw new Error('operation (PAR/IMPAR) é obrigatório no modo veloz');
      }

      const normalized = this.normalizeOperation(requestedOperation);

      const tradeId = await this.aiService.triggerManualVelozOperation(
        body.userId,
        normalized,
      );

      return {
        success: true,
        data: {
          tradeId,
          message: `Operação veloz ${normalized} enviada com sucesso`,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao executar operação veloz',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('session-stats/:userId')
  async getSessionStats(@Param('userId') userId: string) {
    try {
      const stats = await this.aiService.getSessionStats(parseInt(userId));
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas da sessão',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('trade-history/:userId')
  async getTradeHistory(@Param('userId') userId: string) {
    try {
      const history = await this.aiService.getTradeHistory(parseInt(userId));
      return {
        success: true,
        data: history,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar histórico de trades',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ========== ENDPOINTS PARA IA EM BACKGROUND ==========

  @Post('init-tables')
  async initTables() {
    try {
      await this.aiService.initializeTables();
      return {
        success: true,
        message: 'Tabelas da IA inicializadas com sucesso',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao inicializar tabelas',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('activate')
  async activateAI(
    @Body() body: {
      userId: number;
      stakeAmount: number;
      derivToken: string;
      currency: string;
      mode?: string;
      profitTarget?: number;
      lossLimit?: number;
    },
  ) {
    try {
      await this.aiService.activateUserAI(
        body.userId,
        body.stakeAmount,
        body.derivToken,
        body.currency,
        body.mode || 'veloz',
        body.profitTarget,
        body.lossLimit,
      );
      return {
        success: true,
        message: `IA ativada com sucesso no modo ${body.mode || 'veloz'}. Executando em background.`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao ativar IA',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('deactivate')
  async deactivateAI(@Body() body: { userId: number }) {
    try {
      await this.aiService.deactivateUserAI(body.userId);
      return {
        success: true,
        message: 'IA desativada com sucesso',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao desativar IA',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('config/:userId')
  async getAIConfig(@Param('userId') userId: string) {
    try {
      const config = await this.aiService.getUserAIConfig(Number(userId));
      return {
        success: true,
        data: config,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar configuração da IA',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('active-users')
  async getActiveUsers() {
    try {
      const activeUsers = await this.aiService.getActiveUsersCount();
      return {
        success: true,
        data: {
          count: activeUsers,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar usuários ativos',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ========== ENDPOINTS PARA STATSIAS ==========

  @Get('stats-ias')
  async getStatsIAs() {
    try {
      const result = await this.aiService.getStatsIAsData();
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas do StatsIAs',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('trading-params')
  async getTradingParams() {
    try {
      const params = await this.aiService.getAdjustedTradingParams();
      return {
        success: true,
        data: params,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar parâmetros de trading ajustados',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('update-config')
  async updateAIConfig(
    @Body() body: {
      userId: number;
      stakeAmount?: number;
    },
  ) {
    try {
      await this.aiService.updateUserAIConfig(
        body.userId,
        body.stakeAmount,
      );
      return {
        success: true,
        message: 'Configuração da IA atualizada com sucesso',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao atualizar configuração da IA',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

