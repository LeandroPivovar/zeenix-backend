import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  IAutonomousAgentStrategy,
  AutonomousAgentConfig,
  AutonomousAgentState,
  MarketAnalysis,
  TradeDecision,
} from './common.types';
import { OrionStrategy } from '../../ai/strategies/orion.strategy';
import { Tick, DigitParity } from '../../ai/ai.service';
import { LogQueueService } from '../../utils/log-queue.service';

/**
 * 🌟 ORION Strategy para Agente Autônomo
 * 
 * ✅ REFATORADO: Usa 100% a IA Orion
 * 
 * Esta estratégia é um wrapper que delega TODAS as operações para a OrionStrategy da IA.
 * A OrionStrategy já possui toda a lógica de:
 * - Processamento de ticks
 * - Geração de sinais (check_signal)
 * - Execução de operações (executeOrionOperation)
 * - Gerenciamento de stop loss/win/blindado
 * - Martingale e Soros
 * 
 * O agente autônomo apenas:
 * - Gerencia configurações específicas (daily_profit_target, daily_loss_limit)
 * - Monitora sessões diárias (parar no dia após stop loss/win/blindado)
 * - Reseta sessões no próximo dia
 */
@Injectable()
export class OrionAutonomousStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'orion';
  displayName = '🌟 ORION';
  description = 'Agente autônomo usando IA Orion com análise estatística avançada';

  private readonly logger = new Logger(OrionAutonomousStrategy.name);
  private readonly userConfigs = new Map<string, AutonomousAgentConfig>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => OrionStrategy)) private readonly orionStrategy: OrionStrategy,
    @Inject(forwardRef(() => LogQueueService)) private readonly logQueueService?: LogQueueService,
  ) {}

  async onModuleInit() {
    this.logger.log('🌟 ORION Strategy para Agente Autônomo inicializado (100% IA Orion)');
    await this.initialize();
  }

  async initialize(): Promise<void> {
    // Inicializar Orion Strategy
    if (this.orionStrategy) {
      await this.orionStrategy.initialize();
    }
    
    // Sincronizar usuários ativos do banco
    await this.syncActiveUsersFromDb();
  }

  /**
   * Sincroniza usuários ativos do banco de dados
   */
  private async syncActiveUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT user_id, initial_stake, daily_profit_target, daily_loss_limit, 
                initial_balance, deriv_token, currency, symbol, agent_type, trading_mode
         FROM autonomous_agent_config 
         WHERE is_active = TRUE AND agent_type = 'orion'`,
      );

      for (const user of activeUsers) {
        const config: AutonomousAgentConfig = {
          initialStake: parseFloat(user.initial_stake),
          dailyProfitTarget: parseFloat(user.daily_profit_target),
          dailyLossLimit: parseFloat(user.daily_loss_limit),
          derivToken: user.deriv_token,
          currency: user.currency,
          symbol: user.symbol || 'R_100',
          tradingMode: (user.trading_mode || 'normal') as 'veloz' | 'moderado' | 'preciso',
          initialBalance: parseFloat(user.initial_balance) || 0,
        };

        this.userConfigs.set(user.user_id.toString(), config);
        
        // Ativar usuário na Orion Strategy
        await this.activateUserInOrion(user.user_id.toString(), config);
      }

      this.logger.log(`[Orion] Sincronizados ${activeUsers.length} usuários ativos`);
    } catch (error) {
      this.logger.error('[Orion] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Ativa usuário na Orion Strategy da IA
   */
  private async activateUserInOrion(userId: string, config: AutonomousAgentConfig): Promise<void> {
    if (!this.orionStrategy) {
      this.logger.error('[Orion] OrionStrategy não disponível');
      return;
    }

    // Converter configuração do agente autônomo para configuração da Orion
    const orionConfig = {
      mode: this.mapTradingModeToOrionMode(config.tradingMode),
      stakeAmount: config.initialBalance || config.initialStake, // Capital total
      derivToken: config.derivToken,
      currency: config.currency,
      modoMartingale: 'moderado' as const,
      entryValue: config.initialStake, // Valor de entrada por operação
    };

    await this.orionStrategy.activateUser(userId, orionConfig);
    this.logger.log(`[Orion] ✅ Usuário ${userId} ativado na Orion Strategy (modo: ${orionConfig.mode})`);
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    this.userConfigs.set(userId, config);
    
    // Ativar usuário na Orion Strategy
    await this.activateUserInOrion(userId, config);

    // Salvar configuração no banco (já feito pelo AutonomousAgentService)
    this.logger.log(`[Orion] ✅ Usuário ${userId} ativado no modo ${config.tradingMode}`);
    this.saveLog(userId, 'INFO', 'CORE', `Usuário ativado no modo ${config.tradingMode}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userConfigs.delete(userId);
    
    // Desativar usuário na Orion Strategy
    if (this.orionStrategy) {
      await this.orionStrategy.deactivateUser(userId);
    }

    this.logger.log(`[Orion] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Processa um tick recebido (chamado pelo serviço principal)
   * ✅ Delega 100% para a Orion Strategy
   */
  async processTick(tick: Tick): Promise<void> {
    // Processar via Orion Strategy (ela já gerencia tudo)
    if (this.orionStrategy) {
      await this.orionStrategy.processTick(tick, 'R_100');
    }
  }

  /**
   * Processa o agente usando a Orion Strategy
   * ✅ Não é mais usado - a Orion Strategy processa diretamente via processTick
   */
  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    // A Orion Strategy já processa tudo via processTick
    // Este método é mantido apenas para compatibilidade
    return { action: 'WAIT', reason: 'PROCESSED_BY_ORION' };
  }

  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string },
  ): Promise<void> {
    // A Orion Strategy já gerencia os resultados
    // Aqui apenas atualizamos o banco de dados do agente autônomo
    
    const config = this.userConfigs.get(userId);
    if (!config) return;

    try {
      // Atualizar lucro/perda diária no banco
      const currentStats = await this.dataSource.query(
        `SELECT daily_profit, daily_loss, session_status
         FROM autonomous_agent_config 
         WHERE user_id = ? AND is_active = TRUE
         LIMIT 1`,
        [userId],
      );

      if (currentStats && currentStats.length > 0) {
        const stats = currentStats[0];
        let newProfit = parseFloat(stats.daily_profit) || 0;
        let newLoss = parseFloat(stats.daily_loss) || 0;
        let sessionStatus = stats.session_status || 'active';

        if (result.win) {
          newProfit += result.profit;
          this.logger.log(`[Orion][${userId}] ✅ Vitória! Lucro: $${result.profit.toFixed(2)}`);
          this.saveLog(userId, 'INFO', 'TRADER', `Operação ganha. Lucro: $${result.profit.toFixed(2)}`);
        } else {
          newLoss += Math.abs(result.profit);
          this.logger.log(`[Orion][${userId}] ❌ Perda. Prejuízo: $${Math.abs(result.profit).toFixed(2)}`);
          this.saveLog(userId, 'INFO', 'TRADER', `Operação perdida. Prejuízo: $${Math.abs(result.profit).toFixed(2)}`);
        }

        // Verificar stop loss/win/blindado e parar no dia se necessário
        if (newLoss >= config.dailyLossLimit && sessionStatus === 'active') {
          sessionStatus = 'stopped_loss';
          this.logger.warn(`[Orion][${userId}] 🛑 STOP LOSS ATINGIDO! Perda: $${newLoss.toFixed(2)} >= Limite: $${config.dailyLossLimit.toFixed(2)}`);
          this.saveLog(userId, 'WARN', 'RISK', `Stop Loss atingido. Perda: $${newLoss.toFixed(2)} | Limite: $${config.dailyLossLimit.toFixed(2)} - Parando no dia`);
        } else if (newProfit >= config.dailyProfitTarget && sessionStatus === 'active') {
          sessionStatus = 'stopped_profit';
          this.logger.log(`[Orion][${userId}] 🎯 STOP WIN ATINGIDO! Lucro: $${newProfit.toFixed(2)} >= Meta: $${config.dailyProfitTarget.toFixed(2)}`);
          this.saveLog(userId, 'INFO', 'RISK', `Stop Win atingido. Lucro: $${newProfit.toFixed(2)} | Meta: $${config.dailyProfitTarget.toFixed(2)} - Parando no dia`);
        }

        // Atualizar banco de dados
        await this.dataSource.query(
          `UPDATE autonomous_agent_config 
           SET daily_profit = ?,
               daily_loss = ?,
               session_status = ?,
               updated_at = NOW()
           WHERE user_id = ? AND is_active = TRUE`,
          [newProfit, newLoss, sessionStatus, userId],
        );

        // Se parou no dia, desativar na Orion Strategy (mas manter is_active = TRUE no banco)
        if (sessionStatus !== 'active') {
          if (this.orionStrategy) {
            await this.orionStrategy.deactivateUser(userId);
          }
          this.logger.log(`[Orion][${userId}] ⏸️ Agente parado no dia (status: ${sessionStatus}). Continuará no próximo dia.`);
        }
      }
    } catch (error) {
      this.logger.error(`[Orion][onContractFinish] Erro ao atualizar banco:`, error);
    }
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    try {
      const stats = await this.dataSource.query(
        `SELECT daily_profit, daily_loss, total_trades, total_wins, total_losses, is_active
         FROM autonomous_agent_config 
         WHERE user_id = ? AND is_active = TRUE
         LIMIT 1`,
        [userId],
      );

      if (!stats || stats.length === 0) {
        return null;
      }

      const stat = stats[0];
      return {
        userId,
        isActive: stat.is_active === 1 || stat.is_active === true,
        currentProfit: parseFloat(stat.daily_profit) || 0,
        currentLoss: parseFloat(stat.daily_loss) || 0,
        operationsCount: parseInt(stat.total_trades) || 0,
      };
    } catch (error) {
      this.logger.error(`[Orion][getUserState] Erro:`, error);
      return null;
    }
  }

  async resetDailySession(userId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET daily_profit = 0,
             daily_loss = 0,
             session_status = 'active',
             session_date = NOW(),
             updated_at = NOW()
         WHERE user_id = ? AND is_active = TRUE`,
        [userId],
      );

      // Reativar na Orion Strategy se necessário
      const config = this.userConfigs.get(userId);
      if (config) {
        await this.activateUserInOrion(userId, config);
      }

      this.logger.log(`[Orion] ✅ Sessão diária resetada para usuário ${userId}`);
    } catch (error) {
      this.logger.error(`[Orion][resetDailySession] Erro:`, error);
    }
  }

  // ============================================
  // MÉTODOS AUXILIARES
  // ============================================

  /**
   * Mapeia trading mode do agente autônomo para modo da Orion
   */
  private mapTradingModeToOrionMode(
    mode: 'veloz' | 'moderado' | 'preciso' | 'normal' | 'lento',
  ): 'veloz' | 'moderado' | 'preciso' | 'lenta' {
    switch (mode) {
      case 'veloz':
        return 'veloz';
      case 'moderado':
      case 'normal':
        return 'moderado';
      case 'preciso':
        return 'preciso';
      case 'lento':
        return 'lenta';
      default:
        return 'moderado';
    }
  }

  /**
   * Salva log usando LogQueueService
   */
  private saveLog(userId: string, level: string, module: string, message: string, metadata?: any): void {
    if (this.logQueueService) {
      this.logQueueService.saveLogAsync({
        userId,
        level: level as 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
        module: module as 'CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER',
        message,
        metadata,
        tableName: 'autonomous_agent_logs',
      });
    }
  }
}

// ============================================
// INTERFACES
// ============================================

interface OrionUserState {
  userId: string;
  isActive: boolean;
  derivToken: string;
  currency: string;
  symbol: string;
  tradingMode: 'veloz' | 'moderado' | 'preciso';
  initialStake: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  currentProfit: number;
  currentLoss: number;
  operationsCount: number;
  ticksColetados: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  isOperationActive: boolean;
}


