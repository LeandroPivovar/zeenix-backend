import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { AutonomousAgentService } from './autonomous-agent.service';
import { AutonomousAgentLogsStreamService } from './autonomous-agent-logs-stream.service';

@Controller('autonomous-agent')
export class AutonomousAgentController {
  private readonly logger = new Logger(AutonomousAgentController.name);

  constructor(
    private readonly agentService: AutonomousAgentService,
    private readonly logsStreamService: AutonomousAgentLogsStreamService,
  ) { }

  @Post('activate')
  @UseGuards(AuthGuard('jwt'))
  async activateAgent(@Body() body: any, @Req() req: any) {
    try {
      const userId = req.user?.userId || body.userId;

      if (!userId) {
        throw new HttpException('User ID é obrigatório', HttpStatus.BAD_REQUEST);
      }

      if (!body.initialStake || !body.dailyProfitTarget || !body.dailyLossLimit || !body.derivToken) {
        throw new HttpException(
          'Campos obrigatórios: initialStake, dailyProfitTarget, dailyLossLimit, derivToken',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Determinar estratégia: usar agentType se fornecido, senão usar strategy, senão default 'orion'
      const agentType = body.agentType || body.strategy || 'orion';
      // Normalizar: 'arion' -> 'orion', 'sentinel' -> 'sentinel', etc
      const normalizedStrategy = agentType.toLowerCase() === 'arion' ? 'orion' : agentType.toLowerCase();

      await this.agentService.activateAgent(userId, {
        initialStake: parseFloat(body.initialStake),
        dailyProfitTarget: parseFloat(body.dailyProfitTarget),
        dailyLossLimit: parseFloat(body.dailyLossLimit),
        derivToken: body.derivToken,
        currency: body.currency || 'USD',
        symbol: body.symbol,
        strategy: normalizedStrategy,
        agentType: normalizedStrategy,
        riskLevel: body.riskLevel,
        tradingMode: body.tradingMode || 'normal',
        stopLossType: body.stopLossType || 'normal',
        initialBalance: parseFloat(body.initialBalance) || 0,
      });

      return {
        success: true,
        message: 'Agente autônomo ativado com sucesso',
      };
    } catch (error) {
      this.logger.error(`[ActivateAgent] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao ativar agente autônomo',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('deactivate')
  @UseGuards(AuthGuard('jwt'))
  async deactivateAgent(@Body() body: any, @Req() req: any) {
    try {
      const userId = req.user?.userId || body.userId;

      if (!userId) {
        throw new HttpException('User ID é obrigatório', HttpStatus.BAD_REQUEST);
      }

      await this.agentService.deactivateAgent(userId);

      return {
        success: true,
        message: 'Agente autônomo desativado com sucesso',
      };
    } catch (error) {
      this.logger.error(`[DeactivateAgent] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao desativar agente autônomo',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('config/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getConfig(@Param('userId') userId: string) {
    try {
      const config = await this.agentService.getAgentConfig(userId);

      if (!config) {
        return {
          success: true,
          data: null,
          message: 'Nenhuma configuração encontrada',
        };
      }

      // Converter snake_case para camelCase para o frontend
      const formattedConfig = {
        id: config.id,
        userId: config.user_id,
        isActive: config.is_active === 1 || config.is_active === true,
        initialStake: parseFloat(config.initial_stake) || 0,
        dailyProfitTarget: parseFloat(config.daily_profit_target) || 0,
        dailyLossLimit: parseFloat(config.daily_loss_limit) || 0,
        derivToken: config.deriv_token,
        currency: config.currency,
        symbol: config.symbol,
        agentType: config.agent_type,
        tradingMode: config.trading_mode,
        initialBalance: parseFloat(config.initial_balance) || 0,
        sessionStatus: config.session_status,
        sessionDate: config.session_date,
        dailyProfit: parseFloat(config.daily_profit) || 0,
        dailyLoss: parseFloat(config.daily_loss) || 0,
        totalTrades: parseInt(config.total_trades) || 0,
        totalWins: parseInt(config.total_wins) || 0,
        totalLosses: parseInt(config.total_losses) || 0,
        createdAt: config.created_at,
        updatedAt: config.updated_at,
      };

      // Atualizar trades com valores faltantes em background (não bloqueante)
      // Limita a 10 trades por vez para não sobrecarregar
      this.agentService.updateTradesWithMissingPrices(userId, 10).catch((error) => {
        this.logger.warn(`[GetConfig] Erro ao atualizar trades com valores faltantes (não crítico):`, error);
      });

      return {
        success: true,
        data: formattedConfig,
      };
    } catch (error) {
      this.logger.error(`[GetConfig] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar configuração',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('trade-history/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getTradeHistory(@Param('userId') userId: string, @Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 500;
      const history = await this.agentService.getTradeHistory(userId, limitNum);

      // Verificar se há trades com valores zerados no resultado
      const hasMissingPrices = history.some(
        (trade: any) =>
          (trade.entryPrice === 0 || trade.entryPrice === null) ||
          (trade.exitPrice === 0 || trade.exitPrice === null),
      );

      // Se houver trades com valores faltantes, atualizar em background (não bloqueante)
      if (hasMissingPrices) {
        this.agentService.updateTradesWithMissingPrices(userId, limitNum).catch((error) => {
          this.logger.warn(`[GetTradeHistory] Erro ao atualizar trades com valores faltantes (não crítico):`, error);
        });
      }

      return {
        success: true,
        data: history,
      };
    } catch (error) {
      this.logger.error(`[GetTradeHistory] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar histórico',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('daily-stats/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getDailyStats(@Param('userId') userId: string, @Query('days') days?: string) {
    try {
      const daysNum = days ? parseInt(days, 10) : 30;
      const stats = await this.agentService.getDailyStats(userId, daysNum);

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error(`[GetDailyStats] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas diárias',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('weekly-stats/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getWeeklyStats(@Param('userId') userId: string, @Query('weeks') weeks?: string) {
    try {
      const weeksNum = weeks ? parseInt(weeks, 10) : 10;
      const stats = await this.agentService.getWeeklyStats(userId, weeksNum);

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error(`[GetWeeklyStats] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas semanais',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('profit-evolution/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getProfitEvolution(@Param('userId') userId: string, @Query('days') days?: string) {
    try {
      const daysNum = days ? parseInt(days, 10) : 30;
      const evolution = await this.agentService.getProfitEvolution(userId, daysNum);

      return {
        success: true,
        data: evolution,
      };
    } catch (error) {
      this.logger.error(`[GetProfitEvolution] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar evolução do lucro',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('session-stats/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getSessionStats(@Param('userId') userId: string) {
    try {
      const stats = await this.agentService.getSessionStats(userId);

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error(`[GetSessionStats] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('price-history/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getPriceHistory(@Param('userId') userId: string, @Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 100;
      const history = await this.agentService.getPriceHistoryForUser(userId, limitNum);

      return {
        success: true,
        data: history, // Array de PriceTick com { value, epoch, timestamp }
      };
    } catch (error) {
      this.logger.error(`[GetPriceHistory] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar histórico de preços',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('logs/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getLogs(@Param('userId') userId: string, @Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : undefined;
      const logs = await this.agentService.getLogs(userId, limitNum);

      return {
        success: true,
        data: logs,
      };
    } catch (error) {
      this.logger.error(`[GetLogs] Erro:`, error);
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

  @Post('update-missing-prices/:userId')
  @UseGuards(AuthGuard('jwt'))
  async updateMissingPrices(@Param('userId') userId: string, @Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 10;
      const result = await this.agentService.updateTradesWithMissingPrices(userId, limitNum);

      return {
        success: true,
        message: `Atualização concluída: ${result.updated} trades atualizados, ${result.deleted} deletados, ${result.errors} erros`,
        data: result,
      };
    } catch (error) {
      this.logger.error(`[UpdateMissingPrices] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao atualizar trades com preços faltantes',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('logs-stream/:userId')
  async streamLogs(
    @Param('userId') userId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    // Verificar token manualmente (já que EventSource não suporta headers)
    if (!token) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        success: false,
        message: 'Token não fornecido',
      });
      return;
    }

    // TODO: Validar token JWT aqui se necessário
    try {
      // Configurar headers para SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Desabilitar buffering do nginx

      // Enviar logs históricos primeiro
      const historicalLogs = this.logsStreamService.getLogs(userId, 500);
      for (const log of historicalLogs) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }

      // Configurar callback para novos logs
      const unsubscribe = this.logsStreamService.subscribe(userId, (log) => {
        try {
          res.write(`data: ${JSON.stringify(log)}\n\n`);
        } catch (error) {
          this.logger.warn(`[StreamLogs] Erro ao enviar log:`, error);
        }
      });

      // Manter conexão aberta
      res.on('close', () => {
        unsubscribe();
        res.end();
      });

      // Enviar heartbeat a cada 30 segundos
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(`: heartbeat\n\n`);
        } catch (error) {
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      }, 30000);

      res.on('close', () => {
        clearInterval(heartbeatInterval);
      });
    } catch (error) {
      this.logger.error(`[StreamLogs] Erro:`, error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: 'Erro ao iniciar stream de logs',
        error: error.message,
      });
    }
  }

  @Get('console-logs/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getConsoleLogs(@Param('userId') userId: string, @Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 500;
      const logs = this.logsStreamService.getLogs(userId, limitNum);

      return {
        success: true,
        data: logs,
      };
    } catch (error) {
      this.logger.error(`[GetConsoleLogs] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar logs do console',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  @Get('daily-trades/:userId')
  @UseGuards(AuthGuard('jwt'))
  async getDailyTrades(@Param('userId') userId: string, @Query('date') date: string) {
    try {
      const trades = await this.agentService.getDailyTrades(userId, date || 'today');
      return {
        success: true,
        data: trades,
      };
    } catch (error) {
      this.logger.error(`[GetDailyTrades] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar trades diários',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('general-stats')
  @UseGuards(AuthGuard('jwt'))
  async getGeneralStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    try {
      this.logger.log(`[GetGeneralStats] Endpoint chamado com startDate=${startDate}, endDate=${endDate}`);
      const stats = await this.agentService.getGeneralStats(startDate, endDate);
      this.logger.log(`[GetGeneralStats] Estatísticas retornadas com sucesso`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error(`[GetGeneralStats] Erro:`, error);
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar estatísticas gerais',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

