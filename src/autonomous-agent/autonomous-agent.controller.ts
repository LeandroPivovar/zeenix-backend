import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AutonomousAgentService } from './autonomous-agent.service';

@Controller('autonomous-agent')
export class AutonomousAgentController {
  private readonly logger = new Logger(AutonomousAgentController.name);

  constructor(private readonly agentService: AutonomousAgentService) {}

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

      await this.agentService.activateAgent(userId, {
        initialStake: parseFloat(body.initialStake),
        dailyProfitTarget: parseFloat(body.dailyProfitTarget),
        dailyLossLimit: parseFloat(body.dailyLossLimit),
        derivToken: body.derivToken,
        currency: body.currency || 'USD',
        symbol: body.symbol,
        strategy: body.strategy,
        riskLevel: body.riskLevel,
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

      return {
        success: true,
        data: config,
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
      const limitNum = limit ? parseInt(limit, 10) : 50;
      const history = await this.agentService.getTradeHistory(userId, limitNum);

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
      const limitNum = limit ? parseInt(limit, 10) : 100;
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
}

