import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IAutonomousAgentStrategy } from './common.types';
import { SentinelStrategy } from './sentinel.strategy';
import { FalconStrategy } from './falcon.strategy';
import { OrionAutonomousStrategy } from './orion.strategy';

@Injectable()
export class AgentManagerService implements OnModuleInit {
  private readonly logger = new Logger(AgentManagerService.name);
  private agents = new Map<string, IAutonomousAgentStrategy>();

  constructor(
    private readonly sentinelStrategy: SentinelStrategy,
    private readonly falconStrategy: FalconStrategy,
    private readonly orionStrategy: OrionAutonomousStrategy,
  ) {}

  async onModuleInit() {
    // ✅ REGISTRAR APENAS ORION (outras estratégias desativadas)
    this.agents.set('orion', this.orionStrategy);
    
    // ✅ DESATIVADO: Sentinel e Falcon
    // this.agents.set('sentinel', this.sentinelStrategy);
    // this.agents.set('falcon', this.falconStrategy);

    // Inicializar apenas Orion
    await this.orionStrategy.initialize();
    
    // ✅ DESATIVADO: Inicializar outras estratégias
    // await this.sentinelStrategy.initialize();
    // await this.falconStrategy.initialize();

    this.logger.log(
      `[AgentManager] ✅ ${this.agents.size} agente autônomo registrado: ${Array.from(this.agents.keys()).join(', ')}`,
    );
    this.logger.warn('[AgentManager] ⚠️ Sentinel e Falcon DESATIVADOS - Apenas Orion ativo');
  }

  /**
   * Obtém um agente pelo nome
   */
  getAgent(agentName: string): IAutonomousAgentStrategy | null {
    return this.agents.get(agentName.toLowerCase()) || null;
  }

  /**
   * Lista todos os agentes disponíveis
   */
  getAvailableAgents(): Array<{ name: string; displayName: string; description: string }> {
    return Array.from(this.agents.values()).map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
    }));
  }

  /**
   * Ativa um usuário em um agente específico
   */
  async activateUser(agentName: string, userId: string, config: any): Promise<void> {
    const agent = this.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agente autônomo '${agentName}' não encontrado`);
    }

    await agent.activateUser(userId, config);
    this.logger.log(`[AgentManager] ✅ Usuário ${userId} ativado no agente ${agentName}`);
  }

  /**
   * Desativa um usuário de um agente específico
   */
  async deactivateUser(agentName: string, userId: string): Promise<void> {
    const agent = this.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agente autônomo '${agentName}' não encontrado`);
    }

    await agent.deactivateUser(userId);
    this.logger.log(`[AgentManager] ✅ Usuário ${userId} desativado do agente ${agentName}`);
  }

  /**
   * Processa um agente com análise de mercado
   */
  async processAgent(agentName: string, userId: string, marketAnalysis: any): Promise<any> {
    const agent = this.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agente autônomo '${agentName}' não encontrado`);
    }

    return await agent.processAgent(userId, marketAnalysis);
  }

  /**
   * Processa resultado de contrato
   */
  async onContractFinish(agentName: string, userId: string, result: any): Promise<void> {
    const agent = this.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agente autônomo '${agentName}' não encontrado`);
    }

    await agent.onContractFinish(userId, result);
  }
}


