import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

interface CopyTradingConfigData {
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
}

@Injectable()
export class CopyTradingService {
  private readonly logger = new Logger(CopyTradingService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ExpertEntity)
    private readonly expertRepository: Repository<ExpertEntity>,
  ) {}

  async activateCopyTrading(
    userId: string,
    configData: CopyTradingConfigData,
  ) {
    this.logger.log(`[ActivateCopyTrading] Ativando copy trading para usuário ${userId}`);

    try {
      // Verificar se já existe uma configuração para o usuário
      const existingConfig = await this.dataSource.query(
        `SELECT * FROM copy_trading_config WHERE user_id = ? LIMIT 1`,
        [userId],
      );

      const config = {
        user_id: userId,
        trader_id: configData.traderId,
        trader_name: configData.traderName,
        allocation_type: configData.allocationType,
        allocation_value: configData.allocationValue,
        allocation_percentage: configData.allocationPercentage || null,
        leverage: configData.leverage,
        stop_loss: configData.stopLoss,
        take_profit: configData.takeProfit,
        blind_stop_loss: configData.blindStopLoss ? 1 : 0,
        deriv_token: configData.derivToken,
        currency: configData.currency,
        is_active: 1,
        session_status: 'active',
        session_balance: 0.00,
        total_operations: 0,
        total_wins: 0,
        total_losses: 0,
        activated_at: new Date(),
        deactivated_at: null,
        deactivation_reason: null,
      };

      if (existingConfig && existingConfig.length > 0) {
        // Atualizar configuração existente
        await this.dataSource.query(
          `UPDATE copy_trading_config 
           SET trader_id = ?, 
               trader_name = ?, 
               allocation_type = ?,
               allocation_value = ?,
               allocation_percentage = ?,
               leverage = ?,
               stop_loss = ?,
               take_profit = ?,
               blind_stop_loss = ?,
               deriv_token = ?,
               currency = ?,
               is_active = 1,
               session_status = 'active',
               activated_at = NOW(),
               deactivated_at = NULL,
               deactivation_reason = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`,
          [
            config.trader_id,
            config.trader_name,
            config.allocation_type,
            config.allocation_value,
            config.allocation_percentage,
            config.leverage,
            config.stop_loss,
            config.take_profit,
            config.blind_stop_loss,
            config.deriv_token,
            config.currency,
            userId,
          ],
        );
        this.logger.log(`[ActivateCopyTrading] Configuração atualizada para usuário ${userId}`);
      } else {
        // Criar nova configuração
        await this.dataSource.query(
          `INSERT INTO copy_trading_config 
           (user_id, trader_id, trader_name, allocation_type, allocation_value, allocation_percentage, 
            leverage, stop_loss, take_profit, blind_stop_loss, deriv_token, currency, 
            is_active, session_status, session_balance, total_operations, total_wins, total_losses, 
            activated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            config.user_id,
            config.trader_id,
            config.trader_name,
            config.allocation_type,
            config.allocation_value,
            config.allocation_percentage,
            config.leverage,
            config.stop_loss,
            config.take_profit,
            config.blind_stop_loss,
            config.deriv_token,
            config.currency,
            config.is_active,
            config.session_status,
            config.session_balance,
            config.total_operations,
            config.total_wins,
            config.total_losses,
          ],
        );
        this.logger.log(`[ActivateCopyTrading] Nova configuração criada para usuário ${userId}`);
      }

      return {
        isActive: true,
        sessionStatus: 'active',
        ...configData,
      };
    } catch (error) {
      this.logger.error(
        `[ActivateCopyTrading] Erro ao ativar copy trading: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async deactivateCopyTrading(userId: string, reason?: string) {
    this.logger.log(`[DeactivateCopyTrading] Desativando copy trading para usuário ${userId}`);

    try {
      await this.dataSource.query(
        `UPDATE copy_trading_config 
         SET is_active = 0,
             session_status = 'deactivated',
             deactivated_at = NOW(),
             deactivation_reason = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [reason || 'Desativação manual pelo usuário', userId],
      );

      this.logger.log(`[DeactivateCopyTrading] Copy trading desativado para usuário ${userId}`);
    } catch (error) {
      this.logger.error(
        `[DeactivateCopyTrading] Erro ao desativar copy trading: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getCopyTradingConfig(userId: string) {
    try {
      const result = await this.dataSource.query(
        `SELECT * FROM copy_trading_config WHERE user_id = ? LIMIT 1`,
        [userId],
      );

      if (!result || result.length === 0) {
        return null;
      }

      const config = result[0];
      return {
        id: config.id,
        traderId: config.trader_id,
        traderName: config.trader_name,
        allocationType: config.allocation_type,
        allocationValue: parseFloat(config.allocation_value) || 0,
        allocationPercentage: config.allocation_percentage
          ? parseFloat(config.allocation_percentage)
          : null,
        leverage: config.leverage,
        stopLoss: parseFloat(config.stop_loss) || 0,
        takeProfit: parseFloat(config.take_profit) || 0,
        blindStopLoss: config.blind_stop_loss === 1,
        currency: config.currency,
        isActive: config.is_active === 1,
        sessionStatus: config.session_status,
        sessionBalance: parseFloat(config.session_balance) || 0,
        totalOperations: config.total_operations || 0,
        totalWins: config.total_wins || 0,
        totalLosses: config.total_losses || 0,
        activatedAt: config.activated_at,
        deactivatedAt: config.deactivated_at,
        deactivationReason: config.deactivation_reason,
      };
    } catch (error) {
      this.logger.error(
        `[GetCopyTradingConfig] Erro ao buscar configuração: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async pauseCopyTrading(userId: string) {
    this.logger.log(`[PauseCopyTrading] Pausando copy trading para usuário ${userId}`);

    try {
      await this.dataSource.query(
        `UPDATE copy_trading_config 
         SET session_status = 'paused',
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId],
      );

      this.logger.log(`[PauseCopyTrading] Copy trading pausado para usuário ${userId}`);
    } catch (error) {
      this.logger.error(
        `[PauseCopyTrading] Erro ao pausar copy trading: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async resumeCopyTrading(userId: string) {
    this.logger.log(`[ResumeCopyTrading] Retomando copy trading para usuário ${userId}`);

    try {
      await this.dataSource.query(
        `UPDATE copy_trading_config 
         SET session_status = 'active',
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId],
      );

      this.logger.log(`[ResumeCopyTrading] Copy trading retomado para usuário ${userId}`);
    } catch (error) {
      this.logger.error(
        `[ResumeCopyTrading] Erro ao retomar copy trading: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getAvailableTraders() {
    try {
      // Buscar experts que estão ativos e disponíveis para copy trading
      const experts = await this.expertRepository.find({
        where: {
          isActive: true,
        },
        order: {
          rating: 'DESC',
          winRate: 'DESC',
        },
      });

      // Formatar dados dos traders para o frontend
      return experts.map((expert) => {
        // Calcular ROI baseado no winRate (aproximação)
        // ROI médio = winRate * multiplicador_lucro - (100 - winRate) * multiplicador_perda
        // Assumindo lucro médio de 80% e perda média de 100% do stake
        const winRate = expert.winRate ? parseFloat(expert.winRate.toString()) : 0;
        const roi = winRate > 0 ? (winRate * 0.8) - ((100 - winRate) * 1.0) : 0;
        
        // Calcular drawdown aproximado baseado no winRate
        // Drawdown menor quando winRate maior
        const dd = winRate > 0 ? Math.max(0, (100 - winRate) * 0.12) : 10;
        
        // Converter followers para formato "k" (milhares)
        const totalFollowers = expert.totalFollowers || 0;
        const followersK = totalFollowers >= 1000 
          ? (totalFollowers / 1000).toFixed(1) 
          : totalFollowers.toString();

        return {
          id: expert.id,
          name: expert.name,
          roi: Math.max(0, roi).toFixed(0),
          dd: dd.toFixed(1),
          followers: followersK,
          winRate: winRate.toFixed(1),
          totalTrades: expert.totalSignals || 0,
          rating: expert.rating ? parseFloat(expert.rating.toString()).toFixed(1) : '0.0',
          specialty: expert.specialty || '',
          isVerified: expert.isVerified || false,
          connectionStatus: expert.connectionStatus || 'Desconectado',
        };
      });
    } catch (error) {
      this.logger.error(
        `[GetAvailableTraders] Erro ao buscar traders: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}

