import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DerivWebSocketManagerService } from '../broker/deriv-websocket-manager.service';
import { PlanPermissionsService } from '../plans/plan-permissions.service';

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
    private readonly planPermissionsService: PlanPermissionsService,
  ) { }

  async activateCopyTrading(
    userId: string,
    configData: CopyTradingConfigData,
  ) {
    // ✅ PASSO 0: VERIFICAR PERMISSÕES DO PLANO
    if (this.planPermissionsService) {
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['plan'],
      });

      if (!user) {
        throw new NotFoundException('Usuário não encontrado');
      }

      if (!this.planPermissionsService.canActivateTrader(user, configData.traderId)) {
        this.logger.warn(`[ActivateCopyTrading] 🚫 Usuário ${userId} tentou copiar trader restrito: ${configData.traderId}`);
        throw new ForbiddenException(`Seu plano atual não inclui o copy trading com este trader.`);
      }
    }

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
   * Replica operação manual de um Master Trader para seus copiadores
   */
  async replicateManualOperation(
    masterTraderId: string,
    operation: {
      contractId: string;
      contractType: string;
      symbol: string;
      duration: number;
      durationUnit: string;
      stakeAmount: number;
      entrySpot: number;
      entryTime: number;
      barrier?: number;
      percent?: number;
    },
  ): Promise<void> {
    try {
      this.logger.log(`[ReplicateManual] Replicando operação do Master ${masterTraderId} (${operation.symbol} ${operation.contractType})`);

      // 1. Buscar copiadores ativos deste Master Trader E suas sessões ativas
      const copiers = await this.dataSource.query(
        `SELECT 
            c.*, 
            u.token_demo, 
            u.token_real, 
            u.real_amount, 
            u.demo_amount,
            u.deriv_raw, 
            s.trade_currency, 
            css.id as session_id
         FROM copy_trading_config c
         JOIN users u ON c.user_id = u.id
         LEFT JOIN user_settings s ON c.user_id = s.user_id
         JOIN copy_trading_sessions css ON css.user_id = c.user_id AND css.status = 'active'
         WHERE c.trader_id = ? AND c.is_active = 1 AND c.session_status = 'active'`,
        [masterTraderId],
      );

      if (!copiers || copiers.length === 0) {
        this.logger.log(`[ReplicateManual] Nenhum copiador ativo encontrado para Master ${masterTraderId}`);
        return;
      }

      this.logger.log(`[ReplicateManual] Encontrados ${copiers.length} copiadores para replicar`);

      // 2. Iterar e executar para cada copiador
      for (const copier of copiers) {
        // Resolver token do copiador (Demo ou Real)
        let copierToken = null;
        const currencyPref = (copier.trade_currency || 'USD').toUpperCase();

        // 1. Selecionar token baseado na preferência de moeda (DEMO ou REAL)
        if (currencyPref === 'DEMO') {
          copierToken = copier.token_demo;
        } else {
          copierToken = copier.token_real;
        }

        // Se não tiver o token específico, tenta o token da config como fallback
        if (!copierToken) {
          copierToken = copier.deriv_token;
        }

        // Se ainda não tiver token, pular
        if (!copierToken) {
          this.logger.warn(`[ReplicateManual] Copiador ${copier.user_id} sem token válido (${currencyPref}). Ignorando.`);
          continue;
        }

        // Calcular Stake do Copiador
        let copierStake = 0;

        if (copier.allocation_type === 'proportion') {
          // PROPORTION: Usar percentual do Mestre aplicado ao Saldo Real/Demo do Usuário (Tabela Users)
          const masterPercent = operation.percent || 0.35;
          const userBalance = currencyPref === 'DEMO'
            ? parseFloat(copier.demo_amount || 0)
            : parseFloat(copier.real_amount || 0);

          copierStake = (userBalance * masterPercent) / 100;
          this.logger.log(`[ReplicateManual] Proporcional: Balance ${currencyPref} $${userBalance.toFixed(2)} * ${masterPercent.toFixed(2)}% = $${copierStake.toFixed(2)}`);
        } else {
          // FIXED: Espelho Fixo (Mesmo valor do mestre)
          copierStake = operation.stakeAmount;
          this.logger.log(`[ReplicateManual] Fixo (Espelho): Stake Mestre $${operation.stakeAmount} -> Copiador $${copierStake.toFixed(2)}`);
        }

        // Rounding to 2 decimal places
        copierStake = Math.round(copierStake * 100) / 100;

        // Se a stake for 0 ou negativa, ainda assim tentamos com o mínimo de segurança ou deixamos falhar?
        // Como o usuário pediu "não verifique saldo nem nada", vamos apenas garantir que não seja NaN ou <= 0 literal.
        if (copierStake <= 0) {
          copierStake = 0.35; // Mínimo absoluto para não quebrar a proposta da API
        }
        copierStake = Math.round(copierStake * 100) / 100;


        // ✅ Barrier from operation
        // Passado diretamente sem default para evitar transformar RISE/FALL em barreira
        const barrier = operation.barrier;

        // Executar trade do copiador (Fire and Forget para não travar loop do master)
        // Mas com callback para salvar no banco
        this.executeCopierTrade(copier.user_id, {
          symbol: operation.symbol,
          contractType: operation.contractType,
          duration: operation.duration,
          durationUnit: operation.durationUnit,
          stakeAmount: copierStake,
          derivToken: copierToken,
          barrier: barrier
        }).then(async (copierContractId) => {
          if (copierContractId) {
            try {
              // Salvar operação no banco
              await this.dataSource.query(
                `INSERT INTO copy_trading_operations 
                   (session_id, user_id, trader_operation_id, operation_type, barrier, symbol, duration,
                    stake_amount, result, profit, leverage, allocation_type, allocation_value,
                    executed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
                [
                  copier.session_id,
                  copier.user_id,
                  operation.contractId, // ✅ CORREÇÃO: Usar ID do contrato do MESTRE para vincular
                  operation.contractType,
                  barrier,
                  operation.symbol,
                  operation.duration,
                  copierStake,
                  'pending',
                  0,
                  '1x',
                  copier.allocation_type,
                  copier.allocation_value,
                  operation.entryTime
                ]
              );

              // Atualizar estatísticas da sessão
              await this.dataSource.query(
                `UPDATE copy_trading_sessions 
                   SET total_operations = total_operations + 1,
                       last_operation_at = NOW()
                   WHERE id = ?`,
                [copier.session_id]
              );
            } catch (dbError) {
              this.logger.error(`[ReplicateManual] Erro ao salvar operação DB para copiador ${copier.user_id}: ${dbError.message}`);
            }
          }
        }).catch(err => {
          this.logger.error(`[ReplicateManual] Falha na execução para copiador ${copier.user_id}: ${err.message}`);
        });
      }

    } catch (error) {
      this.logger.error(`[ReplicateManual] Erro geral ao replicar operações: ${error.message}`, error.stack);
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

          // Calcular Stake do Copiador (Agregado da lógica manual)
          let followerStakeAmount = 0;

          // Mapear propriedades camelCase do getCopiers para lógica
          // getCopiers: allocationType, allocationValue, allocationPercentage
          if (copier.allocationType === 'proportion') {
            // Precisamos da porcentagem do master. 
            // Se operationData vier do OrionStrategy, ele não manda 'percent'.
            // Mas 'stakeAmount' é o valor. E não temos o capital total do master aqui para saber %.
            // Porém, o OrionStrategy manda stakeAmount. 
            // Assumindo que operationData.stakeAmount é o valor, e não temos 'percent'.
            // Se não tem percent, como calcular proporção?
            // "as apostas sempre vão sem seguindo o valor de entrada do trader mestre ou a porcentagem que ele usar"

            // Se for IA, geralmente não temos "percent" explícito se não calcularmos basedo no saldo da IA.
            // Mas o usuário disse "sigam... a porcentagem que ele usar".
            // Se não temos a porcentagem, usamos stakeAmount direto?
            // Fallback: Se for proportion e não tem como calcular, usamos o valor fixo da stake do mestre?
            // Ou tentamos calcular % se tivermos o saldo do mestre? (Não temos aqui fácil).

            // Se o modo for proportion, a lógica "correta" seria (StakeMestre / BancaMestre) * BancaCopiador * Multiplicador.
            // Sem BancaMestre, fica difícil.
            // Alternativa: Se for proportion, usar o valor da stake do mestre * multiplicador? (Não é bem proporção de banca).

            // DADO O CONTEXTO DA IA: "Orion" decide valor dinâmico (Martingale/Soros).
            // O ideal seria o copiador seguir a "Intenção" de risco.
            // Se o mestre entrou com $0.35 (minimo), e copiador tem banca milionária, deveria entrar com mais?
            // Se allocation_type for proportion, sim.

            // Vamos assumir que se não tiver percent, usamos StakeMestre como base? Não faz sentido pra proportion de banca.
            // VAMOS USAR A LÓGICA DE PERCENTUAL SE DISPONÍVEL, SENÃO FIXO?
            // Mas espere, na replicateManualOperation o 'operation' tráz .percent.
            // Na replicateAIOperation 'operationData' NÃO tráz .percent.

            // VOU ADICIONAR 'percent' ao replicateAIOperation params se possível, ou calcular.
            // Mas por enquanto, vou usar o 'allocationValue' como base fixa se não tiver como calcular %? 
            // NÃO. O usuário disse "use a tabela de config".

            // Se a config do usuário diz "PROPORTION" e temos allocationValue (banca do usuário).
            // E a operação é de IA.
            // A IA operou com $X.
            // Se não sei quanto $X representa da banca da IA, não sei a % para replicar.

            // SOLUÇÃO: O usuário disse "as apostas sempre vão sem seguindo o valor de entrada do trader mestre".
            // Talvez ele queira dizer: Se for 'fixed', usa o valor da config dele.
            // Se for 'proportion', ele quer seguir a %?

            // Vou manter simples: Se for Fixed, usa copier.allocationValue.
            // Se for Proportion: Tentar usar (StakeMestre / CapitalInicialMestre)?
            // Na falta de dados, vou usar o StakeMestre * Multiplier?

            // Vamos usar o StakeMestre como 'Base' se não tivermos info de banco mestre. 
            // Ou melhor, vou alterar para usar allocationValue como FIXO se o tipo for FIXED.
            // Se for PROPORTION, como falta info, vou logar warning e usar StakeMestre * Multiplier?

            // OBSERVAÇÃO: "as apostas sempre vão sem seguindo o valor de entrada do trader mestre ou a porcentagem que ele usar"
            // Se o mestre usou valor X. 
            // Se o usuário configurar "Valor Fixo de $10", ele quer entrar com $10, independente do mestre entrar com $0.35 ou $100.
            // É isso que "tabela de config" significa.

            if (copier.allocationType === 'fixed') {
              followerStakeAmount = copier.allocationValue || 0.35;
            } else {
              // Proportion: Sem percentual do mestre, vamos usar o StakeMestre * (Multiplier/100)?
              // Ou simplesmente replicar o StakeMestre? 
              // O usuário disse "seguindo o valor de entrada... OU a porcentagem".

              // Se allocation_type é 'proportion', vamos tentar seguir a proporção se 'operationData' tiver percent (preciso adicionar no caller?), 
              // SENÃO usamos o valor do Mestre.
              // Como operationData não tem percent no tipo, vou assumir copy 1:1 * multiplier por enquanto, 
              // ou melhor, APENAS FIXO funciona bem. Proportion em IA é complexo sem saldo mestre.

              // Porem, se eu olhar o `OrionStrategy`, ele calcula `percent` e manda no manualOperation!
              // Mas aqui estamos no `replicateAIOperation`.
              // O `OrionStrategy` chama `updateCopyTradingOperationsResult` mas NÃO chama `replicateAIOperation`?
              // ESPERE. O `OrionStrategy` chama `replicateManualOperation` (linha 2655 do Orion)!
              // "await this.copyTradingService.replicateManualOperation(..."

              // ENTÃO O `replicateAIOperation` PODE NÃO ESTAR SENDO USADO PELA ORION!
              // Se Orion usa `replicateManualOperation`, então minha mudança anterior já resolve para Orion!

              // Mas vou atualizar aqui também caso outra estratégia use.
              // Vou assumir Fixed = Config Value, Proportion = StakeMestre (fallback).

              if (copier.allocationType === 'fixed') {
                followerStakeAmount = copier.allocationValue;
              } else {
                // Fallback proportion: StakeMestre * (AllocationPercentage/100 se existir, senao 1)
                const multi = (copier.allocationPercentage || 100) / 100;
                followerStakeAmount = operationData.stakeAmount * multi;
              }
            }
          } else {
            // Se allocationType nao definido ou 'fixed'
            followerStakeAmount = copier.allocationValue || 0.35;
          }

          // Validar Mínimo
          if (followerStakeAmount < 0.35) followerStakeAmount = 0.35;
          followerStakeAmount = Math.round(followerStakeAmount * 100) / 100;

          this.logger.log(
            `[ReplicateAIOperation] Replicando para copiador ${copier.userId} - Stake: $${followerStakeAmount.toFixed(2)}`,
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
        `SELECT 
          s.*, 
          c.allocation_type, c.allocation_value, c.allocation_percentage,
          c.leverage, c.stop_loss, c.take_profit, c.currency, c.deriv_token,
          u.token_demo, u.token_real, us.trade_currency, u.deriv_raw
         FROM copy_trading_sessions s
         INNER JOIN copy_trading_config c ON s.config_id = c.id
         INNER JOIN users u ON s.user_id = u.id
         LEFT JOIN user_settings us ON s.user_id = us.user_id
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
          // ✅ Lógica de Resolução de Token
          const preferredCurrency = (session.trade_currency || session.currency || 'USD').toUpperCase();
          let resolvedToken = session.deriv_token || ''; // Começa com o da config (que não veio na query original, oops, vamos assumir que pode vir do c.deriv_token se adicionarmos)
          // Mas deriv_token está em copy_trading_config (c). Adicionando c.deriv_token na query.

          // 1. Tentar usar token explícito da tabela users se disponível
          if (preferredCurrency === 'DEMO' && session.token_demo) {
            resolvedToken = session.token_demo;
          } else if (preferredCurrency !== 'DEMO' && session.token_real) {
            resolvedToken = session.token_real;
          } else {
            // Fallback
            let wantDemo = preferredCurrency === 'DEMO';
            const derivRaw = session.deriv_raw;
            if (preferredCurrency === 'USD' && derivRaw) {
              try {
                const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
                if (raw?.loginid?.startsWith('VRTC')) wantDemo = true;
              } catch (e) { }
            }
            if (wantDemo && derivRaw) {
              try {
                const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
                const tokens = raw.tokensByLoginId || {};
                const entry = Object.entries(tokens).find(([lid]) => (lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              } catch (e) { }
            } else if (!wantDemo && derivRaw) {
              try {
                const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
                const tokens = raw.tokensByLoginId || {};
                const entry = Object.entries(tokens).find(([lid]) => !(lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              } catch (e) { }
            }
          }

          // Adicionar o token resolvido à sessão para uso no replicateTradeToSession
          // Se replicateTradeToSession precisar executar trade, ele usará este token.
          // Atualmente replicateTradeToSession apenas insere no banco, mas passaremos para manter consistência.
          session.resolvedToken = resolvedToken;

          await this.replicateTradeToSession(session, tradeData, resolvedToken);
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
    derivToken?: string,
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

      // PASSO 1: Identificar todos os trader_ids possíveis para este master trader
      // (Incluindo o próprio ID e IDs de Experts associados)
      let traderIdsToSearch: string[] = [masterUserId];

      // Buscar se há expert associado (remover is_active para garantir que encontramos histórico)
      const expertResult = await this.dataSource.query(
        `SELECT id FROM experts WHERE user_id = ? LIMIT 1`,
        [masterUserId],
      );

      if (expertResult && expertResult.length > 0) {
        const expertId = expertResult[0].id;
        traderIdsToSearch.push(expertId);
        this.logger.log(`[GetCopiers] Expert associado encontrado: ${expertId}`);
      }

      // Buscar outros trader_ids que podem ser do mesmo usuário (verificação na tabela experts)
      const allTraderIdsInTable = await this.dataSource.query(
        `SELECT DISTINCT trader_id FROM copy_trading_config`,
      );

      for (const row of allTraderIdsInTable) {
        const traderId = row.trader_id;
        if (!traderIdsToSearch.includes(traderId)) {
          // Verificar se esse trader_id é um expert.id do master trader
          const expertCheck = await this.dataSource.query(
            `SELECT id FROM experts WHERE id = ? AND user_id = ?`,
            [traderId, masterUserId],
          );

          if (expertCheck && expertCheck.length > 0) {
            this.logger.log(`[GetCopiers] Trader ID ${traderId} verificado como Expert do usuário.`);
            traderIdsToSearch.push(traderId);
          }
        }
      }

      // Remover duplicatas e garantir que não tenha null/undefined
      traderIdsToSearch = [...new Set(traderIdsToSearch)].filter(id => !!id);
      this.logger.log(`[GetCopiers] Trader IDs FINAIS para busca: ${traderIdsToSearch.join(', ')}`);

      if (traderIdsToSearch.length === 0) {
        this.logger.warn(`[GetCopiers] Nenhum Trader ID encontrado para busca.`);
        return [];
      }

      // PASSO 2: Buscar APENAS copiadores com sessão ATIVA
      // Alterado para buscar diretamente da tabela de sessões com status = 'active'
      const query = `
        SELECT 
          s.id, -- ID da sessão
          s.user_id,
          s.trader_id,
          s.trader_name,
          
          -- Dados da Config (Joining)
          c.allocation_type,
          c.allocation_value,
          c.allocation_percentage,
          c.leverage,
          c.stop_loss,
          c.take_profit,
          c.blind_stop_loss,
          c.is_active, -- da config
          c.deriv_token,
          
          -- Dados do Usuário
          u.name as user_name,
          u.email as user_email,
          CASE 
            WHEN COALESCE(us.trade_currency, c.currency, 'USD') = 'DEMO' 
            THEN COALESCE(u.demo_amount, 0)
            ELSE COALESCE(u.real_amount, 0)
          END as user_balance,
          u.token_demo,
          u.token_real,
          u.deriv_raw,
          us.trade_currency,
          
          -- Dados da Sessão
          s.status as session_status,
          COALESCE(s.current_balance, 0) as session_balance,
          COALESCE(s.total_operations, 0) as total_operations,
          COALESCE(s.total_wins, 0) as total_wins,
          COALESCE(s.total_losses, 0) as total_losses,
          COALESCE(s.total_profit, 0) as total_profit,
          s.started_at as activated_at,
          s.started_at as created_at, -- Para order by consistência

          -- Lucro Hoje (Subquery)
          COALESCE((
            SELECT SUM(profit) 
            FROM copy_trading_operations 
            WHERE user_id = s.user_id 
            AND result IN ('win', 'loss')
            AND DATE(executed_at) = CURDATE()
          ), 0) as today_profit

        FROM copy_trading_sessions s
        INNER JOIN copy_trading_config c ON s.config_id = c.id
        INNER JOIN users u ON s.user_id = u.id
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE s.trader_id IN (${traderIdsToSearch.map(() => '?').join(',')})
          AND s.status = 'active'
        ORDER BY s.started_at DESC
      `;

      const copiers = await this.dataSource.query(query, traderIdsToSearch);

      this.logger.log(`[GetCopiers] Encontrados ${copiers.length} copiadores COM SESSÃO ATIVA.`);

      // Formatar dados para retorno
      return copiers.map((copier) => {
        // Calcular multiplicador
        const leverageMultiplier = this.parseLeverage(copier.leverage || '1x');
        const multiplier = `${leverageMultiplier}x`;

        // PnL real da sessão
        const pnl = parseFloat(copier.total_profit || '0');

        // Status: Agora sempre será Ativo pois filtramos por sessão ativa
        const isActive = true;
        const tag = 'Ativo';

        const result: any = {
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
          isActive: isActive,
          allocationType: copier.allocation_type,
          allocationValue: parseFloat(copier.allocation_value || '0'),
          allocationPercentage: copier.allocation_percentage ? parseFloat(copier.allocation_percentage) : null,
          derivToken: copier.deriv_token || '',
          totalOperations: parseInt(copier.total_operations || '0', 10),
          sessionStatus: copier.session_status,
          todayProfit: parseFloat(copier.today_profit || '0'),
          derivBalance: parseFloat(copier.user_balance || '0'),
        };

        // ✅ Lógica de Resolução de Token (Igual ao AiService e DerivController)
        const preferredCurrency = (copier.trade_currency || copier.currency || 'USD').toUpperCase();

        let resolvedToken = copier.deriv_token || ''; // Começa com o da config

        // 1. Tentar usar token explícito da tabela users se disponível
        if (preferredCurrency === 'DEMO' && copier.token_demo) {
          resolvedToken = copier.token_demo;
        } else if (preferredCurrency !== 'DEMO' && copier.token_real) {
          resolvedToken = copier.token_real;
        } else {
          // 2. Fallback: lógica antiga via derivRaw se não houver colunas explícitas
          let wantDemo = preferredCurrency === 'DEMO';
          const derivRaw = copier.deriv_raw;

          // Verificar ambiguidade USD no raw
          if (preferredCurrency === 'USD' && derivRaw) {
            try {
              const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
              if (raw?.loginid?.startsWith('VRTC')) {
                wantDemo = true;
              }
            } catch (e) { }
          }

          if (wantDemo) {
            if (derivRaw) {
              try {
                const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
                const tokens = raw.tokensByLoginId || {};
                const entry = Object.entries(tokens).find(([lid]) => (lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              } catch (e) { }
            }
          } else {
            if (derivRaw) {
              try {
                const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
                const tokens = raw.tokensByLoginId || {};
                const entry = Object.entries(tokens).find(([lid]) => !(lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              } catch (e) { }
            }
          }
        }

        result.derivToken = resolvedToken;
        return result;
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
  public async executeCopierTrade(
    userId: string,
    tradeConfig: {
      symbol: string;
      contractType: string;
      duration: number;
      durationUnit: string;
      stakeAmount: number;
      derivToken: string;
      barrier?: number;
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
          barrier: tradeConfig.barrier
        });

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
            contractType: tradeConfig.contractType
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

        (wsService as any).once('error', (error: any) => {
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

