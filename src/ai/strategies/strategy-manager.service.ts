import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Tick } from '../ai.service';
import { IStrategy } from './common.types';
import { OrionStrategy } from './orion.strategy';
import { TrinityStrategy } from './trinity.strategy';

@Injectable()
export class StrategyManagerService implements OnModuleInit {
  private readonly logger = new Logger(StrategyManagerService.name);
  private strategies = new Map<string, IStrategy>();

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private orionStrategy: OrionStrategy,
    private trinityStrategy: TrinityStrategy,
  ) {}

  async onModuleInit() {
    // Registrar estratégias
    this.strategies.set('orion', this.orionStrategy);
    this.strategies.set('trinity', this.trinityStrategy);

    // Inicializar estratégias
    await this.orionStrategy.initialize();
    await this.trinityStrategy.initialize();

    this.logger.log(`[StrategyManager] ✅ ${this.strategies.size} estratégias registradas: ${Array.from(this.strategies.keys()).join(', ')}`);
  }

  /**
   * Processa um tick para todas as estratégias ativas
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    // ORION processa apenas R_10 (symbol padrão)
    if (!symbol || symbol === 'R_10') {
      await this.orionStrategy.processTick(tick, 'R_10');
    }

    // TRINITY processa R_10, R_25, R_50
    if (symbol && ['R_10', 'R_25', 'R_50'].includes(symbol)) {
      await this.trinityStrategy.processTick(tick, symbol);
    }
  }

  /**
   * Ativa um usuário em uma estratégia específica
   */
  async activateUser(userId: string, strategy: string, config: any): Promise<void> {
    const strategyInstance = this.strategies.get(strategy.toLowerCase());
    if (!strategyInstance) {
      throw new Error(`Estratégia '${strategy}' não encontrada`);
    }

    await strategyInstance.activateUser(userId, config);
    this.logger.log(`[StrategyManager] Usuário ${userId} ativado na estratégia ${strategy}`);
  }

  /**
   * Desativa um usuário de todas as estratégias
   */
  async deactivateUser(userId: string): Promise<void> {
    for (const strategy of this.strategies.values()) {
      await strategy.deactivateUser(userId);
    }
    this.logger.log(`[StrategyManager] Usuário ${userId} desativado de todas as estratégias`);
  }

  /**
   * Obtém o estado de um usuário em uma estratégia específica
   */
  getUserState(userId: string, strategy: string): any {
    const strategyInstance = this.strategies.get(strategy.toLowerCase());
    if (!strategyInstance) {
      return null;
    }
    return strategyInstance.getUserState(userId);
  }

  /**
   * Obtém uma estratégia específica
   */
  getStrategy(strategy: string): IStrategy | null {
    return this.strategies.get(strategy.toLowerCase()) || null;
  }

  /**
   * Obtém todas as estratégias registradas
   */
  getAllStrategies(): Map<string, IStrategy> {
    return this.strategies;
  }

  /**
   * Verifica se uma estratégia está registrada
   */
  hasStrategy(strategy: string): boolean {
    return this.strategies.has(strategy.toLowerCase());
  }

  // Getters para acesso direto às estratégias
  getOrionStrategy(): OrionStrategy {
    return this.orionStrategy;
  }

  getTrinityStrategy(): TrinityStrategy {
    return this.trinityStrategy;
  }
}

