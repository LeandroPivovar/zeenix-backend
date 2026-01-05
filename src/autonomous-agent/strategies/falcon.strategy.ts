import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  IAutonomousAgentStrategy,
  AutonomousAgentConfig,
  AutonomousAgentState,
  MarketAnalysis,
  TradeDecision,
} from './common.types';
import { SettingsService } from '../../settings/settings.service';
import { DerivService } from '../../broker/deriv.service';

/**
 * 🦅 FALCON Strategy
 * 
 * Agente autônomo de alta precisão projetado para operar no Volatility 75 Index.
 * Prioriza segurança estatística com precisão cirúrgica (>80% normal, >90% recuperação).
 * 
 * Características:
 * - Precisão Cirúrgica: Só entra em operações com probabilidade >80% (normal) ou >90% (recuperação)
 * - Recuperação Inteligente: Ativa "Modo Sniper" imediatamente após qualquer perda
 * - Gestão Blindada: Sistema de travas que impede devolução de lucros (Efeito Catraca)
 * - Soros Nível 1: Alavancagem de lucros após vitórias
 */
@Injectable()
export class FalconStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'falcon';
  displayName = '🦅 FALCON';
  description = 'Agente de alta precisão com recuperação inteligente e gestão blindada';

  private readonly logger = new Logger(FalconStrategy.name);
  private readonly userStates = new Map<string, FalconUserState>();
  private readonly appId = process.env.DERIV_APP_ID || '1089';
  private readonly comissaoPlataforma = 0.03; // 3%

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @Inject(SettingsService) private readonly settingsService?: SettingsService,
    @Optional() @Inject(DerivService) private readonly derivService?: DerivService,
  ) {}

  async onModuleInit() {
    this.logger.log('🦅 FALCON Strategy inicializado');
    await this.syncActiveUsersFromDb();
  }

  async initialize(): Promise<void> {
    // Inicialização adicional se necessário
  }

  /**
   * Sincroniza usuários ativos do banco de dados
   */
  private async syncActiveUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT user_id, initial_stake, daily_profit_target, daily_loss_limit, 
                initial_balance, deriv_token, currency, symbol, agent_type
         FROM autonomous_agent_config 
         WHERE is_active = TRUE AND agent_type = 'falcon'`,
      );

      for (const user of activeUsers) {
        this.userStates.set(user.user_id.toString(), {
          userId: user.user_id.toString(),
          isActive: true,
          saldoInicial: parseFloat(user.initial_balance) || 0,
          lucroAtual: parseFloat(user.daily_profit) || 0,
          picoLucro: parseFloat(user.profit_peak) || 0,
          consecutiveLosses: 0,
          consecutiveWins: 0,
          opsCount: 0,
          mode: 'PRECISO', // 'PRECISO' ou 'ALTA_PRECISAO'
          stopBlindadoAtivo: false,
          pisoBlindado: 0,
          lastProfit: 0,
          config: {
            stakeInicial: parseFloat(user.initial_stake),
            metaLucro: parseFloat(user.daily_profit_target),
            limitePerda: parseFloat(user.daily_loss_limit),
          },
        });
      }

      this.logger.log(`[Falcon] Sincronizados ${activeUsers.length} usuários ativos`);
    } catch (error) {
      this.logger.error('[Falcon] Erro ao sincronizar usuários:', error);
    }
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    // Implementação será feita integrando com o serviço principal
    // Por enquanto, apenas criar estado
    const state: FalconUserState = {
      userId,
      isActive: true,
      saldoInicial: config.initialBalance || 0,
      lucroAtual: 0,
      picoLucro: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      opsCount: 0,
      mode: 'PRECISO',
      stopBlindadoAtivo: false,
      pisoBlindado: 0,
      lastProfit: 0,
      config: {
        stakeInicial: config.initialStake,
        metaLucro: config.dailyProfitTarget,
        limitePerda: config.dailyLossLimit,
      },
    };

    this.userStates.set(userId, state);
    this.logger.log(`[Falcon] ✅ Usuário ${userId} ativado`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userStates.delete(userId);
    this.logger.log(`[Falcon] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Atualiza o modo do agente baseado em vitória/derrota
   */
  private updateMode(state: FalconUserState, win: boolean): void {
    if (win) {
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
      state.mode = 'PRECISO'; // Reseta para modo normal após vitória
    } else {
      state.consecutiveWins = 0;
      state.consecutiveLosses++;
      // RECUPERAÇÃO IMEDIATA: Qualquer perda ativa o modo Sniper
      state.mode = 'ALTA_PRECISAO';
      this.logger.log(
        `[Falcon][${state.userId}] ⚠️ LOSS DETECTADO: Ativando Modo ALTA PRECISÃO (>90%) para recuperação imediata.`,
      );
    }
  }

  /**
   * Calcula o stake baseado no modo e situação
   */
  private calculateStake(state: FalconUserState, marketPayoutPercent: number): number {
    let stake = state.config.stakeInicial;
    const realPayout = (marketPayoutPercent - marketPayoutPercent * this.comissaoPlataforma) / 100;

    // Lógica para Modo ALTA PRECISÃO (Recuperação)
    if (state.mode === 'ALTA_PRECISAO') {
      // Recuperar perdas + 25% de lucro sobre a perda
      const lossToRecover = Math.abs(Math.min(0, state.lucroAtual));
      if (lossToRecover > 0) {
        const targetProfit = lossToRecover * 0.25;
        const totalNeeded = lossToRecover + targetProfit;
        stake = totalNeeded / realPayout;
        this.logger.log(
          `[Falcon][${state.userId}] 🚑 RECUPERAÇÃO: Buscando ${totalNeeded.toFixed(2)} (Stake: ${stake.toFixed(2)})`,
        );
      } else {
        // Se estiver no modo Alta Precisão mas sem prejuízo acumulado, usa stake base
        stake = state.config.stakeInicial;
      }
    }
    // Lógica para Modo PRECISO (Soros Nível 1)
    else {
      if (state.consecutiveWins === 1) {
        stake = state.config.stakeInicial + state.lastProfit;
        this.logger.log(`[Falcon][${state.userId}] 🚀 SOROS NÍVEL 1: Stake ${stake.toFixed(2)}`);
      }
    }

    return this.adjustStakeForStopLoss(state, stake);
  }

  /**
   * Ajusta o stake para respeitar o stop loss restante
   */
  private adjustStakeForStopLoss(state: FalconUserState, calculatedStake: number): number {
    const remainingLossLimit = state.config.limitePerda + state.lucroAtual;
    if (remainingLossLimit <= 0) return 0; // Stop já atingido

    if (calculatedStake > remainingLossLimit) {
      this.logger.log(
        `[Falcon][${state.userId}] ⛔ STAKE AJUSTADA PELO STOP: De ${calculatedStake.toFixed(2)} para ${remainingLossLimit.toFixed(2)}`,
      );
      return remainingLossLimit;
    }

    return calculatedStake;
  }

  /**
   * Verifica e gerencia o Stop Loss Blindado (Efeito Catraca)
   */
  private checkBlindado(state: FalconUserState): boolean {
    // Verifica Ativação (40% da Meta)
    if (!state.stopBlindadoAtivo) {
      if (state.lucroAtual >= state.config.metaLucro * 0.40) {
        state.stopBlindadoAtivo = true;
        state.picoLucro = state.lucroAtual;
        state.pisoBlindado = state.picoLucro * 0.50;
        this.logger.log(
          `[Falcon][${state.userId}] 🔒 STOP BLINDADO ATIVADO! Piso: ${state.pisoBlindado.toFixed(2)}`,
        );
      }
    }
    // Atualização Dinâmica (Trailing Stop)
    else {
      if (state.lucroAtual > state.picoLucro) {
        state.picoLucro = state.lucroAtual;
        state.pisoBlindado = state.picoLucro * 0.50;
        this.logger.log(
          `[Falcon][${state.userId}] 🔒 BLINDAGEM SUBIU! Novo Piso: ${state.pisoBlindado.toFixed(2)}`,
        );
      }

      // Gatilho de Saída
      if (state.lucroAtual <= state.pisoBlindado) {
        this.logger.log(`[Falcon][${state.userId}] 🛑 STOP BLINDADO ATINGIDO. Encerrando operações.`);
        return false; // Deve parar
      }
    }

    return true; // Pode continuar
  }

  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    const state = this.userStates.get(userId);
    if (!state || !state.isActive) {
      return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
    }

    // A. Verificações de Segurança (Hard Stops)
    if (state.lucroAtual <= -state.config.limitePerda) {
      return { action: 'STOP', reason: 'STOP_LOSS' };
    }

    if (state.lucroAtual >= state.config.metaLucro) {
      return { action: 'STOP', reason: 'TAKE_PROFIT' };
    }

    if (!this.checkBlindado(state)) {
      return { action: 'STOP', reason: 'BLINDADO' };
    }

    // B. Filtro de Precisão
    const requiredProb = state.mode === 'ALTA_PRECISAO' ? 90 : 80;
    if (marketAnalysis.probability >= requiredProb) {
      const stake = this.calculateStake(state, marketAnalysis.payout);
      if (stake <= 0) {
        return { action: 'WAIT', reason: 'NO_STAKE' };
      }

      return {
        action: 'BUY',
        stake: stake,
        contractType: marketAnalysis.signal || 'CALL',
        mode: state.mode,
      };
    }

    return { action: 'WAIT', reason: 'LOW_PROBABILITY' };
  }

  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string },
  ): Promise<void> {
    const state = this.userStates.get(userId);
    if (!state) return;

    state.opsCount++;
    state.lastProfit = result.profit; // Valor líquido (já descontado stake)
    state.lucroAtual += result.profit;

    this.updateMode(state, result.win);

    this.logger.log(
      `[Falcon][${userId}] 📊 RESULTADO: ${result.win ? 'WIN' : 'LOSS'} | Lucro: ${result.profit.toFixed(2)} | Total: ${state.lucroAtual.toFixed(2)}`,
    );

    // Atualizar banco de dados
    await this.updateUserStateInDb(userId, state);
  }

  async getUserState(userId: string): Promise<AutonomousAgentState | null> {
    const state = this.userStates.get(userId);
    if (!state) return null;

    return {
      userId: state.userId,
      isActive: state.isActive,
      currentProfit: state.lucroAtual,
      currentLoss: Math.abs(Math.min(0, state.lucroAtual)),
      operationsCount: state.opsCount,
      mode: state.mode,
      consecutiveWins: state.consecutiveWins,
      consecutiveLosses: state.consecutiveLosses,
    };
  }

  async resetDailySession(userId: string): Promise<void> {
    const state = this.userStates.get(userId);
    if (state) {
      state.lucroAtual = 0;
      state.picoLucro = 0;
      state.consecutiveLosses = 0;
      state.consecutiveWins = 0;
      state.opsCount = 0;
      state.mode = 'PRECISO';
      state.stopBlindadoAtivo = false;
      state.pisoBlindado = 0;
      state.lastProfit = 0;
    }
  }

  /**
   * Atualiza estado do usuário no banco de dados
   */
  private async updateUserStateInDb(userId: string, state: FalconUserState): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET daily_profit = ?, 
             profit_peak = ?,
             total_trades = ?,
             updated_at = NOW()
         WHERE user_id = ? AND agent_type = 'falcon'`,
        [state.lucroAtual, state.picoLucro, state.opsCount, userId],
      );
    } catch (error) {
      this.logger.error(`[Falcon] Erro ao atualizar estado no DB:`, error);
    }
  }
}

/**
 * Estado interno do FALCON por usuário
 */
interface FalconUserState {
  userId: string;
  isActive: boolean;
  saldoInicial: number;
  lucroAtual: number;
  picoLucro: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  opsCount: number;
  mode: 'PRECISO' | 'ALTA_PRECISAO';
  stopBlindadoAtivo: boolean;
  pisoBlindado: number;
  lastProfit: number;
  config: {
    stakeInicial: number;
    metaLucro: number;
    limitePerda: number;
  };
}

