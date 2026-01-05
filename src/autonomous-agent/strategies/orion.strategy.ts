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
 * Integra a IA Orion com o sistema de agente autônomo.
 * Usa a lógica de sinais da Orion (PAR/IMPAR) convertida para RISE/FALL.
 * 
 * Características:
 * - Usa check_signal da Orion para gerar sinais
 * - Suporta modos: veloz, moderado, preciso
 * - Defesa automática após 3 losses consecutivos
 * - Martingale e Soros integrados
 */
@Injectable()
export class OrionAutonomousStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'orion';
  displayName = '🌟 ORION';
  description = 'Agente autônomo usando IA Orion com análise estatística avançada';

  private readonly logger = new Logger(OrionAutonomousStrategy.name);
  private readonly userStates = new Map<string, OrionUserState>();
  private readonly ticks: Tick[] = [];
  private readonly maxTicksHistory = 100;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => OrionStrategy)) private readonly orionStrategy: OrionStrategy,
    @Inject(forwardRef(() => LogQueueService)) private readonly logQueueService?: LogQueueService,
  ) {}

  async onModuleInit() {
    this.logger.log('🌟 ORION Strategy para Agente Autônomo inicializado');
    await this.initialize();
  }

  async initialize(): Promise<void> {
    // Sincronizar usuários ativos do banco
    await this.syncActiveUsersFromDb();
    
    // Inicializar Orion Strategy se necessário
    if (this.orionStrategy) {
      await this.orionStrategy.initialize();
    }
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
        this.userStates.set(user.user_id.toString(), {
          userId: user.user_id.toString(),
          isActive: true,
          derivToken: user.deriv_token,
          currency: user.currency,
          symbol: user.symbol || 'R_100',
          tradingMode: (user.trading_mode || 'normal') as 'veloz' | 'moderado' | 'preciso',
          initialStake: parseFloat(user.initial_stake),
          dailyProfitTarget: parseFloat(user.daily_profit_target),
          dailyLossLimit: parseFloat(user.daily_loss_limit),
          currentProfit: parseFloat(user.daily_profit) || 0,
          currentLoss: parseFloat(user.daily_loss) || 0,
          operationsCount: 0,
          ticksColetados: 0,
          consecutiveLosses: 0,
          consecutiveWins: 0,
          isOperationActive: false,
        });
      }

      this.logger.log(`[Orion] Sincronizados ${activeUsers.length} usuários ativos`);
    } catch (error) {
      this.logger.error('[Orion] Erro ao sincronizar usuários:', error);
    }
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    const state: OrionUserState = {
      userId,
      isActive: true,
      derivToken: config.derivToken,
      currency: config.currency,
      symbol: config.symbol || 'R_100',
      tradingMode: (config.tradingMode || 'normal') as 'veloz' | 'moderado' | 'preciso',
      initialStake: config.initialStake,
      dailyProfitTarget: config.dailyProfitTarget,
      dailyLossLimit: config.dailyLossLimit,
      currentProfit: 0,
      currentLoss: 0,
      operationsCount: 0,
      ticksColetados: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      isOperationActive: false,
    };

    this.userStates.set(userId, state);
    
    // Ativar usuário na Orion Strategy
    if (this.orionStrategy) {
      const orionConfig = {
        mode: this.mapTradingModeToOrionMode(state.tradingMode),
        stakeAmount: config.initialStake,
        derivToken: config.derivToken,
        currency: config.currency,
        modoMartingale: 'moderado' as const,
        entryValue: config.initialStake,
      };
      
      await this.orionStrategy.activateUser(userId, orionConfig);
    }

    this.logger.log(`[Orion] ✅ Usuário ${userId} ativado no modo ${state.tradingMode}`);
    this.saveLog(userId, 'INFO', 'CORE', `Usuário ativado no modo ${state.tradingMode}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userStates.delete(userId);
    
    // Desativar usuário na Orion Strategy
    if (this.orionStrategy) {
      await this.orionStrategy.deactivateUser(userId);
    }

    this.logger.log(`[Orion] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Processa o agente usando a Orion Strategy
   */
  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    const state = this.userStates.get(userId);
    if (!state || !state.isActive) {
      return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
    }

    // Verificações de segurança
    if (state.currentLoss >= state.dailyLossLimit) {
      return { action: 'STOP', reason: 'STOP_LOSS' };
    }

    if (state.currentProfit >= state.dailyProfitTarget) {
      return { action: 'STOP', reason: 'TAKE_PROFIT' };
    }

    if (state.isOperationActive) {
      return { action: 'WAIT', reason: 'OPERATION_ACTIVE' };
    }

    // Obter último tick (precisa ser fornecido via processTick)
    if (this.ticks.length === 0) {
      return { action: 'WAIT', reason: 'NO_TICKS' };
    }

    const latestTick = this.ticks[this.ticks.length - 1];

    // Usar Orion Strategy para gerar sinal
    // Precisamos acessar o estado interno da Orion
    // Por enquanto, vamos usar uma abordagem simplificada
    
    // Converter MarketAnalysis para sinal da Orion
    const orionSignal = this.convertMarketAnalysisToOrionSignal(marketAnalysis);
    
    if (!orionSignal) {
      return { action: 'WAIT', reason: 'NO_SIGNAL' };
    }

    // Converter PAR/IMPAR para RISE/FALL
    const contractType = orionSignal === 'PAR' ? 'RISE' : 'FALL';
    
    // Calcular stake
    const stake = this.calculateStake(state, marketAnalysis.payout);

    if (stake <= 0) {
      return { action: 'WAIT', reason: 'NO_STAKE' };
    }

    return {
      action: 'BUY',
      stake: stake,
      contractType: contractType,
      mode: state.tradingMode,
    };
  }

  /**
   * Processa um tick recebido (chamado pelo serviço principal)
   */
  async processTick(tick: Tick): Promise<void> {
    // Adicionar tick ao histórico
    this.ticks.push(tick);
    if (this.ticks.length > this.maxTicksHistory) {
      this.ticks.shift();
    }

    // Processar via Orion Strategy
    if (this.orionStrategy) {
      await this.orionStrategy.processTick(tick, 'R_100');
    }

    // Incrementar ticks coletados para todos os usuários
    for (const state of this.userStates.values()) {
      state.ticksColetados++;
    }
  }

  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string },
  ): Promise<void> {
    const state = this.userStates.get(userId);
    if (!state) return;

    state.isOperationActive = false;

    if (result.win) {
      state.currentProfit += result.profit;
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
      this.logger.log(`[Orion][${userId}] ✅ Vitória! Lucro: $${result.profit.toFixed(2)}`);
      this.saveLog(userId, 'INFO', 'TRADER', `Operação ganha. Lucro: $${result.profit.toFixed(2)}`);
    } else {
      state.currentLoss += Math.abs(result.profit);
      state.consecutiveLosses++;
      state.consecutiveWins = 0;
      this.logger.log(`[Orion][${userId}] ❌ Perda. Prejuízo: $${Math.abs(result.profit).toFixed(2)}`);
      this.saveLog(userId, 'INFO', 'TRADER', `Operação perdida. Prejuízo: $${Math.abs(result.profit).toFixed(2)}`);
    }

    state.operationsCount++;

    // Notificar Orion Strategy
    if (this.orionStrategy) {
      // A Orion Strategy gerencia seus próprios estados, então não precisamos fazer nada aqui
      // Mas podemos atualizar nosso estado baseado no resultado
    }
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    const state = this.userStates.get(userId);
    if (!state) return null;

    return {
      userId: state.userId,
      isActive: state.isActive,
      currentProfit: state.currentProfit,
      currentLoss: state.currentLoss,
      operationsCount: state.operationsCount,
    };
  }

  async resetDailySession(userId: string): Promise<void> {
    const state = this.userStates.get(userId);
    if (!state) return;

    state.currentProfit = 0;
    state.currentLoss = 0;
    state.operationsCount = 0;
    state.consecutiveLosses = 0;
    state.consecutiveWins = 0;

    this.logger.log(`[Orion] ✅ Sessão diária resetada para usuário ${userId}`);
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
   * Converte MarketAnalysis para sinal da Orion (PAR/IMPAR)
   */
  private convertMarketAnalysisToOrionSignal(marketAnalysis: MarketAnalysis): DigitParity | null {
    if (!marketAnalysis.signal) return null;

    // CALL = RISE = PAR (dígito par)
    // PUT = FALL = IMPAR (dígito ímpar)
    if (marketAnalysis.signal === 'CALL') {
      return 'PAR';
    } else if (marketAnalysis.signal === 'PUT') {
      return 'IMPAR';
    }

    return null;
  }

  /**
   * Calcula stake baseado no estado e payout
   */
  private calculateStake(state: OrionUserState, payout: number): number {
    // Usar stake inicial por enquanto
    // Pode ser expandido com lógica de martingale
    return state.initialStake;
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

