import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DerivWebSocketManagerService } from '../broker/deriv-websocket-manager.service';

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
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly wsManager: DerivWebSocketManagerService,
  ) { }

  async activateCopyTrading(
    userId: string,
    configData: CopyTradingConfigData,
  ) {
    this.logger.log(`[ActivateCopyTrading] Ativando copy trading para usuário ${userId}`);
    this.logger.log(`[ActivateCopyTrading] Tipo de alocação: ${configData.allocationType}, Value: ${configData.allocationValue}, Percentage: ${configData.allocationPercentage}`);
    this.logger.log(`[ActivateCopyTrading] Stop Loss: ${configData.stopLoss}, Take Profit: ${configData.takeProfit}, Blind Stop Loss: ${configData.blindStopLoss}`);

    try {
      // Verificar se já existe uma configuração para o usuário
      const existingConfig = await this.dataSource.query(
        `SELECT * FROM copy_trading_config WHERE user_id = ? LIMIT 1`,
        [userId],
      );

      // Determinar allocation_value baseado no tipo de alocação
      let allocationValue: number = 0.00;
      let allocationPercentage: number | null = null;

      if (configData.allocationType === 'proportion') {
        // Se for proporção, usar o percentual e setar value como 0
        allocationPercentage = configData.allocationPercentage || 100;
        allocationValue = 0.00;
      } else {
        // Se for fixed, usar o valor fixo
        allocationValue = configData.allocationValue || 0.00;
        allocationPercentage = null;
      }

      const config = {
        user_id: userId,
        trader_id: configData.traderId,
        trader_name: configData.traderName,
        allocation_type: configData.allocationType,
        allocation_value: allocationValue,
        allocation_percentage: allocationPercentage,
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

      let configId: number;

      if (existingConfig && existingConfig.length > 0) {
        configId = existingConfig[0].id;
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
        // Buscar o ID da configuração recém-criada
        const newConfig = await this.dataSource.query(
          `SELECT id FROM copy_trading_config WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
          [userId],
        );
        configId = newConfig[0].id;
        this.logger.log(`[ActivateCopyTrading] Nova configuração criada para usuário ${userId}`);
      }

      // Encerrar sessão ativa anterior, se existir
      await this.dataSource.query(
        `UPDATE copy_trading_sessions 
         SET status = 'ended', 
             ended_at = NOW() 
         WHERE user_id = ? AND status IN ('active', 'paused')`,
        [userId],
      );

      // Buscar saldo inicial do usuário (assumindo que existe uma tabela de saldo)
      // Por enquanto, vamos usar 0.00 como saldo inicial
      const initialBalance = 0.00;

      // Criar nova sessão de copy
      await this.dataSource.query(
        `INSERT INTO copy_trading_sessions 
         (user_id, config_id, trader_id, trader_name, status, initial_balance, current_balance, started_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, NOW())`,
        [
          userId,
          configId,
          configData.traderId,
          configData.traderName,
          initialBalance,
          initialBalance,
        ],
      );

      // Buscar o ID da sessão recém-criada
      const newSession = await this.dataSource.query(
        `SELECT id FROM copy_trading_sessions WHERE user_id = ? AND config_id = ? ORDER BY id DESC LIMIT 1`,
        [userId, configId],
      );
      const sessionId = newSession[0].id;

      this.logger.log(`[ActivateCopyTrading] Nova sessão criada (ID: ${sessionId}) para usuário ${userId}`);

      return {
        isActive: true,
        sessionStatus: 'active',
        sessionId: sessionId,
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
      // Atualizar configuração
      await this.dataSource.query(
        `UPDATE copy_trading_config 
         SET session_status = 'paused',
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId],
      );

      // Pausar sessão ativa (não encerrar)
      await this.dataSource.query(
        `UPDATE copy_trading_sessions 
         SET status = 'paused', 
             paused_at = NOW()
         WHERE user_id = ? AND status = 'active'`,
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
      // Atualizar configuração
      await this.dataSource.query(
        `UPDATE copy_trading_config 
         SET session_status = 'active',
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId],
      );

      // Verificar se existe uma sessão pausada
      const pausedSession = await this.dataSource.query(
        `SELECT * FROM copy_trading_sessions 
         WHERE user_id = ? AND status = 'paused'
         ORDER BY started_at DESC
         LIMIT 1`,
        [userId],
      );

      if (pausedSession && pausedSession.length > 0) {
        // Reativar sessão pausada
        await this.dataSource.query(
          `UPDATE copy_trading_sessions 
           SET status = 'active',
               paused_at = NULL
           WHERE id = ?`,
          [pausedSession[0].id],
        );
        this.logger.log(`[ResumeCopyTrading] Sessão ${pausedSession[0].id} reativada para usuário ${userId}`);
      } else {
        // Criar nova sessão se não houver sessão pausada
        const config = await this.getCopyTradingConfig(userId);
        if (config) {
          const initialBalance = 0.00;
          await this.dataSource.query(
            `INSERT INTO copy_trading_sessions 
             (user_id, config_id, trader_id, trader_name, status, initial_balance, current_balance, started_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, NOW())`,
            [
              userId,
              config.id,
              config.traderId,
              config.traderName,
              initialBalance,
              initialBalance,
            ],
          );
          this.logger.log(`[ResumeCopyTrading] Nova sessão criada para usuário ${userId}`);
        }
      }

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
      // Buscar usuários que são traders mestres
      // Fazemos LEFT JOIN com experts somente para pegar metadados extras se existirem (avatar, bio, etc)
      // Se não existir registro em experts, usamos dados do usuário

      const traders = await this.userRepository.createQueryBuilder('user')
        .leftJoinAndSelect('experts', 'expert', 'expert.user_id = user.id')
        .where('user.trader_mestre = :isMaster', { isMaster: true })
        .andWhere('user.isActive = :isActive', { isActive: true })
        .getRawMany();

      // Formatar dados dos traders para o frontend
      return traders.map((row) => {
        // Dados do expert (pode ser null)
        // Mapeando colunas raw retornadas pelo TypeORM (prefixo expert_ se houver join)

        // Nota: TypeORM getRawMany retorna algo como: user_id, user_name, expert_id, expert_win_rate...

        const expertWinRate = row.expert_win_rate ? parseFloat(row.expert_win_rate) : 0;

        // Simulação de stats se não tiver histórico (ou pegar do expert se tiver)
        const winRate = expertWinRate || 0;

        // ROI médio = winRate * multiplicador_lucro - (100 - winRate) * multiplicador_perda
        const roi = winRate > 0 ? (winRate * 0.8) - ((100 - winRate) * 1.0) : 0;

        const dd = winRate > 0 ? Math.max(0, (100 - winRate) * 0.12) : 0;

        const totalFollowers = row.expert_total_followers || 0;
        const followersK = totalFollowers >= 1000
          ? (totalFollowers / 1000).toFixed(1)
          : totalFollowers.toString();

        return {
          id: row.user_id, // IMPORTANTE: O ID agora é o ID do usuário, não do expert
          name: row.expert_name || row.user_name, // Prefere nome do expert (display name) ou nome do user
          roi: Math.max(0, roi).toFixed(0),
          dd: dd.toFixed(1),
          followers: followersK,
          winRate: winRate.toFixed(1),
          totalTrades: row.expert_total_signals || 0,
          rating: row.expert_rating ? parseFloat(row.expert_rating).toFixed(1) : '0.0',
          specialty: row.expert_specialty || 'General',
          isVerified: row.expert_is_verified === 1 || false,
          connectionStatus: row.expert_connection_status || 'Offline',
          avatarUrl: row.expert_avatar_url || null,
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

  async getActiveSession(userId: string) {
    try {
      const result = await this.dataSource.query(
        `SELECT s.*, c.allocation_type, c.allocation_value, c.allocation_percentage, 
                c.leverage, c.stop_loss, c.take_profit, c.blind_stop_loss, c.currency
         FROM copy_trading_sessions s
         INNER JOIN copy_trading_config c ON s.config_id = c.id
         WHERE s.user_id = ? AND s.status = 'active'
         ORDER BY s.started_at DESC
         LIMIT 1`,
        [userId],
      );

      if (!result || result.length === 0) {
        return null;
      }

      const session = result[0];
      return {
        id: session.id,
        userId: session.user_id,
        configId: session.config_id,
        traderId: session.trader_id,
        traderName: session.trader_name,
        status: session.status,
        initialBalance: parseFloat(session.initial_balance) || 0,
        currentBalance: parseFloat(session.current_balance) || 0,
        totalProfit: parseFloat(session.total_profit) || 0,
        totalOperations: session.total_operations || 0,
        totalWins: session.total_wins || 0,
        totalLosses: session.total_losses || 0,
        startedAt: session.started_at,
        pausedAt: session.paused_at,
        endedAt: session.ended_at,
        lastOperationAt: session.last_operation_at,
        allocationType: session.allocation_type,
        allocationValue: parseFloat(session.allocation_value) || 0,
        allocationPercentage: session.allocation_percentage ? parseFloat(session.allocation_percentage) : null,
        leverage: session.leverage,
        stopLoss: parseFloat(session.stop_loss) || 0,
        takeProfit: parseFloat(session.take_profit) || 0,
        blindStopLoss: session.blind_stop_loss === 1,
        currency: session.currency,
      };
    } catch (error) {
      this.logger.error(
        `[GetActiveSession] Erro ao buscar sessão ativa: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getSessionOperations(sessionId: number, limit: number = 50) {
    try {
      const result = await this.dataSource.query(
        `SELECT * FROM copy_trading_operations 
         WHERE session_id = ?
         ORDER BY executed_at DESC
         LIMIT ?`,
        [sessionId, limit],
      );

      return result.map((op) => ({
        id: op.id,
        sessionId: op.session_id,
        userId: op.user_id,
        traderOperationId: op.trader_operation_id,
        operationType: op.operation_type,
        symbol: op.symbol,
        duration: op.duration,
        stakeAmount: parseFloat(op.stake_amount) || 0,
        result: op.result,
        profit: parseFloat(op.profit) || 0,
        payout: op.payout ? parseFloat(op.payout) : null,
        leverage: op.leverage,
        allocationType: op.allocation_type,
        allocationValue: op.allocation_value ? parseFloat(op.allocation_value) : null,
        executedAt: op.executed_at,
        closedAt: op.closed_at,
      }));
    } catch (error) {
      this.logger.error(
        `[GetSessionOperations] Erro ao buscar operações da sessão: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Replica uma operação manual do expert para todos os copiadores ativos
   */
  async replicateManualOperation(
    masterUserId: string,
    operationData: {
      contractId: string;
      contractType: string;
      symbol: string;
      duration: number;
      durationUnit: string;
      stakeAmount: number;
      percent: number; // Porcentagem do saldo que o trader usou
      entrySpot: number | null;
      entryTime: number;
    },
  ): Promise<void> {
    try {
      this.logger.log(`[ReplicateManualOperation] ========== INÍCIO REPLICAÇÃO OPERAÇÃO MANUAL ==========`);
      this.logger.log(`[ReplicateManualOperation] Master trader: ${masterUserId}`);
      this.logger.log(`[ReplicateManualOperation] Operação: ${JSON.stringify(operationData)}`);

      // Buscar todos os copiadores ativos do master trader
      const copiers = await this.getCopiers(masterUserId);

      if (copiers.length === 0) {
        this.logger.log(`[ReplicateManualOperation] Nenhum copiador ativo encontrado para o master trader ${masterUserId}`);
        return;
      }

      this.logger.log(`[ReplicateManualOperation] Encontrados ${copiers.length} copiadores ativos`);

      // Para cada copiador, replicar a operação
      for (const copier of copiers) {
        if (!copier.isActive) {
          this.logger.log(`[ReplicateManualOperation] Pulando copiador ${copier.userId} - não está ativo`);
          continue;
        }

        try {
          // Buscar sessão ativa do copiador
          const activeSession = await this.getActiveSession(copier.userId);

          if (!activeSession) {
            this.logger.warn(`[ReplicateManualOperation] Nenhuma sessão ativa encontrada para copiador ${copier.userId}`);
            continue;
          }

          // Calcular valor baseado na configuração do copiador
          let followerStakeAmount = 0;

          if (copier.allocationType === 'fixed') {
            // Alocação fixa: usar o valor configurado pelo copiador * alavancagem
            const leverageMultiplier = this.parseLeverage(copier.multiplier || '1x');
            followerStakeAmount = (copier.allocationValue || 0) * leverageMultiplier;
          } else if (copier.allocationType === 'proportion') {
            // Alocação proporcional: usar a mesma porcentagem do saldo do trader aplicada ao saldo do copiador
            // Buscar saldo do copiador
            const copierUser = await this.userRepository.findOne({ where: { id: copier.userId } });
            const copierBalance = copierUser?.derivBalance ? parseFloat(copierUser.derivBalance) : 0;

            if (copierBalance > 0) {
              followerStakeAmount = (operationData.percent / 100) * copierBalance;
            } else {
              this.logger.warn(`[ReplicateManualOperation] Copiador ${copier.userId} não tem saldo disponível`);
              continue;
            }
          } else {
            // Fallback: usar o mesmo valor do expert
            followerStakeAmount = operationData.stakeAmount;
          }

          this.logger.log(
            `[ReplicateManualOperation] Replicando para copiador ${copier.userId} (${copier.allocationType}) - Trader %: ${operationData.percent.toFixed(2)}%, Stake copiador: $${followerStakeAmount.toFixed(2)}`,
          );

          // Gravar operação na tabela copy_trading_operations
          await this.dataSource.query(
            `INSERT INTO copy_trading_operations 
             (session_id, user_id, trader_operation_id, operation_type, symbol, duration,
              stake_amount, result, profit, leverage, allocation_type, allocation_value,
              executed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
            [
              activeSession.id,
              copier.userId,
              operationData.contractId,
              operationData.contractType,
              operationData.symbol || null,
              operationData.duration || null,
              followerStakeAmount,
              'pending', // Resultado será atualizado quando o contrato for fechado
              0, // Profit será atualizado quando o contrato for fechado
              copier.multiplier || '1x',
              copier.allocationType,
              copier.allocationValue,
              operationData.entryTime,
            ],
          );

          // Atualizar estatísticas da sessão
          const newTotalOperations = (activeSession.totalOperations || 0) + 1;
          const currentBalance = (activeSession.currentBalance || 0) - followerStakeAmount;

          // Se for a primeira operação, definir saldo inicial
          const initialBalance = activeSession.totalOperations === 0
            ? (activeSession.currentBalance || 0)
            : activeSession.initialBalance;

          await this.dataSource.query(
            `UPDATE copy_trading_sessions 
             SET total_operations = ?,
                 current_balance = ?,
                 initial_balance = ?,
                 last_operation_at = NOW()
             WHERE id = ?`,
            [newTotalOperations, currentBalance, initialBalance, activeSession.id],
          );

          this.logger.log(
            `[ReplicateManualOperation] ✅ Operação replicada para copiador ${copier.userId} - Session: ${activeSession.id}, Stake: $${followerStakeAmount.toFixed(2)}`,
          );

          // Execute trade on Deriv API
          try {
            const derivContractId = await this.executeCopierTrade(copier.userId, {
              symbol: operationData.symbol,
              contractType: operationData.contractType,
              duration: operationData.duration,
              durationUnit: operationData.durationUnit,
              stakeAmount: followerStakeAmount,
              derivToken: copier.derivToken,
            });

            if (derivContractId) {
              // Update operation with real Deriv contract ID
              await this.dataSource.query(
                `UPDATE copy_trading_operations 
                 SET trader_operation_id = ?
                 WHERE session_id = ? AND user_id = ? 
                 ORDER BY executed_at DESC LIMIT 1`,
                [derivContractId, activeSession.id, copier.userId],
              );

              this.logger.log(
                `[ReplicateManualOperation] ✅ Trade executado na Deriv para ${copier.userId}: ${derivContractId}`,
              );
            } else {
              this.logger.warn(
                `[ReplicateManualOperation] ⚠️ Falha ao executar trade na Deriv para ${copier.userId} - operação salva apenas no banco`,
              );
            }
          } catch (derivError) {
            this.logger.error(
              `[ReplicateManualOperation] Erro ao executar trade na Deriv para ${copier.userId}: ${derivError.message}`,
            );
            // Continue with other copiers even if Deriv execution fails
          }
        } catch (error) {
          this.logger.error(
            `[ReplicateManualOperation] Erro ao replicar para copiador ${copier.userId}: ${error.message}`,
            error.stack,
          );
          // Continuar com os próximos copiadores mesmo se houver erro
        }
      }

      this.logger.log(`[ReplicateManualOperation] ========== FIM REPLICAÇÃO OPERAÇÃO MANUAL ==========`);
    } catch (error) {
      this.logger.error(
        `[ReplicateManualOperation] Erro ao replicar operação manual: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Replica uma operação de IA do trader mestre para todos os copiadores ativos
   * Mesma lógica de replicateManualOperation(), mas adaptada para operações de IA
   */
  async replicateAIOperation(
    masterUserId: string,
    operationData: {
      tradeId: number;        // ID do ai_trades
      contractId: string;     // ID do contrato Deriv (pode estar vazio inicialmente)
      contractType: string;
      symbol: string;
      duration: number;
      stakeAmount: number;
      entrySpot: number | null;
      entryTime: number;
    },
  ): Promise<void> {
    try {
      this.logger.log(`[ReplicateAIOperation] ========== INÍCIO REPLICAÇÃO OPERAÇÃO IA ==========`);
      this.logger.log(`[ReplicateAIOperation] Master trader: ${masterUserId}`);
      this.logger.log(`[ReplicateAIOperation] TradeId: ${operationData.tradeId}, ContractId: ${operationData.contractId}`);

      // Verificar se é trader mestre
      const isMaster = await this.isMasterTrader(masterUserId);
      if (!isMaster) {
        this.logger.debug(`[ReplicateAIOperation] Usuário ${masterUserId} não é trader mestre, ignorando replicação`);
        return;
      }

      // Buscar todos os copiadores ativos do master trader
      const copiers = await this.getCopiers(masterUserId);

      if (copiers.length === 0) {
        this.logger.log(`[ReplicateAIOperation] Nenhum copiador ativo encontrado para o master trader ${masterUserId}`);
        return;
      }

      this.logger.log(`[ReplicateAIOperation] Encontrados ${copiers.length} copiadores ativos`);

      // Para cada copiador, replicar a operação
      for (const copier of copiers) {
        if (!copier.isActive) {
          this.logger.log(`[ReplicateAIOperation] Pulando copiador ${copier.userId} - não está ativo`);
          continue;
        }

        try {
          // Buscar sessão ativa do copiador
          const activeSession = await this.getActiveSession(copier.userId);

          if (!activeSession) {
            this.logger.warn(`[ReplicateAIOperation] Nenhuma sessão ativa encontrada para copiador ${copier.userId}`);
            continue;
          }

          // Calcular valor usando MESMO VALOR do mestre (conforme solicitado)
          let followerStakeAmount = operationData.stakeAmount;

          this.logger.log(
            `[ReplicateAIOperation] Replicando para copiador ${copier.userId} - Stake: $${followerStakeAmount.toFixed(2)} (mesmo valor do mestre)`,
          );

          // Gravar operação na tabela copy_trading_operations
          // Usar contractId como trader_operation_id (mesmo que esteja vazio, será atualizado depois)
          await this.dataSource.query(
            `INSERT INTO copy_trading_operations 
             (session_id, user_id, trader_operation_id, operation_type, symbol, duration,
              stake_amount, result, profit, leverage, allocation_type, allocation_value,
              executed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
            [
              activeSession.id,
              copier.userId,
              operationData.contractId || `ai_trade_${operationData.tradeId}`, // Usar tradeId como fallback
              operationData.contractType,
              operationData.symbol || null,
              operationData.duration || null,
              followerStakeAmount,
              'pending', // Resultado será atualizado quando o contrato for fechado
              0, // Profit será atualizado quando o contrato for fechado
              '1x', // Sem leverage para IA
              'fixed', // Sempre fixo (mesmo valor)
              followerStakeAmount,
              operationData.entryTime,
            ],
          );

          // Atualizar estatísticas da sessão
          const newTotalOperations = (activeSession.totalOperations || 0) + 1;

          await this.dataSource.query(
            `UPDATE copy_trading_sessions 
             SET total_operations = ?,
                 last_operation_at = NOW()
             WHERE id = ?`,
            [newTotalOperations, activeSession.id],
          );

          this.logger.log(
            `[ReplicateAIOperation] ✅ Operação IA replicada para copiador ${copier.userId} - Session: ${activeSession.id}, Stake: $${followerStakeAmount.toFixed(2)}`,
          );
        } catch (error) {
          this.logger.error(
            `[ReplicateAIOperation] Erro ao replicar para copiador ${copier.userId}: ${error.message}`,
            error.stack,
          );
          // Continuar com os próximos copiadores mesmo se houver erro
        }
      }

      this.logger.log(`[ReplicateAIOperation] ========== FIM REPLICAÇÃO OPERAÇÃO IA ==========`);
    } catch (error) {
      this.logger.error(
        `[ReplicateAIOperation] Erro ao replicar operação IA: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Atualiza o resultado das operações de copy trading quando o contrato do expert é finalizado
   */
  async updateCopyTradingOperationsResult(
    masterUserId: string,
    contractId: string,
    result: 'win' | 'loss',
    expertProfit: number,
    expertStakeAmount: number,
  ): Promise<void> {
    try {
      this.logger.log(`[UpdateCopyTradingOperationsResult] ========== ATUALIZANDO RESULTADO OPERAÇÕES ==========`);
      this.logger.log(`[UpdateCopyTradingOperationsResult] Master trader: ${masterUserId}, ContractId: ${contractId}, Result: ${result}, Expert Profit: ${expertProfit}, Expert Stake: ${expertStakeAmount}`);

      // Buscar todas as operações de copy trading com o mesmo trader_operation_id (contractId do expert)
      const operations = await this.dataSource.query(
        `SELECT o.*, s.user_id as copier_user_id, s.id as session_id, s.current_balance, s.total_operations, s.total_wins, s.total_losses, s.total_profit
         FROM copy_trading_operations o
         INNER JOIN copy_trading_sessions s ON o.session_id = s.id
         WHERE o.trader_operation_id = ? AND o.result = 'pending'
         ORDER BY o.executed_at ASC`,
        [contractId],
      );

      if (!operations || operations.length === 0) {
        this.logger.log(`[UpdateCopyTradingOperationsResult] Nenhuma operação de copy trading encontrada para contractId ${contractId}`);
        return;
      }

      this.logger.log(`[UpdateCopyTradingOperationsResult] Encontradas ${operations.length} operações para atualizar`);

      // Atualizar cada operação
      for (const operation of operations) {
        try {
          // Calcular profit proporcional baseado no stake do copiador vs stake do expert
          const copierStakeAmount = parseFloat(operation.stake_amount) || 0;
          let copierProfit = 0;

          if (expertStakeAmount > 0) {
            // Calcular proporção: (stake_copiador / stake_expert) * profit_expert
            const proportion = copierStakeAmount / expertStakeAmount;
            copierProfit = expertProfit * proportion;
          } else {
            // Se stake do expert for 0, usar profit direto (caso especial)
            copierProfit = expertProfit;
          }

          // Arredondar para 2 casas decimais
          copierProfit = Math.round(copierProfit * 100) / 100;

          this.logger.log(
            `[UpdateCopyTradingOperationsResult] Atualizando operação ${operation.id} - Copier: ${operation.copier_user_id}, Stake: $${copierStakeAmount.toFixed(2)}, Profit: $${copierProfit.toFixed(2)}`,
          );

          // Atualizar a operação
          await this.dataSource.query(
            `UPDATE copy_trading_operations 
             SET result = ?,
                 profit = ?,
                 closed_at = NOW()
             WHERE id = ?`,
            [result, copierProfit, operation.id],
          );

          // Atualizar estatísticas da sessão
          const sessionId = operation.session_id;
          const currentBalance = parseFloat(operation.current_balance) || 0;

          // Retornar o stake + profit ao saldo (stake foi debitado quando a operação foi criada)
          const newBalance = currentBalance + copierStakeAmount + copierProfit;

          const totalOperations = (operation.total_operations || 0);
          const totalWins = result === 'win' ? (operation.total_wins || 0) + 1 : (operation.total_wins || 0);
          const totalLosses = result === 'loss' ? (operation.total_losses || 0) + 1 : (operation.total_losses || 0);
          const totalProfit = (parseFloat(operation.total_profit) || 0) + copierProfit;

          await this.dataSource.query(
            `UPDATE copy_trading_sessions 
             SET current_balance = ?,
                 total_wins = ?,
                 total_losses = ?,
                 total_profit = ?
             WHERE id = ?`,
            [newBalance, totalWins, totalLosses, totalProfit, sessionId],
          );

          // Verificar stop loss e take profit
          const sessionConfig = await this.dataSource.query(
            `SELECT stop_loss, take_profit FROM copy_trading_config 
             WHERE user_id = ? AND is_active = 1 LIMIT 1`,
            [operation.copier_user_id],
          );

          if (sessionConfig && sessionConfig.length > 0) {
            const stopLoss = parseFloat(sessionConfig[0].stop_loss) || 0;
            const takeProfit = parseFloat(sessionConfig[0].take_profit) || 0;

            // Verificar stop loss (perda acumulada)
            const lossAmount = Math.abs(totalProfit < 0 ? totalProfit : 0);
            if (stopLoss > 0 && lossAmount >= stopLoss) {
              this.logger.warn(
                `[UpdateCopyTradingOperationsResult] Stop loss atingido para sessão ${sessionId} - Loss: $${lossAmount.toFixed(2)}, Stop Loss: $${stopLoss.toFixed(2)}`,
              );
              await this.endSession(sessionId, operation.copier_user_id, 'stop_loss', `Stop loss atingido: $${lossAmount.toFixed(2)}`);
            }

            // Verificar take profit (lucro acumulado)
            if (takeProfit > 0 && totalProfit >= takeProfit) {
              this.logger.log(
                `[UpdateCopyTradingOperationsResult] Take profit atingido para sessão ${sessionId} - Profit: $${totalProfit.toFixed(2)}, Take Profit: $${takeProfit.toFixed(2)}`,
              );
              await this.endSession(sessionId, operation.copier_user_id, 'take_profit', `Take profit atingido: $${totalProfit.toFixed(2)}`);
            }
          }

          this.logger.log(
            `[UpdateCopyTradingOperationsResult] ✅ Operação ${operation.id} atualizada - Result: ${result}, Profit: $${copierProfit.toFixed(2)}, New Balance: $${newBalance.toFixed(2)}`,
          );
        } catch (error) {
          this.logger.error(
            `[UpdateCopyTradingOperationsResult] Erro ao atualizar operação ${operation.id}: ${error.message}`,
            error.stack,
          );
          // Continuar com as próximas operações mesmo se houver erro
        }
      }

      this.logger.log(`[UpdateCopyTradingOperationsResult] ========== FIM ATUALIZAÇÃO RESULTADO OPERAÇÕES ==========`);
    } catch (error) {
      this.logger.error(
        `[UpdateCopyTradingOperationsResult] Erro ao atualizar resultado das operações: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Verifica se um usuário é trader mestre (pode ter operações copiadas)
   */
  async isMasterTrader(userId: string): Promise<boolean> {
    try {
      // Verificar role do usuário
      const userResult = await this.dataSource.query(
        `SELECT role FROM users WHERE id = ? LIMIT 1`,
        [userId],
      );

      if (userResult && userResult.length > 0) {
        const role = userResult[0].role?.toLowerCase() || '';
        if (role === 'trader' || role === 'master' || role === 'admin') {
          return true;
        }
      }

      // Verificar se está na tabela experts com trader_type
      // Primeiro tenta por user_id, depois por email (fallback)
      let expertResult = await this.dataSource.query(
        `SELECT trader_type FROM experts WHERE user_id = ? AND is_active = 1 LIMIT 1`,
        [userId],
      );

      // Se não encontrou por user_id, tenta por email
      if (!expertResult || expertResult.length === 0) {
        const userEmailResult = await this.dataSource.query(
          `SELECT email FROM users WHERE id = ? LIMIT 1`,
          [userId],
        );

        if (userEmailResult && userEmailResult.length > 0) {
          const userEmail = userEmailResult[0].email;
          expertResult = await this.dataSource.query(
            `SELECT trader_type FROM experts WHERE email = ? AND is_active = 1 LIMIT 1`,
            [userEmail],
          );
        }
      }

      if (expertResult && expertResult.length > 0) {
        const traderType = expertResult[0].trader_type?.toLowerCase() || '';
        if (traderType === 'trader' || traderType === 'master') {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error(
        `[IsMasterTrader] Erro ao verificar trader mestre: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Replica uma operação do trader mestre para todos os copiadores ativos
   */
  async replicateTradeToFollowers(
    masterUserId: string,
    tradeData: {
      operationType: string; // CALL, PUT, DIGITEVEN, DIGITODD, etc
      stakeAmount: number; // Valor investido pelo mestre
      result: 'win' | 'loss' | 'pending';
      profit: number; // Lucro/perda do mestre
      executedAt: Date;
      closedAt?: Date;
      duration?: number;
      symbol?: string;
      traderOperationId?: string; // ID da operação original
    },
  ): Promise<void> {
    try {
      // Verificar se é trader mestre
      const isMaster = await this.isMasterTrader(masterUserId);
      if (!isMaster) {
        this.logger.debug(`[ReplicateTrade] Usuário ${masterUserId} não é trader mestre, ignorando replicação`);
        return;
      }

      this.logger.log(
        `[ReplicateTrade] Replicando operação do trader mestre ${masterUserId} - Tipo: ${tradeData.operationType}, Resultado: ${tradeData.result}, Profit: ${tradeData.profit}`,
      );

      // Buscar todas as sessões ativas copiando esse trader
      const activeSessions = await this.dataSource.query(
        `SELECT s.*, c.allocation_type, c.allocation_value, c.allocation_percentage,
                c.leverage, c.stop_loss, c.take_profit, c.currency
         FROM copy_trading_sessions s
         INNER JOIN copy_trading_config c ON s.config_id = c.id
         WHERE s.trader_id = ? AND s.status = 'active'
         ORDER BY s.started_at ASC`,
        [masterUserId],
      );

      if (!activeSessions || activeSessions.length === 0) {
        this.logger.debug(`[ReplicateTrade] Nenhum copiador ativo para trader ${masterUserId}`);
        return;
      }

      this.logger.log(`[ReplicateTrade] Encontradas ${activeSessions.length} sessões ativas para replicar`);

      // Replicar para cada sessão ativa
      for (const session of activeSessions) {
        try {
          await this.replicateTradeToSession(session, tradeData);
        } catch (error) {
          this.logger.error(
            `[ReplicateTrade] Erro ao replicar para sessão ${session.id}: ${error.message}`,
            error.stack,
          );
          // Continua para próxima sessão mesmo se uma falhar
        }
      }
    } catch (error) {
      this.logger.error(
        `[ReplicateTrade] Erro ao replicar operação: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Replica uma operação para uma sessão específica
   */
  private async replicateTradeToSession(
    session: any,
    tradeData: {
      operationType: string;
      stakeAmount: number;
      result: 'win' | 'loss' | 'pending';
      profit: number;
      executedAt: Date;
      closedAt?: Date;
      duration?: number;
      symbol?: string;
      traderOperationId?: string;
    },
  ): Promise<void> {
    try {
      // Calcular valor a ser investido pelo copiador baseado nas configurações
      let followerStakeAmount = 0;

      if (session.allocation_type === 'proportion') {
        // Proporção: usar percentual do saldo inicial
        const percentage = parseFloat(session.allocation_percentage) || 100;
        followerStakeAmount = (session.initial_balance * percentage) / 100;
      } else {
        // Valor fixo: usar o valor configurado
        followerStakeAmount = parseFloat(session.allocation_value) || 0;
      }

      // Aplicar alavancagem
      const leverageMultiplier = this.parseLeverage(session.leverage);
      followerStakeAmount = followerStakeAmount * leverageMultiplier;

      // Garantir valor mínimo
      if (followerStakeAmount < 0.01) {
        this.logger.warn(
          `[ReplicateTrade] Valor calculado muito baixo para sessão ${session.id}: ${followerStakeAmount}`,
        );
        return;
      }

      // Calcular lucro/perda proporcional ao valor investido
      const profitRatio = tradeData.stakeAmount > 0 ? tradeData.profit / tradeData.stakeAmount : 0;
      const followerProfit = followerStakeAmount * profitRatio;

      // Criar registro da operação replicada
      await this.dataSource.query(
        `INSERT INTO copy_trading_operations 
         (session_id, user_id, trader_operation_id, operation_type, symbol, duration,
          stake_amount, result, profit, leverage, allocation_type, allocation_value,
          executed_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.user_id,
          tradeData.traderOperationId || null,
          tradeData.operationType,
          tradeData.symbol || null,
          tradeData.duration || null,
          followerStakeAmount,
          tradeData.result,
          followerProfit,
          session.leverage,
          session.allocation_type,
          session.allocation_value,
          tradeData.executedAt,
          tradeData.closedAt || null,
        ],
      );

      // Atualizar estatísticas da sessão
      const won = tradeData.result === 'win';
      const newBalance = parseFloat(session.current_balance) + followerProfit;
      const newTotalOperations = (session.total_operations || 0) + 1;
      const newTotalWins = won ? (session.total_wins || 0) + 1 : session.total_wins || 0;
      const newTotalLosses = !won ? (session.total_losses || 0) + 1 : session.total_losses || 0;
      const newTotalProfit = parseFloat(session.total_profit || 0) + followerProfit;

      await this.dataSource.query(
        `UPDATE copy_trading_sessions 
         SET current_balance = ?,
             total_operations = ?,
             total_wins = ?,
             total_losses = ?,
             total_profit = ?,
             last_operation_at = NOW()
         WHERE id = ?`,
        [
          newBalance,
          newTotalOperations,
          newTotalWins,
          newTotalLosses,
          newTotalProfit,
          session.id,
        ],
      );

      this.logger.log(
        `[ReplicateTrade] Operação replicada para sessão ${session.id} - Stake: $${followerStakeAmount.toFixed(2)}, Profit: $${followerProfit.toFixed(2)}`,
      );

      // Verificar stop loss e take profit
      const stopLoss = parseFloat(session.stop_loss) || 0;
      const takeProfit = parseFloat(session.take_profit) || 0;

      // Verificar stop loss (perda acumulada)
      const lossAmount = Math.abs(newTotalProfit < 0 ? newTotalProfit : 0);
      if (stopLoss > 0 && lossAmount >= stopLoss) {
        this.logger.warn(
          `[ReplicateTrade] Stop loss atingido para sessão ${session.id} - Loss: $${lossAmount.toFixed(2)}, Stop Loss: $${stopLoss.toFixed(2)}`,
        );
        await this.endSession(session.id, session.user_id, 'stop_loss', `Stop loss atingido: $${lossAmount.toFixed(2)}`);
        return;
      }

      // Verificar take profit (lucro acumulado)
      if (takeProfit > 0 && newTotalProfit >= takeProfit) {
        this.logger.log(
          `[ReplicateTrade] Take profit atingido para sessão ${session.id} - Profit: $${newTotalProfit.toFixed(2)}, Take Profit: $${takeProfit.toFixed(2)}`,
        );
        await this.endSession(session.id, session.user_id, 'take_profit', `Take profit atingido: $${newTotalProfit.toFixed(2)}`);
        return;
      }
    } catch (error) {
      this.logger.error(
        `[ReplicateTradeToSession] Erro ao replicar para sessão: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Encerra uma sessão de copy trading
   */
  private async endSession(
    sessionId: number,
    userId: string,
    reason: string,
    reasonDescription: string,
  ): Promise<void> {
    try {
      // Encerrar sessão
      await this.dataSource.query(
        `UPDATE copy_trading_sessions 
         SET status = 'ended',
             ended_at = NOW()
         WHERE id = ?`,
        [sessionId],
      );

      // Atualizar configuração
      await this.dataSource.query(
        `UPDATE copy_trading_config 
         SET is_active = 0,
             session_status = ?,
             deactivated_at = NOW(),
             deactivation_reason = ?
         WHERE user_id = ?`,
        [reason, reasonDescription, userId],
      );

      this.logger.log(`[EndSession] Sessão ${sessionId} encerrada - Motivo: ${reason}`);
    } catch (error) {
      this.logger.error(`[EndSession] Erro ao encerrar sessão: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Busca todos os copiadores (usuários que configuraram copy trade para o trader mestre)
   * 
   * Lógica:
   * 1. Buscar na copy_trading_config para encontrar o trader_id associado ao master trader
   * 2. Buscar na copy_trading_sessions usando esse trader_id para encontrar os copiadores ativos
   */
  async getCopiers(masterUserId: string) {
    try {
      this.logger.log(`[GetCopiers] ========== INÍCIO BUSCA COPIADORES ==========`);
      this.logger.log(`[GetCopiers] Master trader user_id: ${masterUserId}`);

      // PASSO 1: Buscar na copy_trading_config para encontrar trader_ids associados ao master trader
      // Primeiro, verificar se o user_id do master trader aparece como trader_id na config
      this.logger.log(`[GetCopiers] PASSO 1: Buscando na copy_trading_config onde trader_id = ${masterUserId}`);

      const configsWithMasterAsTrader = await this.dataSource.query(
        `SELECT DISTINCT trader_id, user_id, trader_name, is_active, session_status
         FROM copy_trading_config 
         WHERE trader_id = ?`,
        [masterUserId],
      );

      this.logger.log(`[GetCopiers] PASSO 1 - Resultado: ${configsWithMasterAsTrader.length} registros encontrados na config com trader_id = ${masterUserId}`);
      if (configsWithMasterAsTrader.length > 0) {
        configsWithMasterAsTrader.forEach((config, idx) => {
          this.logger.log(`[GetCopiers] PASSO 1 - Config ${idx + 1}: trader_id=${config.trader_id}, user_id=${config.user_id}, trader_name=${config.trader_name}, is_active=${config.is_active}`);
        });
      }

      // Buscar também se há expert associado
      const expertResult = await this.dataSource.query(
        `SELECT id FROM experts WHERE user_id = ? AND is_active = 1 LIMIT 1`,
        [masterUserId],
      );

      let traderIdsToSearch: string[] = [masterUserId]; // Sempre incluir o user_id diretamente

      if (expertResult && expertResult.length > 0) {
        const expertId = expertResult[0].id;
        traderIdsToSearch.push(expertId);
        this.logger.log(`[GetCopiers] Expert encontrado: ${expertId} para user_id ${masterUserId}`);

        // Verificar se esse expert.id aparece como trader_id
        const configsWithExpertAsTrader = await this.dataSource.query(
          `SELECT DISTINCT trader_id, user_id, trader_name, is_active, session_status
           FROM copy_trading_config 
           WHERE trader_id = ?`,
          [expertId],
        );
        this.logger.log(`[GetCopiers] PASSO 1 - Config com expert.id como trader_id: ${configsWithExpertAsTrader.length} registros`);
        if (configsWithExpertAsTrader.length > 0) {
          configsWithExpertAsTrader.forEach((config, idx) => {
            this.logger.log(`[GetCopiers] PASSO 1 - Config Expert ${idx + 1}: trader_id=${config.trader_id}, user_id=${config.user_id}, trader_name=${config.trader_name}`);
          });
        }
      } else {
        this.logger.log(`[GetCopiers] Nenhum expert associado ao user_id ${masterUserId}`);
      }

      // NOVO: Buscar TODOS os trader_ids que existem na tabela e verificar se algum corresponde ao master trader
      // Isso ajuda a descobrir qual é o trader_id correto do master trader
      this.logger.log(`[GetCopiers] PASSO 1.5: Buscando todos os trader_ids na tabela para verificar relação com master trader`);

      // Buscar todos os trader_ids únicos na tabela
      const allTraderIdsInTable = await this.dataSource.query(
        `SELECT DISTINCT trader_id FROM copy_trading_config`,
      );
      this.logger.log(`[GetCopiers] PASSO 1.5 - Trader IDs encontrados na tabela: ${allTraderIdsInTable.length}`);

      // Para cada trader_id, verificar se é um expert.id do master trader
      for (const row of allTraderIdsInTable) {
        const traderId = row.trader_id;
        this.logger.log(`[GetCopiers] PASSO 1.5 - Verificando trader_id: ${traderId}`);

        // Verificar se esse trader_id é um expert.id do master trader
        const expertCheck = await this.dataSource.query(
          `SELECT id, user_id, name FROM experts WHERE id = ? AND user_id = ?`,
          [traderId, masterUserId],
        );

        if (expertCheck && expertCheck.length > 0) {
          this.logger.log(`[GetCopiers] PASSO 1.5 - ✅ ENCONTRADO! trader_id ${traderId} é um expert.id do master trader!`);
          traderIdsToSearch.push(traderId);
        } else {
          // Verificar se esse trader_id é o próprio user_id do master (caso especial)
          if (traderId === masterUserId) {
            this.logger.log(`[GetCopiers] PASSO 1.5 - ✅ trader_id ${traderId} é o próprio user_id do master trader`);
            // Já está na lista
          } else {
            this.logger.log(`[GetCopiers] PASSO 1.5 - ❌ trader_id ${traderId} não está relacionado ao master trader`);
          }
        }
      }

      // NOVO PASSO 1.6: Verificar nas sessões ativas quais trader_ids têm sessões e se algum corresponde ao master
      this.logger.log(`[GetCopiers] PASSO 1.6: Verificando trader_ids nas sessões ativas`);
      const activeSessionsTraderIds = await this.dataSource.query(
        `SELECT DISTINCT trader_id FROM copy_trading_sessions WHERE status = 'active'`,
      );
      this.logger.log(`[GetCopiers] PASSO 1.6 - Trader IDs com sessões ativas: ${activeSessionsTraderIds.length}`);

      for (const row of activeSessionsTraderIds) {
        const traderId = row.trader_id;
        this.logger.log(`[GetCopiers] PASSO 1.6 - Verificando trader_id com sessão ativa: ${traderId}`);

        // Verificar se é expert.id do master
        const expertCheck = await this.dataSource.query(
          `SELECT id, user_id FROM experts WHERE id = ? AND user_id = ?`,
          [traderId, masterUserId],
        );

        if (expertCheck && expertCheck.length > 0) {
          this.logger.log(`[GetCopiers] PASSO 1.6 - ✅ trader_id ${traderId} (com sessão ativa) é expert.id do master!`);
          traderIdsToSearch.push(traderId);
        } else if (traderId === masterUserId) {
          this.logger.log(`[GetCopiers] PASSO 1.6 - ✅ trader_id ${traderId} (com sessão ativa) é o user_id do master!`);
          // Já está na lista
        }
      }

      // Remover duplicatas
      traderIdsToSearch = [...new Set(traderIdsToSearch)];

      this.logger.log(`[GetCopiers] PASSO 1 - Trader IDs FINAIS para buscar: ${traderIdsToSearch.join(', ')}`);

      // PASSO 2: Buscar na copy_trading_config todos os copiadores (onde trader_id corresponde ao master)
      this.logger.log(`[GetCopiers] PASSO 2: Buscando copiadores na copy_trading_config onde trader_id IN (${traderIdsToSearch.join(', ')})`);

      const copiersFromConfig = await this.dataSource.query(
        `SELECT 
          c.id,
          c.user_id,
          c.trader_id,
          c.trader_name,
          c.allocation_type,
          c.allocation_value,
          c.allocation_percentage,
          c.leverage,
          c.stop_loss,
          c.take_profit,
          c.blind_stop_loss,
          c.is_active,
          c.session_status,
          c.session_balance,
          c.total_operations,
          c.total_wins,
          c.total_losses,
          c.activated_at,
          c.created_at,
          c.deriv_token,
          u.name as user_name,
          c.deriv_token,
          u.name as user_name,
          u.email as user_email,
          COALESCE((
            SELECT SUM(profit) 
            FROM copy_trading_operations 
            WHERE user_id = c.user_id 
            AND result IN ('win', 'loss')
          ), 0) as total_profit,
          COALESCE((
            SELECT SUM(profit) 
            FROM copy_trading_operations 
            WHERE user_id = c.user_id 
            AND result IN ('win', 'loss')
            AND DATE(executed_at) = CURDATE()
          ), 0) as today_profit,
          COALESCE((
            SELECT SUM(stake_amount) 
            FROM copy_trading_operations 
            WHERE user_id = c.user_id 
          ), 0) as total_volume
        FROM copy_trading_config c
        INNER JOIN users u ON c.user_id = u.id
        WHERE c.trader_id IN (${traderIdsToSearch.map(() => '?').join(',')})
        ORDER BY c.created_at DESC`,
        traderIdsToSearch,
      );

      this.logger.log(`[GetCopiers] PASSO 2 - Encontrados ${copiersFromConfig.length} copiadores na config`);
      if (copiersFromConfig.length > 0) {
        copiersFromConfig.forEach((copier, idx) => {
          this.logger.log(`[GetCopiers] PASSO 2 - Copiador Config ${idx + 1}: user_id=${copier.user_id}, name=${copier.user_name}, trader_id=${copier.trader_id}, is_active=${copier.is_active}`);
        });
      }

      // PASSO 3: Buscar nas copy_trading_sessions usando o trader_id encontrado
      this.logger.log(`[GetCopiers] PASSO 3: Buscando copiadores nas copy_trading_sessions onde trader_id IN (${traderIdsToSearch.join(', ')}) E status = 'active'`);

      const copiersFromSessions = await this.dataSource.query(
        `SELECT DISTINCT
          c.id,
          s.user_id,
          s.trader_id,
          s.trader_name,
          c.allocation_type,
          c.allocation_value,
          c.allocation_percentage,
          c.leverage,
          c.stop_loss,
          c.take_profit,
          c.blind_stop_loss,
          c.is_active,
          c.session_status,
          s.current_balance as session_balance,
          s.total_operations,
          s.total_wins,
          s.total_losses,
          s.started_at as activated_at,
          c.created_at,
          c.deriv_token,
          u.name as user_name,
          u.email as user_email,
          s.status as session_status_active,
          COALESCE((
            SELECT SUM(profit) 
            FROM copy_trading_operations 
            WHERE user_id = s.user_id 
            AND result IN ('win', 'loss')
          ), 0) as total_profit,
          COALESCE((
            SELECT SUM(profit) 
            FROM copy_trading_operations 
            WHERE user_id = s.user_id 
            AND result IN ('win', 'loss')
            AND DATE(executed_at) = CURDATE()
          ), 0) as today_profit,
          COALESCE((
            SELECT SUM(stake_amount) 
            FROM copy_trading_operations 
            WHERE user_id = s.user_id 
          ), 0) as total_volume
        FROM copy_trading_sessions s
        INNER JOIN copy_trading_config c ON s.config_id = c.id
        INNER JOIN users u ON s.user_id = u.id
        WHERE s.trader_id IN (${traderIdsToSearch.map(() => '?').join(',')})
          AND s.status = 'active'
        ORDER BY s.started_at DESC`,
        traderIdsToSearch,
      );

      this.logger.log(`[GetCopiers] PASSO 3 - Encontrados ${copiersFromSessions.length} copiadores nas sessões ativas`);
      if (copiersFromSessions.length > 0) {
        copiersFromSessions.forEach((copier, idx) => {
          this.logger.log(`[GetCopiers] PASSO 3 - Copiador Sessão ${idx + 1}: user_id=${copier.user_id}, name=${copier.user_name}, trader_id=${copier.trader_id}, session_status=${copier.session_status_active}`);
        });
      }

      // Combinar resultados, evitando duplicatas (priorizando dados da sessão se existir)
      const copiersMap = new Map();

      // Primeiro adicionar da config
      copiersFromConfig.forEach(copier => {
        copiersMap.set(copier.user_id, copier);
      });

      // Depois atualizar/sobrescrever com dados das sessões ativas (mais atualizados)
      copiersFromSessions.forEach(copier => {
        copiersMap.set(copier.user_id, copier);
      });

      const copiers = Array.from(copiersMap.values());

      this.logger.log(`[GetCopiers] Encontrados ${copiers.length} copiadores para trader ${masterUserId}`);

      // Se não encontrou nada, apenas logar
      if (copiers.length === 0) {
        this.logger.log(`[GetCopiers] Nenhum copiador encontrado.`);
      }
      this.logger.log(`[GetCopiers] ========== FIM BUSCA COPIADORES ==========`);

      // Formatar dados dos copiadores
      return copiers.map((copier) => {
        // Calcular multiplicador baseado na alavancagem
        const leverageMultiplier = this.parseLeverage(copier.leverage || '1x');
        const multiplier = `${leverageMultiplier}x`;

        // Calcular PnL (Profit and Loss) baseado no lucro total das operações
        // Se não houver operações, usar session_balance como fallback
        const pnl = parseFloat(copier.total_profit || copier.session_balance || '0');

        // Determinar tag baseado no status
        const tag = copier.is_active ? 'ATIVO' : 'INATIVO';

        return {
          id: copier.id,
          userId: copier.user_id,
          name: copier.user_name || 'Usuário',
          email: copier.user_email || '',
          tag: tag,
          multiplier: multiplier,
          profitTarget: parseFloat(copier.take_profit || '0'),
          lossLimit: parseFloat(copier.stop_loss || '0'),
          balance: parseFloat(copier.session_balance || '0'),
          pnl: pnl,
          isActive: copier.is_active === 1 || copier.is_active === true,
          allocationType: copier.allocation_type,
          allocationValue: parseFloat(copier.allocation_value || '0'),
          allocationPercentage: copier.allocation_percentage ? parseFloat(copier.allocation_percentage) : null,
          derivToken: copier.deriv_token || '',
          // Retornar lista combinada (se não foi retornado antes)
        };
      });
    } catch (error) {
      this.logger.error(
        `[GetCopiers] Erro ao buscar copiadores: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async promoteToMasterTrader(userId: string) {
    try {
      this.logger.log(`[PromoteToMasterTrader] Promovendo usuário ${userId} a Master Trader`);

      await this.userRepository.update(userId, {
        traderMestre: true
      });

      this.logger.log(`[PromoteToMasterTrader] Usuário ${userId} promovido com sucesso`);
      return { success: true, message: 'Usuário promovido a Master Trader' };
    } catch (error) {
      this.logger.error(
        `[PromoteToMasterTrader] Erro ao promover usuário: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Parse leverage string (ex: "1x", "2x", "5x") para número
   */
  private parseLeverage(leverage: string): number {
    if (!leverage) return 1;
    const match = leverage.match(/(\d+)x?/i);
    return match ? parseInt(match[1], 10) : 1;
  }

  /**
   * Executa trade na Deriv API para um copiador
   */
  private async executeCopierTrade(
    userId: string,
    tradeConfig: {
      symbol: string;
      contractType: string;
      duration: number;
      durationUnit: string;
      stakeAmount: number;
      derivToken: string;
    },
  ): Promise<string | null> {
    return new Promise(async (resolve, reject) => {
      try {
        this.logger.log(
          `[ExecuteCopierTrade] Executando trade para copiador ${userId} - Symbol: ${tradeConfig.symbol}, Type: ${tradeConfig.contractType}, Stake: $${tradeConfig.stakeAmount.toFixed(2)}`,
        );

        // Get or create WebSocket service for this copier
        const wsService = this.wsManager.getOrCreateService(userId);

        // Connect if not connected
        const isConnected = await wsService.connect(tradeConfig.derivToken).catch((error) => {
          this.logger.error(`[ExecuteCopierTrade] Erro ao conectar WebSocket para ${userId}: ${error.message}`);
          return false;
        });

        if (!isConnected) {
          this.logger.error(`[ExecuteCopierTrade] Falha ao conectar para ${userId}`);
          resolve(null);
          return;
        }

        // Subscribe to proposal
        wsService.subscribeToProposal({
          symbol: tradeConfig.symbol,
          contractType: tradeConfig.contractType,
          duration: tradeConfig.duration,
          durationUnit: tradeConfig.durationUnit,
          amount: tradeConfig.stakeAmount,
        }, tradeConfig.derivToken);

        // Wait for proposal and buy
        const proposalTimeout = setTimeout(() => {
          this.logger.error(`[ExecuteCopierTrade] Timeout aguardando proposta para ${userId}`);
          resolve(null);
        }, 10000); // 10 seconds timeout

        (wsService as any).once('proposal', (proposal: any) => {
          clearTimeout(proposalTimeout);

          this.logger.log(`[ExecuteCopierTrade] Proposta recebida para ${userId}: ${proposal.id}, Price: $${proposal.askPrice}`);

          // Buy the contract
          wsService.buyContract({
            proposalId: proposal.id,
            price: proposal.askPrice,
            durationUnit: tradeConfig.durationUnit,
            duration: tradeConfig.duration,
            contractType: tradeConfig.contractType,
            token: tradeConfig.derivToken // ✅ Passar token explícito para garantir contexto
          });

          // Wait for buy confirmation
          const buyTimeout = setTimeout(() => {
            this.logger.error(`[ExecuteCopierTrade] Timeout aguardando confirmação de compra para ${userId}`);
            resolve(null);
          }, 10000);

          (wsService as any).once('buy', (buyData: any) => {
            clearTimeout(buyTimeout);

            this.logger.log(
              `[ExecuteCopierTrade] ✅ Trade executado para ${userId}: Contract ID: ${buyData.contractId}, Buy Price: $${buyData.buyPrice}`,
            );

            resolve(buyData.contractId);
          });

          (wsService as any).once('error', (error: any) => {
            clearTimeout(buyTimeout);
            this.logger.error(`[ExecuteCopierTrade] Erro ao comprar contrato para ${userId}: ${error.message || JSON.stringify(error)}`);
            resolve(null);
          });
        });

        wsService.once('error', (error: any) => {
          clearTimeout(proposalTimeout);
          this.logger.error(`[ExecuteCopierTrade] Erro na proposta para ${userId}: ${error.message || JSON.stringify(error)}`);
          resolve(null);
        });

      } catch (error) {
        this.logger.error(
          `[ExecuteCopierTrade] Erro ao executar trade para ${userId}: ${error.message}`,
          error.stack,
        );
        resolve(null);
      }
    });
  }
}

