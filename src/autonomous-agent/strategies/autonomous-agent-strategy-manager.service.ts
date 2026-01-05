import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Tick } from '../../ai/ai.service';
import { IAutonomousAgentStrategy } from './common.types';
import { OrionAutonomousStrategy } from './orion.strategy';
import { SentinelStrategy } from './sentinel.strategy';
import { FalconStrategy } from './falcon.strategy';

/**
 * ✅ NOVO: StrategyManager para Agente Autônomo
 * 
 * Similar ao StrategyManager da IA, centraliza o processamento de ticks
 * para todas as estratégias do agente autônomo.
 * 
 * Arquitetura:
 * - Processamento REATIVO (baseado em ticks)
 * - Uma única entrada para todas as estratégias
 * - Processamento em paralelo
 */
@Injectable()
export class AutonomousAgentStrategyManagerService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousAgentStrategyManagerService.name);
  private strategies = new Map<string, IAutonomousAgentStrategy>();

  constructor(
    private readonly orionStrategy: OrionAutonomousStrategy,
    private readonly sentinelStrategy: SentinelStrategy,
    private readonly falconStrategy: FalconStrategy,
  ) {}

  async onModuleInit() {
    // ✅ Registrar apenas Orion (outras desativadas por enquanto)
    this.strategies.set('orion', this.orionStrategy);
    
    // ✅ DESATIVADO: Sentinel e Falcon
    // this.strategies.set('sentinel', this.sentinelStrategy);
    // this.strategies.set('falcon', this.falconStrategy);

    // Inicializar apenas Orion
    await this.orionStrategy.initialize();
    
    // ✅ DESATIVADO: Inicializar outras estratégias
    // await this.sentinelStrategy.initialize();
    // await this.falconStrategy.initialize();

    this.logger.log(
      `[AutonomousAgentStrategyManager] ✅ ${this.strategies.size} estratégia(s) registrada(s): ${Array.from(this.strategies.keys()).join(', ')}`,
    );
  }

  /**
   * ✅ NOVO: Processa um tick para todas as estratégias ativas
   * Similar ao StrategyManager da IA - processamento REATIVO
   * 
   * @param tick - Tick recebido do WebSocket
   * @param symbol - Símbolo do mercado (R_75, R_100, etc.)
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    const promises: Promise<void>[] = [];

    // ✅ ORION: Processa R_100 (ou símbolo padrão)
    const orionStrategy = this.strategies.get('orion');
    if (orionStrategy && typeof (orionStrategy as any).processTick === 'function') {
      // Orion processa R_100 ou símbolo compatível
      if (!symbol || symbol === 'R_100' || symbol === 'R_75') {
        promises.push(
          (orionStrategy as any).processTick(tick).catch((error: any) => {
            this.logger.error('[AutonomousAgentStrategyManager][Orion] Erro:', error);
          })
        );
      }
    }

    // ✅ SENTINEL: Processa R_75 (quando reativado)
    // const sentinelStrategy = this.strategies.get('sentinel');
    // if (sentinelStrategy && symbol === 'R_75') {
    //   promises.push(
    //     (sentinelStrategy as any).processTick(tick).catch((error: any) => {
    //       this.logger.error('[AutonomousAgentStrategyManager][Sentinel] Erro:', error);
    //     })
    //   );
    // }

    // ✅ FALCON: Processa R_75 (quando reativado)
    // const falconStrategy = this.strategies.get('falcon');
    // if (falconStrategy && symbol === 'R_75') {
    //   promises.push(
    //     (falconStrategy as any).processTick(tick).catch((error: any) => {
    //       this.logger.error('[AutonomousAgentStrategyManager][Falcon] Erro:', error);
    //     })
    //   );
    // }

    // Processar todas as estratégias em paralelo
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Ativa um usuário em uma estratégia específica
   */
  async activateUser(strategy: string, userId: string, config: any): Promise<void> {
    const strategyInstance = this.strategies.get(strategy.toLowerCase());
    if (!strategyInstance) {
      throw new Error(`Estratégia '${strategy}' não encontrada`);
    }

    await strategyInstance.activateUser(userId, config);
    this.logger.log(`[AutonomousAgentStrategyManager] Usuário ${userId} ativado na estratégia ${strategy}`);
  }

  /**
   * Desativa um usuário de todas as estratégias
   */
  async deactivateUser(userId: string): Promise<void> {
    await Promise.all(
      Array.from(this.strategies.values()).map(strategy =>
        strategy.deactivateUser(userId).catch((error: any) => {
          this.logger.error(`[AutonomousAgentStrategyManager] Erro ao desativar usuário ${userId}:`, error);
        })
      )
    );
    this.logger.log(`[AutonomousAgentStrategyManager] Usuário ${userId} desativado de todas as estratégias`);
  }

  /**
   * Obtém uma estratégia específica
   */
  getStrategy(strategy: string): IAutonomousAgentStrategy | null {
    return this.strategies.get(strategy.toLowerCase()) || null;
  }

  /**
   * Obtém todas as estratégias registradas
   */
  getAllStrategies(): Map<string, IAutonomousAgentStrategy> {
    return this.strategies;
  }

  /**
   * Verifica se uma estratégia está registrada
   */
  hasStrategy(strategy: string): boolean {
    return this.strategies.has(strategy.toLowerCase());
  }
}

