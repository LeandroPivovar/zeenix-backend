import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Tick } from '../ai.service';
import { IStrategy } from './common.types';
import { OrionStrategy } from './orion.strategy';
import { AtlasStrategy } from './atlas.strategy';
import { ApolloStrategy } from './apollo.strategy';
import { TitanStrategy } from './titan.strategy';
import { NexusStrategy } from './nexus.strategy';

@Injectable()
export class StrategyManagerService implements OnModuleInit {
  private readonly logger = new Logger(StrategyManagerService.name);
  private strategies = new Map<string, IStrategy>();

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private orionStrategy: OrionStrategy,
    private atlasStrategy: AtlasStrategy,
    private apolloStrategy: ApolloStrategy,
    private titanStrategy: TitanStrategy,
    private nexusStrategy: NexusStrategy,
  ) { }

  async onModuleInit() {
    // Registrar estratégias
    this.strategies.set('orion', this.orionStrategy);
    this.strategies.set('atlas', this.atlasStrategy);
    this.strategies.set('apollo', this.apolloStrategy);
    this.strategies.set('titan', this.titanStrategy);
    this.strategies.set('nexus', this.nexusStrategy);

    // Inicializar estratégias
    await this.orionStrategy.initialize();
    await this.atlasStrategy.initialize();
    await this.apolloStrategy.initialize();
    await this.titanStrategy.initialize();
    await this.nexusStrategy.initialize();

    this.logger.log(`[StrategyManager] ✅ ${this.strategies.size} estratégias registradas: ${Array.from(this.strategies.keys()).join(', ')} `);
  }

  /**
   * Processa um tick para todas as estratégias ativas
   * ✅ OTIMIZADO: Processa estratégias em paralelo para reduzir latência
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    const promises: Promise<void>[] = [];

    // ORION agora usa R_100 como símbolo padrão
    if (!symbol || symbol === 'R_100') {
      promises.push(
        this.orionStrategy.processTick(tick, 'R_100').catch(error => {
          this.logger.error('[StrategyManager][Orion] Erro:', error);
        }),
        this.apolloStrategy.processTick(tick, 'R_100').catch(error => {
          this.logger.error('[StrategyManager][Apollo] Erro:', error);
        }),
        this.titanStrategy.processTick(tick, 'R_100').catch(error => {
          this.logger.error('[StrategyManager][Titan] Erro:', error);
        }),
        this.nexusStrategy.processTick(tick, 'R_100').catch(error => {
          this.logger.error('[StrategyManager][Nexus] Erro:', error);
        })
      );
    }

    // ATLAS processa R_10, R_25 e R_100
    if (symbol && ['R_10', 'R_25', 'R_100'].includes(symbol)) {
      promises.push(
        this.atlasStrategy.processTick(tick, symbol).catch(error => {
          this.logger.error('[StrategyManager][Atlas] Erro:', error);
        })
      );
    }

    // Processar todas as estratégias em paralelo
    await Promise.all(promises);
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
    this.logger.log(`[StrategyManager] Usuário ${userId} ativado na estratégia ${strategy} `);
  }

  /**
   * Desativa um usuário de todas as estratégias
   * ✅ OTIMIZADO: Desativa em paralelo
   */
  async deactivateUser(userId: string): Promise<void> {
    await Promise.all(
      Array.from(this.strategies.values()).map(strategy =>
        strategy.deactivateUser(userId).catch(error => {
          this.logger.error(`[StrategyManager] Erro ao desativar usuário ${userId}:`, error);
        })
      )
    );
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

  getAtlasStrategy(): AtlasStrategy {
    return this.atlasStrategy;
  }

  getApolloStrategy(): ApolloStrategy {
    return this.apolloStrategy;
  }
}

