import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';

// Tipos específicos da Apollo v3
export type ApolloMode = 'veloz' | 'balanceado' | 'preciso';

// Estado do usuário Apollo
export interface ApolloUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  capitalInicial: number;

  // Modo e configurações
  mode: ApolloMode;
  modoMartingale: ModoMartingale;
  riskProfile: 'conservador' | 'moderado' | 'agressivo';

  // Martingale Inteligente
  martingaleLevel: number; // 0, 1, 2, 3+
  lossAccumulated: number;

  // Controle de estado
  isOperationActive: boolean;
  virtualLoss: number; // Contagem de dígitos <= 3

  // Stop Loss e Proteções
  stopLoss: number; // Valor positivo (ex: 50.0)
  profitTarget: number;
  maxProfitReached: number; // Maior lucro já alcançado (para trailing stop)
  trailingStopActive: boolean; // Se trailing stop está ativo

  // Timestamps
  creationCooldownUntil?: number;

  // Controle de Aposta e Barreira
  currentStake: number;
  currentBarrier: number;
  apostaInicial: number;
  symbol: string;
}

// Configuração Padrão do Usuário (fallback)
const DEFAULT_CONFIG = {
  INITIAL_STAKE: 0.35,
  TARGET_PROFIT: 10.0,
  STOP_LOSS: 50.0,
  SYMBOL: "R_100",
  CONTRACT_TYPE: "DIGITOVER",
  DURATION: 1,
  DURATION_UNIT: "t"
};

/**
 * ☀️ APOLLO v3: RiskManager
 * Gerencia dinheiro com Modos de Risco Personalizados e Stop Blindado
 */
class RiskManager {
  private config: any;
  // ✅ Payout fixo de 63% (0.63) para todas as operações Apollo
  private readonly PAYOUT_APOLLO = 0.63; // 63% - payout padrão das operações Over

  constructor(config: any) {
    this.config = config;
  }

  updateProfit(state: ApolloUserState, profit: number) {
    const currentProfit = state.capital - state.capitalInicial;

    // Trailing Stop (Blindagem)
    if (currentProfit > state.maxProfitReached) {
      state.maxProfitReached = currentProfit;
    }

    if (state.maxProfitReached >= (state.profitTarget * 0.5)) {
      state.trailingStopActive = true;
    }
  }

  adjustStakeForStopLoss(state: ApolloUserState, intendedStake: number): { adjustedStake: number, reason: string | null } {
    /** Lógica de Pouso Suave (Soft Landing) */
    const currentProfit = state.capital - state.capitalInicial;

    // O limite efetivo muda se o Trailing Stop estiver ativo
    let stopLimit = -state.stopLoss;

    if (state.trailingStopActive) {
      // Garante 50% do lucro máximo
      stopLimit = state.maxProfitReached * 0.5;
    }

    // Margem restante até o stop
    // Se trailing ativo: currentProfit - (maxProfit * 0.5)
    // Se normal: currentProfit - (-stopLoss) = currentProfit + stopLoss
    const remainingMargin = currentProfit - stopLimit;

    if (remainingMargin < intendedStake) {
      if (remainingMargin < 0.35) {
        return { adjustedStake: 0.0, reason: "Margem Esgotada" };
      }
      return { adjustedStake: Number(remainingMargin.toFixed(2)), reason: "Pouso Suave Ativo" };
    }

    return { adjustedStake: intendedStake, reason: null };
  }

  getNextTradeParams(state: ApolloUserState, lastWin: boolean): { stake: number, barrier: number } {
    if (lastWin) {
      state.martingaleLevel = 0;
      state.lossAccumulated = 0.0;
      return { stake: this.config.INITIAL_STAKE, barrier: 3 };
    }

    state.martingaleLevel += 1;

    // Progressão de Barreiras (Martingale Inteligente)
    // ✅ Mantém a progressão de barreiras, mas usa payout fixo de 63%
    let barrier = 6;
    if (state.martingaleLevel === 1) barrier = 4;
    else if (state.martingaleLevel === 2) barrier = 5;
    else barrier = 6;

    // ✅ Fatores de Recuperação (igual à Orion)
    // CONSERVADOR: Recuperar apenas o valor da perda (break-even)
    // MODERADO: Recuperar 100% das perdas + 25% de lucro
    // AGRESSIVO: Recuperar 100% das perdas + 50% de lucro
    let factor = 1.0;
    if (state.riskProfile === 'moderado') factor = 1.25;
    else if (state.riskProfile === 'agressivo') factor = 1.50;

    // Limite Conservador
    if (state.riskProfile === 'conservador' && state.martingaleLevel > 5) {
      // Reseta se passar do nível 5 no modo conservador
      state.martingaleLevel = 0;
      state.lossAccumulated = 0.0;
      return { stake: this.config.INITIAL_STAKE, barrier: 3 };
    }

    // ✅ Cálculo do martingale usando payout de 63% (0.63)
    // Fórmula: (perdas_acumuladas × fator) / payout
    // Exemplo: Se perdeu $1.00 e está em modo conservador:
    //   nextStake = ($1.00 × 1.0) / 0.63 = $1.59
    //   Se ganhar: $1.59 × 0.63 = $1.00 de lucro (recupera exatamente o que perdeu)
    let nextStake = (state.lossAccumulated * factor) / this.PAYOUT_APOLLO;
    nextStake = Math.max(nextStake, 0.35);
    nextStake = Math.round(nextStake * 100) / 100; // 2 casas decimais

    return { stake: nextStake, barrier };
  }

