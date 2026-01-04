import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiService, DigitParity, Tick } from './ai.service';
import { TradeEventsService } from './trade-events.service';
import { Observable } from 'rxjs';

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiService: AiService,
    private readonly tradeEventsService: TradeEventsService,
  ) { }

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
  getTicks(@Query('limit') limit?: string, @Query('count') count?: string): {
    success: boolean;
    data: {
      ticks: Tick[];
      currentPrice: number | null;
      statistics: any;
      status: any;
    };
  } {
    let ticks = this.aiService.getTicks();
    const currentPrice = this.aiService.getCurrentPrice();
    const statistics = this.aiService.getStatistics();
    const status = this.aiService.getStatus();

    // Priorizar 'count' se fornecido, senão usar 'limit' (compatibilidade)
    const limitValue = count || limit;

    // Se um limite foi especificado, retornar apenas os últimos N ticks
    if (limitValue) {
      const limitNum = parseInt(limitValue, 10);
      if (!isNaN(limitNum) && limitNum > 0) {
        ticks = ticks.slice(-limitNum);
      }
    }

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
  async analyzeAndGetSignal(@Body() body: { userId: string }) {
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
      userId: string;
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
  @UseGuards(AuthGuard('jwt'))
  async getSessionStats(@Param('userId') userId: string, @Req() req: any) {
    try {
      // Se userId for "current", usar o userId do token JWT
      const finalUserId = userId === 'current' ? req.user.userId : userId;
      const stats = await this.aiService.getSessionStats(finalUserId);
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
      this.logger.log(`[TradeHistory] 📊 Buscando histórico para userId: ${userId}`);
      const history = await this.aiService.getTradeHistory(userId);
      this.logger.log(`[TradeHistory] ✅ Encontradas ${history.length} operações`);

      // ✅ DEBUG: Logar primeiros 3 trades com preços
      if (history.length > 0) {
        history.slice(0, 3).forEach((trade: any, index: number) => {
          this.logger.debug(`[TradeHistory] Trade ${index + 1}: id=${trade.id}, entryPrice=${trade.entryPrice}, exitPrice=${trade.exitPrice}, status=${trade.status}`);
        });
      }

      return {
        success: true,
        data: history,
      };
    } catch (error) {
      this.logger.error(`[TradeHistory] ❌ Erro ao buscar histórico: ${error.message}`);
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

  @Sse('trade-events/:userId')
  tradeEvents(
    @Param('userId') userId: string,
    @Query('strategy') strategy?: string,
  ): Observable<MessageEvent> {
    return this.tradeEventsService.subscribe(userId, strategy);
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
      userId: string;
      stakeAmount: number; // Capital total da conta
      entryValue?: number; // ✅ Valor de entrada por operação (opcional)
      derivToken: string;
      currency: string;
      mode?: string;
      profitTarget?: number;
      lossLimit?: number;
      modoMartingale?: 'conservador' | 'moderado' | 'agressivo';
      strategy?: string;
      stopLossBlindado?: boolean; // ✅ ZENIX v2.0: Stop-Loss Blindado (true = ativado com 50%, false = desativado)
      symbol?: string; // ✅ ZENIX v2.0: Símbolo/Ativo (opcional)
      selectedMarket?: string; // ✅ ZENIX v2.0: Mercado (opcional)
    },
  ) {
    try {
      this.logger.log(`[ActivateAI] Recebido: mode=${body.mode}, modoMartingale=${body.modoMartingale}, strategy=${body.strategy}, stopLossBlindado=${body.stopLossBlindado}, symbol=${body.symbol || body.selectedMarket}`);

      await this.aiService.activateUserAI(
        body.userId,
        body.stakeAmount, // Capital total da conta
        body.derivToken,
        body.currency,
        body.mode || 'veloz',
        body.profitTarget,
        body.lossLimit,
        body.modoMartingale || 'conservador',
        body.strategy || 'orion',
        body.entryValue, // ✅ Valor de entrada por operação (opcional)
        body.stopLossBlindado, // ✅ ZENIX v2.0: Stop-Loss Blindado
        body.symbol || body.selectedMarket, // ✅ ZENIX v2.0: Símbolo
      );
      return {
        success: true,
        message: `IA ativada com sucesso | Modo: ${body.mode || 'veloz'} | Martingale: ${body.modoMartingale || 'conservador'} | Estratégia: ${body.strategy || 'orion'}`,
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
  async deactivateAI(@Body() body: { userId: string }) {
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

  @Get('logs/:userId')
  async getUserLogs(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
  ) {
    try {
      // Converter limit para número
      // Se não especificado ou vazio, usar padrão 100
      // Se for 'todos', passar undefined (sem limite)
      // Caso contrário, converter para número
      let limitNum: number | undefined = 100; // Padrão: 100
      if (limit) {
        if (limit.toLowerCase() === 'todos') {
          limitNum = undefined; // Sem limite
        } else {
          const parsed = parseInt(limit, 10);
          if (!isNaN(parsed) && parsed > 0) {
            limitNum = parsed;
          }
        }
      }

      const logs = await this.aiService.getUserLogs(userId, limitNum);
      return {
        success: true,
        data: logs,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar logs',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('logs/:userId')
  async deleteUserLogs(@Param('userId') userId: string) {
    try {
      await this.aiService.deleteUserLogs(userId);
      return {
        success: true,
        message: 'Logs deletados com sucesso',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao deletar logs',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('config/:userId')
  async getAIConfig(@Param('userId') userId: string) {
    try {
      const config = await this.aiService.getUserAIConfig(userId);
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
      userId: string;
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

  @Post('deriv-balance')
  async getDerivBalance(@Body() body: { derivToken: string }) {
    try {
      const balance = await this.aiService.getDerivBalance(body.derivToken);
      return {
        success: true,
        data: balance,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar saldo da Deriv',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('user-dashboard/:userId')
  async getUserDashboard(@Param('userId') userId: string) {
    try {
      const stats = await this.aiService.getUserDashboardStats(userId);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas do usuário',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('sessions/:userId')
  async getUserSessions(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const limitNumber = limit ? parseInt(limit, 10) : 10;
      this.logger.log(`[SessionsHistory] 📊 Buscando histórico de sessões para userId: ${userId}, limit: ${limitNumber}`);
      const sessions = await this.aiService.getUserSessions(userId, limitNumber);
      this.logger.log(`[SessionsHistory] ✅ ${sessions.length} sessões encontradas`);
      return {
        success: true,
        data: sessions,
      };
    } catch (error) {
      this.logger.error(`[SessionsHistory] ❌ Erro ao buscar histórico: ${error.message}`);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar histórico de sessões',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

