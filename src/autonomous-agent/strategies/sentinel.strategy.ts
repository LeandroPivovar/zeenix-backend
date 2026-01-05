import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import {
  IAutonomousAgentStrategy,
  AutonomousAgentConfig,
  AutonomousAgentState,
  MarketAnalysis,
  TradeDecision,
} from './common.types';
import { AutonomousAgentService } from '../autonomous-agent.service';

/**
 * 🛡️ SENTINEL Strategy
 * 
 * Agente autônomo original com estratégia completa de Martingale Inteligente e Soros.
 * 
 * Características:
 * - Martingale Inteligente: Muda contrato (Rise/Fall → Higher/Lower) em vez de apenas aumentar stake
 * - Soros Nível 2: Alavancagem de lucros em até 2 níveis
 * - Múltiplos modos: Veloz, Normal, Lento
 * - Gestão de risco: Conservador, Moderado, Agressivo
 * - Stop Loss: Normal ou Blindado
 */
@Injectable()
export class SentinelStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'sentinel';
  displayName = '🛡️ SENTINEL';
  description = 'Agente autônomo com Martingale Inteligente e Soros Nível 2';

  private readonly logger = new Logger(SentinelStrategy.name);

  constructor(
    @Inject(forwardRef(() => AutonomousAgentService))
    private readonly agentService: AutonomousAgentService,
  ) {}

  async onModuleInit() {
    this.logger.log('🛡️ SENTINEL Strategy inicializado');
  }

  async initialize(): Promise<void> {
    // O SENTINEL usa o serviço principal que já está inicializado
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    // Delegar para o serviço principal
    await this.agentService.activateAgent(userId, {
      initialStake: config.initialStake,
      dailyProfitTarget: config.dailyProfitTarget,
      dailyLossLimit: config.dailyLossLimit,
      derivToken: config.derivToken,
      currency: config.currency,
      symbol: config.symbol,
      initialBalance: config.initialBalance,
      agentType: 'sentinel', // ✅ Especificar tipo de agente
      // Configurações específicas do SENTINEL (se necessário)
      strategy: (config as any).strategy || 'arion',
      riskLevel: (config as any).riskLevel || 'balanced',
      tradingMode: (config as any).tradingMode || 'normal',
      stopLossType: (config as any).stopLossType || 'normal',
    });
  }

  async deactivateUser(userId: string): Promise<void> {
    // Delegar para o serviço principal
    await this.agentService.deactivateAgent(userId);
  }

  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    // O SENTINEL tem sua própria lógica de processamento no serviço principal
    // Este método será chamado pelo scheduler, mas a lógica real está no processActiveAgents
    // Por enquanto, retornar WAIT pois o processamento é feito pelo scheduler
    return { action: 'WAIT', reason: 'PROCESSED_BY_SCHEDULER' };
  }

  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string },
  ): Promise<void> {
    // O SENTINEL processa resultados internamente no serviço principal
    // Este método pode ser usado para notificações adicionais se necessário
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    // Obter estado do serviço principal
    const config = await this.agentService.getAgentConfig(userId);
    if (!config) return null;

    return {
      userId,
      isActive: config.isActive,
      currentProfit: config.dailyProfit || 0,
      currentLoss: config.dailyLoss || 0,
      operationsCount: config.totalTrades || 0,
    };
  }

  async resetDailySession(userId: string): Promise<void> {
    // O reset é feito pelo scheduler no serviço principal
    // Este método pode ser usado para reset específico se necessário
  }
}

