import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CopyTradingService } from './copy-trading.service';

@Controller('copy-trading')
export class CopyTradingController {
  private readonly logger = new Logger(CopyTradingController.name);

  constructor(private readonly copyTradingService: CopyTradingService) {}

  @Post('activate')
  @UseGuards(AuthGuard('jwt'))
  async activateCopyTrading(
    @Req() req: any,
    @Body()
    body: {
      traderId: string;
      traderName: string;
      allocationType: 'proportion' | 'fixed';
      allocationValue: number;
      allocationPercentage?: number;
      leverage: string;
      stopLoss: number;
      takeProfit: number;
      blindStopLoss: boolean;
      derivToken: string;
      currency: string;
    },
  ) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;
      
      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      this.logger.log(
        `[ActivateCopyTrading] Ativando copy trading para usuário ${userId}, trader: ${body.traderName}`,
      );

      const result = await this.copyTradingService.activateCopyTrading(
        userId,
        {
          traderId: body.traderId,
          traderName: body.traderName,
          allocationType: body.allocationType,
          allocationValue: body.allocationValue,
          allocationPercentage: body.allocationPercentage,
          leverage: body.leverage,
          stopLoss: body.stopLoss,
          takeProfit: body.takeProfit,
          blindStopLoss: body.blindStopLoss,
          derivToken: body.derivToken,
          currency: body.currency || 'USD',
        },
      );

      return {
        success: true,
        message: 'Copy trading ativado com sucesso',
        data: result,
      };
    } catch (error) {
      this.logger.error(
        `[ActivateCopyTrading] Erro ao ativar copy trading: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao ativar copy trading',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('deactivate')
  @UseGuards(AuthGuard('jwt'))
  async deactivateCopyTrading(@Req() req: any) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      this.logger.log(
        `[DeactivateCopyTrading] Desativando copy trading para usuário ${userId}`,
      );

      await this.copyTradingService.deactivateCopyTrading(userId);

      return {
        success: true,
        message: 'Copy trading desativado com sucesso',
      };
    } catch (error) {
      this.logger.error(
        `[DeactivateCopyTrading] Erro ao desativar copy trading: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao desativar copy trading',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('config')
  @UseGuards(AuthGuard('jwt'))
  async getCopyTradingConfig(@Req() req: any) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const config = await this.copyTradingService.getCopyTradingConfig(userId);

      return {
        success: true,
        data: config,
      };
    } catch (error) {
      this.logger.error(
        `[GetCopyTradingConfig] Erro ao buscar configuração: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao buscar configuração',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('pause')
  @UseGuards(AuthGuard('jwt'))
  async pauseCopyTrading(@Req() req: any) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      await this.copyTradingService.pauseCopyTrading(userId);

      return {
        success: true,
        message: 'Copy trading pausado com sucesso',
      };
    } catch (error) {
      this.logger.error(
        `[PauseCopyTrading] Erro ao pausar copy trading: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao pausar copy trading',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('resume')
  @UseGuards(AuthGuard('jwt'))
  async resumeCopyTrading(@Req() req: any) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      await this.copyTradingService.resumeCopyTrading(userId);

      return {
        success: true,
        message: 'Copy trading retomado com sucesso',
      };
    } catch (error) {
      this.logger.error(
        `[ResumeCopyTrading] Erro ao retomar copy trading: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao retomar copy trading',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('traders')
  async getAvailableTraders() {
    try {
      const traders = await this.copyTradingService.getAvailableTraders();

      return {
        success: true,
        data: traders,
      };
    } catch (error) {
      this.logger.error(
        `[GetAvailableTraders] Erro ao buscar traders: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao buscar traders disponíveis',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('session/active')
  @UseGuards(AuthGuard('jwt'))
  async getActiveSession(@Req() req: any) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const session = await this.copyTradingService.getActiveSession(userId);

      return {
        success: true,
        data: session,
      };
    } catch (error) {
      this.logger.error(
        `[GetActiveSession] Erro ao buscar sessão ativa: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao buscar sessão ativa',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('session/:sessionId/operations')
  @UseGuards(AuthGuard('jwt'))
  async getSessionOperations(
    @Req() req: any,
    @Param('sessionId') sessionId: string,
  ) {
    try {
      const userId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!userId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const operations = await this.copyTradingService.getSessionOperations(
        parseInt(sessionId, 10),
      );

      return {
        success: true,
        data: operations,
      };
    } catch (error) {
      this.logger.error(
        `[GetSessionOperations] Erro ao buscar operações: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao buscar operações da sessão',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('copiers')
  @UseGuards(AuthGuard('jwt'))
  async getCopiers(@Req() req: any) {
    try {
      const masterUserId = req.user?.userId || req.user?.sub || req.user?.id;

      if (!masterUserId) {
        throw new HttpException(
          {
            success: false,
            message: 'Usuário não identificado',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const copiers = await this.copyTradingService.getCopiers(masterUserId);

      return {
        success: true,
        data: copiers,
      };
    } catch (error) {
      this.logger.error(
        `[GetCopiers] Erro ao buscar copiadores: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Erro ao buscar copiadores',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