  registerLoss(state: ApolloUserState, stake: number) {
    state.lossAccumulated += stake;
  }
}

/**
 * ☀️ APOLLO v3: Strategy Logic
 * Decide quando entrar no mercado
 */
class ApolloLogic {
  static processTick(state: ApolloUserState, digit: number): boolean {
    if (state.isOperationActive) return false;

    // Lógica de Loss Virtual da v3:
    // "Loss Virtual" acontece se digit <= 3
    if (digit <= 3) {
      state.virtualLoss += 1;
    } else {
      state.virtualLoss = 0;
    }

    if (state.mode === 'veloz') return true;
    else if (state.mode === 'balanceado' && state.virtualLoss >= 3) return true;
    else if (state.mode === 'preciso' && state.virtualLoss >= 5) return true;

    return false;
  }
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);

  private ticks: Tick[] = [];
  private apolloUsers = new Map<string, ApolloUserState>();

  // ✅ Rastreamento de logs de stop blindado (para evitar logs duplicados)
  private stopBlindadoLogsEnviados = new Map<string, boolean>(); // userId -> se já logou ativação

  // ✅ Rastreamento de último Loss Virtual logado (para evitar spam de logs)
  private ultimoLossVirtualLogado = new Map<string, number>(); // userId -> último loss virtual logado

  // Pool de conexões WebSocket por token (reutilização)
  private wsConnections: Map<
    string,
    {
      ws: WebSocket;
      authorized: boolean;
      keepAliveInterval: NodeJS.Timeout | null;
      requestIdCounter: number;
      pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
      subscriptions: Map<string, (msg: any) => void>;
    }
  > = new Map();

  private appId: string;
  private symbol = 'R_100'; // Apollo opera em R_100 (Dígitos)

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[APOLLO] ☀️ Estratégia APOLLO v3 inicializada (Barriers 3-6)');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    this.ticks.push(tick);
    if (this.ticks.length > 100) this.ticks.shift();

    const digit = tick.digit;

    for (const [userId, state] of this.apolloUsers.entries()) {
      const virtualLossAntes = state.virtualLoss;
      const shouldTrade = ApolloLogic.processTick(state, digit);

      // ✅ Calcular threshold baseado no modo
      const threshold = state.mode === 'veloz' ? 0 : state.mode === 'balanceado' ? 3 : 5;
      const ultimoLogado = this.ultimoLossVirtualLogado.get(userId) ?? -1;

      // ✅ Log de TICK quando Loss Virtual muda significativamente
      // Logar quando:
      // 1. Loss Virtual mudou (aumentou ou zerou) - mas não logar se já logou esse valor
      // 2. Está próximo do threshold (1 tick antes) - sempre logar
      // 3. Atingiu o threshold (vai entrar) - sempre logar
      const mudouSignificativamente = virtualLossAntes !== state.virtualLoss && state.virtualLoss !== ultimoLogado;
      const proximoDoThreshold = state.virtualLoss > 0 && state.virtualLoss === threshold - 1;
      const atingiuThreshold = state.virtualLoss >= threshold;

      if (mudouSignificativamente || proximoDoThreshold || atingiuThreshold) {
        const statusLossVirtual = state.virtualLoss === 0 
          ? '✅ Resetado' 
          : state.virtualLoss < threshold 
            ? `⏳ Acumulando (${state.virtualLoss}/${threshold})`
            : `🎯 PRONTO (${state.virtualLoss}/${threshold})`;

        this.saveApolloLog(
          state.userId,
          'tick',
          `📊 TICK: ${digit} | Loss Virtual: ${state.virtualLoss} | ${statusLossVirtual} | Modo: ${state.mode.toUpperCase()}`
        );

        // Atualizar último valor logado
        this.ultimoLossVirtualLogado.set(userId, state.virtualLoss);
      }

      // ✅ Log de ANÁLISE quando está próximo ou atingiu o threshold
      if ((proximoDoThreshold || atingiuThreshold) && !state.isOperationActive) {
        const stakeAtual = state.currentBarrier === 3 ? state.apostaInicial : state.currentStake;
        const analiseMessage = `🔍 [ANÁLISE ${state.mode.toUpperCase()}]\n` +
          ` • Dígito Atual: ${digit}\n` +
          ` • Loss Virtual: ${state.virtualLoss}/${threshold} ${atingiuThreshold ? '✅' : '⏳'}\n` +
          ` • Barreira: Over ${state.currentBarrier}\n` +
          ` • Stake: $${stakeAtual.toFixed(2)}\n` +
          ` • Martingale Level: ${state.martingaleLevel}\n` +
          `${atingiuThreshold ? '🌊 [DECISÃO] Critérios atendidos. Entrada: Over ' + state.currentBarrier : '⏳ Aguardando threshold...'}`;

        this.saveApolloLog(state.userId, 'analise', analiseMessage);
        this.logger.log(`[APOLLO][${state.userId}] ${analiseMessage.replace(/\n/g, ' | ')}`);
      }

      if (shouldTrade && !state.isOperationActive) {
        await this.executeTradeCycle(state);
      }
    }
  }

  async activateUser(userId: string, config: any): Promise<void> {
    const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, stopLoss, profitTarget } = config;
    let modeLower = (mode || 'balanceado').toLowerCase();

    // Mapear modos do frontend para modos da Apollo
    const modeMap: Record<string, ApolloMode> = {
      'veloz': 'veloz',
      'moderado': 'balanceado',
      'lento': 'preciso',
      'balanceado': 'balanceado',
      'preciso': 'preciso',
    };

    const apolloMode = modeMap[modeLower] || 'balanceado';
    const apostaInicial = entryValue || DEFAULT_CONFIG.INITIAL_STAKE;

    const riskProfile = (modoMartingale || 'moderado').toLowerCase() as 'conservador' | 'moderado' | 'agressivo';

    this.upsertApolloUserState({
      userId,
      stakeAmount: stakeAmount || 0,
      apostaInicial,
      derivToken,
      currency,
      modoMartingale: riskProfile,
      mode: apolloMode,
      stopLoss: stopLoss ? Math.abs(stopLoss) : DEFAULT_CONFIG.STOP_LOSS,
      profitTarget: profitTarget || DEFAULT_CONFIG.TARGET_PROFIT,
      riskProfile: riskProfile,
    });

    this.saveApolloLog(userId, 'info',
      `☀️ Usuário ATIVADO | Modo: ${apolloMode} | Capital: $${stakeAmount?.toFixed(2)} | Risk: ${riskProfile}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.apolloUsers.delete(userId);
    // ✅ Limpar flags de log
    this.stopBlindadoLogsEnviados.delete(`stop_blindado_ativado_${userId}`);
    this.ultimoLossVirtualLogado.delete(userId);
    this.saveApolloLog(userId, 'info', '☀️ Usuário DESATIVADO');
  }

  getUserState(userId: string): any {
    return this.apolloUsers.get(userId) || null;
  }

  private async executeTradeCycle(state: ApolloUserState): Promise<void> {
    // ✅ VERIFICAR STOP LOSS BLINDADO ANTES DE QUALQUER OPERAÇÃO
    try {
      const stopLossConfig = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stake_amount, 0) as capitalInicial,
          COALESCE(profit_peak, 0) as profitPeak,
          stop_blindado_percent as stopBlindadoPercent,
          is_active
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = 1
         LIMIT 1`,
        [state.userId],
      );

      if (stopLossConfig && stopLossConfig.length > 0) {
        const config = stopLossConfig[0];
        const profitTarget = parseFloat(config.profitTarget) || 0;
        const capitalInicial = parseFloat(config.capitalInicial) || 0;
        const sessionBalance = parseFloat(config.sessionBalance) || 0;
        const capitalSessao = capitalInicial + sessionBalance;
        const lucroAtual = sessionBalance;

        // ✅ Verificar STOP WIN (profit target) antes de executar operação
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
          this.logger.log(
            `[APOLLO][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
          );
          this.saveApolloLog(state.userId, 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);

          await this.deactivateApolloUser(state.userId, 'stopped_profit');
          return;
        }

        // ✅ Verificar STOP-LOSS BLINDADO antes de executar operação (ZENIX v2.0 - Dynamic Trailing)
        // Ativar se atingir 40% da meta. Proteger 50% do lucro máximo (PICO).
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          let profitPeak = parseFloat(config.profitPeak) || 0;

          // Auto-healing: se lucro atual superou o pico registrado, atualizar pico
          if (lucroAtual > profitPeak) {
            const profitPeakAnterior = profitPeak;
            profitPeak = lucroAtual;

            // ✅ Log quando profit peak aumenta
            if (profitPeak >= profitTarget * 0.40) {
              const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
              const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
              const stopBlindado = capitalInicial + protectedAmount;

              this.logger.log(
                `[APOLLO][${state.userId}] 🛡️💰 STOP BLINDADO ATUALIZADO | ` +
                `Pico: $${profitPeakAnterior.toFixed(2)} → $${profitPeak.toFixed(2)} | ` +
                `Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%)`
              );
              this.saveApolloLog(
                state.userId,
                'info',
                `🛡️💰 STOP BLINDADO ATUALIZADO | Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)}`
              );
            }

            // Atualizar no banco em background
            this.dataSource.query(
              `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
              [profitPeak, state.userId],
            ).catch(err => this.logger.error(`[APOLLO] Erro ao atualizar profit_peak:`, err));
          }

          // Ativar apenas se atingiu 40% da meta
          if (profitPeak >= profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0; // Padrão 50%
            const fatorProtecao = stopBlindadoPercent / 100;

            // Trailing Stop: Protege % do PICO de lucro
            const protectedAmount = profitPeak * fatorProtecao;
            const stopBlindado = capitalInicial + protectedAmount;

            // ✅ Log quando Stop Blindado é ativado pela primeira vez (só loga se ainda não logou)
            const stopBlindadoKey = `stop_blindado_ativado_${state.userId}`;
            if (!this.stopBlindadoLogsEnviados.has(stopBlindadoKey)) {
              this.stopBlindadoLogsEnviados.set(stopBlindadoKey, true);
              this.logger.log(
                `[APOLLO][${state.userId}] 🛡️✅ STOP BLINDADO ATIVADO! | ` +
                `Meta: $${profitTarget.toFixed(2)} | ` +
                `40% Meta: $${(profitTarget * 0.40).toFixed(2)} | ` +
                `Pico Atual: $${profitPeak.toFixed(2)} | ` +
                `Protegendo: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%) | ` +
                `Stop Level: $${stopBlindado.toFixed(2)}`
              );
              this.saveApolloLog(
                state.userId,
                'info',
                `🛡️✅ STOP BLINDADO ATIVADO! Protegendo $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}% do pico $${profitPeak.toFixed(2)}) | Stop: $${stopBlindado.toFixed(2)}`
              );
            }

            // Se capital da sessão caiu abaixo do stop blindado → PARAR
            if (capitalSessao <= stopBlindado) {
              const lucroProtegido = capitalSessao - capitalInicial;

              this.logger.warn(
                `[APOLLO][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
                `Capital Sessão: $${capitalSessao.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | ` +
                `Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%) - BLOQUEANDO OPERAÇÃO`,
              );

              this.saveApolloLog(
                state.userId,
                'alerta',
                `🛡️ STOP-LOSS BLINDADO ATIVADO! Protegido: $${lucroProtegido.toFixed(2)} (50% do pico $${profitPeak.toFixed(2)}) - IA DESATIVADA`,
              );

              const deactivationReason =
                `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
                `(${stopBlindadoPercent}% do pico de $${profitPeak.toFixed(2)})`;

              await this.deactivateApolloUser(state.userId, 'stopped_blindado');
              return;
            }
          }
        }

        // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
        const lossLimit = parseFloat(config.lossLimit) || 0;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;

        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(
            `[APOLLO][${state.userId}] 🛑 STOP LOSS ATINGIDO! Perda atual: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
          );
          this.saveApolloLog(state.userId, 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);

          await this.deactivateApolloUser(state.userId, 'stopped_loss');
          return;
        }
      }
    } catch (error) {
      this.logger.error(`[APOLLO][${state.userId}] Erro ao verificar stop loss:`, error);
      // Continuar mesmo se houver erro na verificação (fail-open)
    }

    // Instanciar RiskManager apenas para lógica
    const riskManager = new RiskManager({ INITIAL_STAKE: state.apostaInicial });

    const { adjustedStake, reason } = riskManager.adjustStakeForStopLoss(state, state.currentStake);

    if (adjustedStake === 0.0) {
      this.saveApolloLog(state.userId, 'alerta', `🛑 [STOP] Limite Atingido: ${reason}`);
      await this.deactivateApolloUser(state.userId, 'stopped_loss');
      return;
    }

    if (reason) {
      this.saveApolloLog(state.userId, 'alerta', `⚠️ [POUSO SUAVE] Stake ajustado: $${state.currentStake.toFixed(2)} -> $${adjustedStake.toFixed(2)}`);
    }

    const stakeToUse = adjustedStake;
    state.isOperationActive = true;

    // LOG DE ENTRADA
    this.saveApolloLog(state.userId, 'operacao', `🚀 [TRADE] Comprando Over ${state.currentBarrier} | Stake: $${stakeToUse.toFixed(2)}`);
    this.logger.log(`[APOLLO][${state.userId}] 🚀 [TRADE] Comprando Over ${state.currentBarrier} | Stake: $${stakeToUse.toFixed(2)}`);

    let tradeId: number | null = null;
    try {
      tradeId = await this.createApolloTradeRecord(state, stakeToUse, state.currentBarrier);

      const result = await this.executeTradeViaWebSocket(state.derivToken, {
        contract_type: "DIGITOVER",
        barrier: state.currentBarrier,
        amount: stakeToUse,
        currency: state.currency || 'USD'
      }, state.userId);

      if (result) {
        await this.processResult(state, result, stakeToUse, riskManager, tradeId);
      } else {
        state.isOperationActive = false;
        if (tradeId) {
          await this.dataSource.query(
            `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
            ['Timeout ou erro na execução via WebSocket', tradeId]
          ).catch(() => { });
        }
      }

    } catch (e) {
      this.logger.error(`[APOLLO][${state.userId}] Erro na execução: ${e.message}`);
      state.isOperationActive = false;
      if (tradeId) {
        await this.dataSource.query(
          `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [e.message || 'Erro na execução', tradeId]
        ).catch(() => { });
      }
    }
  }

  private async processResult(state: ApolloUserState, result: { profit: number, exitSpot: any, contractId: string }, stakeUsed: number, riskManager: RiskManager, tradeId: number | null) {
    const profit = result.profit;
    const isWin = profit > 0;

    riskManager.updateProfit(state, profit);

    // ✅ Atualizar capital primeiro
    state.capital += profit;

    const statusIcon = isWin ? "✅ WIN " : "❌ LOSS";
    // ✅ Calcular lucro atual após atualizar capital
    const currentProfit = state.capital - state.capitalInicial;

    this.saveApolloLog(state.userId, 'resultado', `${statusIcon} | Lucro: ${profit > 0 ? '+' : ''}${profit.toFixed(2)} | Saldo Sessão: ${currentProfit > 0 ? '+' : ''}${currentProfit.toFixed(2)}`);

    // ✅ Atualizar session_balance no banco
    try {
      await this.dataSource.query(
        `UPDATE ai_user_config 
         SET session_balance = ?
         WHERE user_id = ? AND is_active = 1`,
        [currentProfit, state.userId],
      );
    } catch (error) {
      this.logger.error(`[APOLLO] Erro ao atualizar session_balance:`, error);
    }

    // ✅ Verificar stop loss e stop win após processar resultado
    try {
      const configResult = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stake_amount, 0) as capitalInicial,
          COALESCE(profit_peak, 0) as profitPeak,
          stop_blindado_percent as stopBlindadoPercent,
          is_active
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = 1
         LIMIT 1`,
        [state.userId],
      );

      if (configResult && configResult.length > 0) {
        const config = configResult[0];
        const lossLimit = parseFloat(config.lossLimit) || 0;
        const profitTarget = parseFloat(config.profitTarget) || 0;
        const capitalInicial = parseFloat(config.capitalInicial) || 0;

        // ✅ CORREÇÃO: Usar capital atual do estado em memória (mais preciso que session_balance do banco)
        const capitalAtualMemoria = state.capital || capitalInicial;
        const lucroAtual = capitalAtualMemoria - capitalInicial;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
        const capitalSessao = capitalAtualMemoria;

        // ✅ Verificar STOP WIN (profit target)
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
          this.logger.log(
            `[APOLLO][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - DESATIVANDO SESSÃO`,
          );
          this.saveApolloLog(state.userId, 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);

          if (tradeId) await this.updateApolloTradeRecord(state, tradeId, isWin ? 'WON' : 'LOST', result, profit);
          await this.deactivateApolloUser(state.userId, 'stopped_profit');
          return;
        }

        // ✅ STOP LOSS BLINDADO (Dynamic Trailing)
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          let profitPeak = parseFloat(config.profitPeak) || 0;

          // Auto-healing / Update Peak
          if (lucroAtual > profitPeak) {
            const profitPeakAnterior = profitPeak;
            profitPeak = lucroAtual;

            // ✅ Log quando profit peak aumenta após vitória
            if (profitPeak >= profitTarget * 0.40) {
              const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
              const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
              const stopBlindado = capitalInicial + protectedAmount;

              this.logger.log(
                `[APOLLO][${state.userId}] 🛡️💰 STOP BLINDADO ATUALIZADO | ` +
                `Pico: $${profitPeakAnterior.toFixed(2)} → $${profitPeak.toFixed(2)} | ` +
                `Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%)`
              );
              this.saveApolloLog(
                state.userId,
                'info',
                `🛡️💰 STOP BLINDADO ATUALIZADO | Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)}`
              );
            }

            // Update DB
            await this.dataSource.query(
              `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
              [profitPeak, state.userId]
            );
          }

          // Check Stop
          if (profitPeak >= profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
            const fatorProtecao = stopBlindadoPercent / 100;
            const protectedAmount = profitPeak * fatorProtecao;
            const stopBlindado = capitalInicial + protectedAmount;

            if (capitalSessao <= stopBlindado) {
              const lucroProtegido = capitalSessao - capitalInicial;
              this.logger.warn(`[APOLLO] 🛡️ STOP BLINDADO ATINGIDO APÓS OPERAÇÃO. Peak: ${profitPeak}, Protegido: ${protectedAmount}, Atual: ${lucroAtual}`);
              this.saveApolloLog(state.userId, 'alerta', `🛡️ STOP BLINDADO ATINGIDO! Saldo protegido: $${lucroProtegido.toFixed(2)}`);

              const deactivationReason = `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro`;

              if (tradeId) await this.updateApolloTradeRecord(state, tradeId, isWin ? 'WON' : 'LOST', result, profit);
              await this.deactivateApolloUser(state.userId, 'stopped_blindado');
              return;
            }
          }
        }

        // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(
            `[APOLLO][${state.userId}] 🛑 STOP LOSS ATINGIDO APÓS OPERAÇÃO! Perda: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - DESATIVANDO SESSÃO`,
          );
          this.saveApolloLog(state.userId, 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);

          if (tradeId) await this.updateApolloTradeRecord(state, tradeId, isWin ? 'WON' : 'LOST', result, profit);
          await this.deactivateApolloUser(state.userId, 'stopped_loss');
          return;
        }
      }
    } catch (error) {
      this.logger.error(`[APOLLO][${state.userId}] Erro ao verificar limites após resultado:`, error);
      // Continuar mesmo se houver erro na verificação (fail-open)
    }

    if (isWin) {
      state.isOperationActive = false;
      state.virtualLoss = 0;
      const params = riskManager.getNextTradeParams(state, true);
      state.currentStake = params.stake;
      state.currentBarrier = params.barrier;
    } else {
      riskManager.registerLoss(state, stakeUsed);
      const params = riskManager.getNextTradeParams(state, false);
      state.currentStake = params.stake;
      state.currentBarrier = params.barrier;

      // ✅ Log detalhado do cálculo do martingale
      const modoMartingale = state.riskProfile === 'conservador' ? 'CONSERVADOR' : 
                            state.riskProfile === 'moderado' ? 'MODERADO' : 'AGRESSIVO';
      const factor = state.riskProfile === 'conservador' ? 1.0 : 
                    state.riskProfile === 'moderado' ? 1.25 : 1.50;
      
      this.saveApolloLog(
        state.userId, 
        'info', 
        `🔄 MARTINGALE (${modoMartingale}) | Nível: ${state.martingaleLevel} | Perda acumulada: $${state.lossAccumulated.toFixed(2)} | Stake calculado: $${params.stake.toFixed(2)} | Barreira: Over ${params.barrier}`
      );
      this.saveApolloLog(
        state.userId, 
        'info', 
        `🚀 [TRADE] Comprando Over ${params.barrier} | Stake: $${params.stake.toFixed(2)} <-- Barreira subiu/ajuste`
      );

      setTimeout(() => {
        this.executeTradeCycle(state);
      }, 1000);
    }

    if (tradeId) await this.updateApolloTradeRecord(state, tradeId, isWin ? 'WON' : 'LOST', result, profit);
  }

  /**
   * ☀️ APOLLO: Executa trade via WebSocket
   */
  private async executeTradeViaWebSocket(
    token: string,
    contractParams: {
      contract_type: 'DIGITOVER';
      barrier: number;
      amount: number;
      currency: string;
    },
    userId?: string,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    try {
      this.logger.log(`[APOLLO] 🔌 Iniciando conexão WebSocket para trade...`);
      const connection = await this.getOrCreateWebSocketConnection(token, userId);

      // Solicitar proposta
      this.logger.log(`[APOLLO] 📝 Solicitando proposta para Over ${contractParams.barrier} | Stake: ${contractParams.amount}`);
      const proposalResponse: any = await connection.sendRequest({
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: this.symbol,
        barrier: String(contractParams.barrier),
      }, 60000);

      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        this.logger.error(`[APOLLO] ❌ Erro na proposta: ${JSON.stringify(errorObj)}`);
        return null;
      }

      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);

      this.logger.log(`[APOLLO] ✅ Proposta recebida: ID=${proposalId} | Preço=${proposalPrice}`);

      // Comprar contrato
      this.logger.log(`[APOLLO] 🛒 Efetuando compra...`);
      const buyResponse: any = await connection.sendRequest({
        buy: proposalId,
        price: proposalPrice,
      }, 60000);

      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        this.logger.error(`[APOLLO] ❌ Erro ao comprar: ${JSON.stringify(buyErrorObj)}`);
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      this.logger.log(`[APOLLO] ✅ Compra efetuada! Contrato ID: ${contractId}. Monitorando...`);

      // Monitorar contrato
      return await new Promise((resolve) => {
        let hasResolved = false;
        const contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[APOLLO] ⚠️ Timeout monitorando contrato ${contractId}`);
            connection.removeSubscription(contractId);
            resolve(null);
          }
        }, 90000);

        connection.subscribe(
          { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
          (msg: any) => {
            const contract = msg.proposal_open_contract;

            // Debug esporádico ou log de progresso
            if (contract.status === 'open' || contract.status === 'running') {
              this.logger.debug(`[APOLLO] 🔍 Contrato ${contractId} em andamento...`);
            }

            if (!contract) return;

            if (contract.is_sold || contract.status === 'sold') {
              if (!hasResolved) {
                hasResolved = true;
                const profit = Number(contract.profit || 0);
                this.logger.log(`[APOLLO] ✅ Contrato ${contractId} finalizado. Status: ${contract.status}, Lucro: ${profit}`);
                clearTimeout(contractMonitorTimeout);
                connection.removeSubscription(contractId);

                const exitSpot = contract.exit_tick || contract.current_spot || 0;

                resolve({
                  contractId,
                  profit,
                  exitSpot,
                });
              }
            }
          },
          contractId,
          90000,
        );
      });
    } catch (error: any) {
      this.logger.error(`[APOLLO] Erro ao executar trade:`, error);
      return null;
    }
  }

  private upsertApolloUserState(config: {
    userId: string;
    stakeAmount: number;
    apostaInicial: number;
    derivToken: string;
    currency: string;
    modoMartingale: 'conservador' | 'moderado' | 'agressivo';
    mode: ApolloMode;
    stopLoss: number;
    profitTarget: number;
    riskProfile: 'conservador' | 'moderado' | 'agressivo';
  }): void {
    const existing = this.apolloUsers.get(config.userId);

    if (existing) {
      existing.derivToken = config.derivToken;
      existing.currency = config.currency;
      existing.modoMartingale = config.modoMartingale;
      existing.mode = config.mode;
      existing.stopLoss = config.stopLoss;
      existing.profitTarget = config.profitTarget;
      existing.capital = config.stakeAmount;
      existing.riskProfile = config.riskProfile;
    } else {
      this.apolloUsers.set(config.userId, {
        userId: config.userId,
        derivToken: config.derivToken,
        currency: config.currency || 'USD',
        capital: config.stakeAmount,
        capitalInicial: config.stakeAmount,
        mode: config.mode,
        modoMartingale: config.modoMartingale,
        riskProfile: config.riskProfile,
        martingaleLevel: 0,
        lossAccumulated: 0,
        isOperationActive: false,
        virtualLoss: 0,
        stopLoss: config.stopLoss,
        profitTarget: config.profitTarget,
        maxProfitReached: 0.0,
        trailingStopActive: false,
        currentStake: config.apostaInicial,
        currentBarrier: 3,
        apostaInicial: config.apostaInicial,
        symbol: this.symbol
      });
    }
  }

  private async deactivateApolloUser(userId: string, reason: string = 'stopped'): Promise<void> {
    let deactivationReason = reason;
    
    // ✅ Se for stop blindado, buscar informações para o log
    if (reason === 'stopped_blindado') {
      try {
        const config = await this.dataSource.query(
          `SELECT 
            COALESCE(stake_amount, 0) as capitalInicial,
            COALESCE(session_balance, 0) as sessionBalance,
            COALESCE(profit_peak, 0) as profitPeak,
            COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent
           FROM ai_user_config 
           WHERE user_id = ? AND is_active = 1
           LIMIT 1`,
          [userId],
        );

        if (config && config.length > 0) {
          const capitalInicial = parseFloat(config[0].capitalInicial) || 0;
          const sessionBalance = parseFloat(config[0].sessionBalance) || 0;
          const profitPeak = parseFloat(config[0].profitPeak) || 0;
          const stopBlindadoPercent = parseFloat(config[0].stopBlindadoPercent) || 50.0;
          const lucroProtegido = sessionBalance;

          deactivationReason =
            `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
            `(${stopBlindadoPercent}% do pico de $${profitPeak.toFixed(2)})`;

          this.logger.log(
            `[APOLLO][${userId}] 🛡️ IA DESATIVADA POR STOP BLINDADO | ` +
            `Lucro protegido: $${lucroProtegido.toFixed(2)} | ` +
            `Capital Sessão final: $${(capitalInicial + sessionBalance).toFixed(2)}`,
          );
        }
      } catch (error) {
        this.logger.error(`[APOLLO] Erro ao buscar informações do stop blindado:`, error);
      }
    }

    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET is_active = 0, session_status = ?, deactivation_reason = ?, deactivated_at = NOW() 
       WHERE user_id = ? AND is_active = 1`,
      [reason, deactivationReason, userId],
    );
    this.apolloUsers.delete(userId);
    
    // ✅ Limpar flag de log de stop blindado
    this.stopBlindadoLogsEnviados.delete(`stop_blindado_ativado_${userId}`);
  }

  /**
   * ✅ APOLLO: Cria registro de trade no banco
   */
  private async createApolloTradeRecord(
    state: ApolloUserState,
    stakeAmount: number,
    barrier: number,
  ): Promise<number> {
    const analysisData = {
      strategy: 'apollo',
      mode: state.mode,
      barrier,
      virtualLoss: state.virtualLoss,
      timestamp: new Date().toISOString(),
    };

    let insertResult: any;
    try {
      insertResult = await this.dataSource.query(
        `INSERT INTO ai_trades 
         (user_id, gemini_signal, entry_price, stake_amount, status, 
          gemini_duration, gemini_reasoning, contract_type, created_at, analysis_data, symbol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          state.userId,
          `OVER_${barrier}`,
          0, // entry_price inicial
          stakeAmount,
          'PENDING',
          1,
          `Apollo Strategy - Mode: ${state.mode}, Barrier: ${barrier}`,
          'DIGITOVER',
          JSON.stringify(analysisData),
          state.symbol,
        ],
      );
    } catch (error: any) {
      this.logger.error(`[APOLLO] Erro ao criar registro de trade:`, error);
      throw error;
    }

    const result = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    return result?.insertId || null;
  }

  /**
   * ✅ APOLLO: Atualiza registro de trade no banco
   */
  private async updateApolloTradeRecord(
    state: ApolloUserState,
    tradeId: number,
    status: string,
    result: any,
    profit: number,
  ) {
    if (!tradeId) return;

    try {
      await this.dataSource.query(
        `UPDATE ai_trades
         SET contract_id = ?, exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
         WHERE id = ?`,
        [result?.contractId || null, result?.exitSpot || 0, profit, status, tradeId],
      );

      // Emitir evento de atualização
      this.tradeEvents.emit({
        userId: state.userId,
        type: 'updated',
        tradeId,
        status: status as any,
        strategy: 'apollo',
        profitLoss: profit,
        exitPrice: result?.exitSpot || 0,
      });
    } catch (error) {
      this.logger.error(`[APOLLO] Erro ao atualizar registro de trade ${tradeId}:`, error);
    }
  }

  private saveApolloLog(userId: string, type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro', message: string) {
    const icons: Record<string, string> = {
      'info': 'ℹ️',
      'tick': '📊',
      'analise': '🔍',
      'sinal': '🎯',
      'operacao': '⚡',
      'resultado': '💰',
      'alerta': '⚠️',
      'erro': '❌',
    };

    const icon = icons[type] || 'ℹ️';
    const details = JSON.stringify({ strategy: 'apollo', symbol: this.symbol });

    this.dataSource.query(
      `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, type, icon, message, details]
    ).catch(e => console.error('Error saving log', e));

    this.tradeEvents.emit({
      userId,
      type: 'updated',
      strategy: 'apollo',
      symbol: this.symbol,
      status: 'LOG',
    });
  }

  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    const existing = this.wsConnections.get(token);

    if (existing) {
      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        return {
          ws: existing.ws,
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
            this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      } else {
        if (existing.keepAliveInterval) clearInterval(existing.keepAliveInterval);
        existing.ws.close();
        this.wsConnections.delete(token);
      }
    }

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { Origin: 'https://app.deriv.com' } });
      let authResolved = false;

      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          socket.close();
          this.wsConnections.delete(token);
          reject(new Error('Timeout ao conectar (20s)'));
        }
      }, 20000);

      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) return;

          const conn = this.wsConnections.get(token);
          if (!conn) return;

          if (msg.msg_type === 'authorize' && !authResolved) {
            authResolved = true;
            clearTimeout(connectionTimeout);
            if (msg.error) {
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(msg.error.message));
              return;
            }
            conn.authorized = true;
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
            }, 30000);
            resolve(socket);
            return;
          }

          if (msg.proposal_open_contract) {
            const cid = msg.proposal_open_contract.contract_id;
            if (cid && conn.subscriptions.has(cid)) {
              conn.subscriptions.get(cid)!(msg);
              return;
            }
          }

          for (const [key, pending] of conn.pendingRequests.entries()) {
            if (msg.msg_type && key.includes(msg.msg_type)) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(key);
              if (msg.error) pending.reject(new Error(msg.error.message));
              else pending.resolve(msg);
              return;
            }
            if (msg.proposal && key.includes('proposal')) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(key);
              pending.resolve(msg);
              return;
            }
            if (msg.buy && key.includes('buy')) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(key);
              pending.resolve(msg);
              return;
            }
          }
        } catch (e) { }
      });

      socket.on('open', () => {
        const conn = {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        };
        this.wsConnections.set(token, conn);
        socket.send(JSON.stringify({ authorize: token }));
      });
    });

    return {
      ws,
      sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
      subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
      removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
    };
  }

  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn) throw new Error("Connection not found");

    return new Promise((resolve, reject) => {
      const reqKey = `${Object.keys(payload)[0]}_${conn.requestIdCounter++}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(reqKey);
        reject(new Error("Request timeout"));
      }, timeoutMs);

      conn.pendingRequests.set(reqKey, { resolve, reject, timeout });
      conn.ws.send(JSON.stringify(payload));
    });
  }

  private async subscribeViaConnection(token: string, payload: any, callback: (msg: any) => void, subId: string, timeoutMs: number): Promise<void> {
    const conn = this.wsConnections.get(token);
    if (!conn) throw new Error("Connection not found");

    conn.subscriptions.set(subId, callback);
    conn.ws.send(JSON.stringify(payload));
  }

  private removeSubscriptionFromConnection(token: string, subId: string) {
    const conn = this.wsConnections.get(token);
    if (conn) conn.subscriptions.delete(subId);
  }
}
