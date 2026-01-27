import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Tick } from '../../ai/ai.service';
import { IAutonomousAgentStrategy } from './common.types';
import { OrionAutonomousStrategy } from './orion.strategy';
import { SentinelStrategy } from './sentinel.strategy';
import { FalconStrategy } from './falcon.strategy';
import { ZeusStrategy } from './zeus.strategy';

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
    private readonly zeusStrategy: ZeusStrategy,
  ) { }

  async onModuleInit() {
    // ✅ Registrar Orion, Sentinel e Falcon
    this.strategies.set('orion', this.orionStrategy);
    this.strategies.set('sentinel', this.sentinelStrategy);
    this.strategies.set('falcon', this.falconStrategy);
    this.strategies.set('zeus', this.zeusStrategy);

    // Inicializar estratégias
    await this.orionStrategy.initialize();
    await this.sentinelStrategy.initialize();
    await this.falconStrategy.initialize();
    await this.zeusStrategy.initialize();

    this.logger.log(
      `[AutonomousAgentStrategyManager] ✅ ${this.strategies.size} estratégia(s) registrada(s): ${Array.from(this.strategies.keys()).join(', ')}`,
    );
  }

  /**
   * ✅ NOVO: Processa um tick para todas as estratégias ativas
   * Similar ao StrategyManager da IA - processamento REATIVO
   * 
   * @param tick - Tick recebido do WebSocket
   * @param symbol - Símbolo do mercado (sempre R_100 para agentes autônomos)
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    const tickSymbol = symbol || 'R_100'; // ✅ Todos os agentes autônomos usam R_100

    // ✅ ORION: Processa R_100
    const orionStrategy = this.strategies.get('orion');
    if (orionStrategy && typeof (orionStrategy as any).processTick === 'function') {
      if (tickSymbol === 'R_100') {
        promises.push(
          (orionStrategy as any).processTick(tick).catch((error: any) => {
            this.logger.error('[AutonomousAgentStrategyManager][Orion] Erro:', error);
          })
        );
      }
    }

    // ✅ SENTINEL: Processa R_100
    const sentinelStrategy = this.strategies.get('sentinel');
    if (sentinelStrategy && typeof (sentinelStrategy as any).processTick === 'function') {
      if (tickSymbol === 'R_100') {
        promises.push(
          (sentinelStrategy as any).processTick(tick, tickSymbol).catch((error: any) => {
            this.logger.error('[AutonomousAgentStrategyManager][Sentinel] Erro:', error);
          })
        );
      }
    }

    // ✅ FALCON: Processa R_100, 1HZ10V e 1HZ100V
    const falconStrategy = this.strategies.get('falcon');
    if (falconStrategy && typeof (falconStrategy as any).processTick === 'function') {
      if (['R_100', '1HZ10V', '1HZ100V'].includes(tickSymbol)) {
        promises.push(
          (falconStrategy as any).processTick(tick, tickSymbol).catch((error: any) => {
            this.logger.error('[AutonomousAgentStrategyManager][Falcon] Erro:', error);
          })
        );
      }
    }

    // ✅ ZEUS: Processa R_100 e R_50
    const zeusStrategy = this.strategies.get('zeus');
    if (zeusStrategy && typeof (zeusStrategy as any).processTick === 'function') {
      // Zeus agora suporta R_100 e R_50
      if (tickSymbol === 'R_100' || tickSymbol === 'R_50') {
        promises.push(
          (zeusStrategy as any).processTick(tick, tickSymbol).catch((error: any) => {
            this.logger.error('[AutonomousAgentStrategyManager][Zeus] Erro:', error);
          })
        );
      }
    }

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


