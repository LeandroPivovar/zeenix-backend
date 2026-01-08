import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity, CONFIGS_MARTINGALE } from '../ai.service';
import { TradeEventsService } from '../trade-events.service';
import { IStrategy, ModeConfig, ATLAS_VELOZ_CONFIG, ATLAS_NORMAL_CONFIG, ATLAS_LENTO_CONFIG, ModoMartingale } from './common.types';

// ✅ ATLAS: Função para calcular próxima aposta de martingale - ATLAS v2.0
function calcularProximaApostaAtlas(
  perdasTotais: number,
  modo: ModoMartingale,
  payoutCliente: number = 0.63,
): number {
  let aposta = 0;

  // Ajuste do payout se vier como porcentagem (ex: 95)
  const payout = payoutCliente > 1 ? payoutCliente / 100 : payoutCliente;

  switch (modo) {
    case 'conservador':
      // Recupera 100% da perda
      aposta = perdasTotais / payout;
      break;
    case 'moderado':
      // Recupera 100% da perda + 25% de lucro
      aposta = (perdasTotais * 1.25) / payout;
      break;
    case 'agressivo':
      // Recupera 100% da perda + 50% de lucro
      aposta = (perdasTotais * 1.50) / payout;
      break;
  }

  return Math.max(0.35, Math.round(aposta * 100) / 100);
}

// ✅ ATLAS: Estado do usuário
export interface AtlasUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  capitalInicial: number;
  maxBalance: number; // ✅ ATLAS: High Water Mark para Stop Blindado
  modoMartingale: ModoMartingale;
  mode: string; // 'veloz' | 'normal' | 'lento'
  symbol: 'R_10' | 'R_25';

  // Estado de operação
  isOperationActive: boolean;
  pendingContractId: string | null;

  // Martingale e Soros
  martingaleStep: number;
  perdaAcumulada: number;
  apostaInicial: number;
  apostaBase: number;
  ultimaApostaUsada: number;
  vitoriasConsecutivas: number; // Para Soros (0, 1, 2)
  ultimoLucro: number;
  isInRecovery: boolean; // ✅ ATLAS: Recuperação imediata
  isInSoros: boolean; // ✅ ATLAS: Soros imediato

  // Loss Virtual (adaptado para ATLAS)
  virtualLossCount: number; // Modo veloz: 0, normal: max 1, lento: max 2
  virtualLossActive: boolean;

  // Intervalos e controle
  lastOperationTimestamp: Date | null;
  lastApiLatency: number; // ✅ ATLAS: Monitorar latência da API

  // Stop Loss e Meta
  stopLoss?: number;
  stopLossBlindado?: boolean;
  blindadoActive: boolean; // ✅ ATLAS: Se o stop blindado já foi ativado
  profitTarget?: number;
  isStopped: boolean;
  totalProfitLoss: number;

  // Controle de cooldown
  tickCounter?: number; // ✅ ATLAS: Contador para log de "pulso"
  creationCooldownUntil?: number;

  // Buffer de dígitos (análise ultrarrápida)
  digitBuffer: number[]; // Últimos dígitos para análise
}

@Injectable()
export class AtlasStrategy implements IStrategy {
  name = 'atlas';
  private readonly logger = new Logger(AtlasStrategy.name);

  private atlasUsers = new Map<string, AtlasUserState>();
  private atlasTicks: {
    R_10: Tick[];
    R_25: Tick[];
  } = {
      R_10: [],
      R_25: [],
    };

  private appId: string;
  private maxTicks = 50; // ✅ ATLAS: Buffer menor para análise ultrarrápida

  // ✅ Sistema de logs (similar à Trinity)
  private logQueue: Array<{
    userId: string;
    symbol: 'R_10' | 'R_25' | 'SISTEMA';
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;
  private coletaLogsEnviados = new Map<string, Set<string>>();
  private intervaloLogsEnviados = new Map<string, boolean>();

  // ✅ Pool de conexões WebSocket (reutilização)
  private wsConnections: Map<
    string,
    {
      ws: WebSocket;
      authorized: boolean;
      keepAliveInterval: NodeJS.Timeout | null;
      requestIdCounter: number;
      pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
      subscriptions: Map<string, (msg: any) => void>;
      lastLatency: number; // ✅ ATLAS: Rastrear latência
    }
  > = new Map();
  private lastActivationLog: Map<string, number> = new Map();

  constructor(
    private readonly dataSource: DataSource,
    private readonly tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[ATLAS] 🔵 Estratégia ATLAS v2.0 (EHF) inicializada');
    this.logger.log('[ATLAS] ✅ Aguardando ticks do AIService (R_10, R_25)...');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    if (!symbol || !['R_10', 'R_25'].includes(symbol)) {
      // ✅ DIAGNÓSTICO: Log quando recebe símbolo inválido
      if (symbol) {
        this.logger.debug(`[ATLAS] ⚠️ Tick recebido com símbolo inválido: ${symbol} (esperado R_10 ou R_25)`);
      }
      return;
    }

    const assetSymbol = symbol as 'R_10' | 'R_25';
    this.logger.debug(`[ATLAS][${assetSymbol}] 📥 Tick recebido: ${tick.value} (dígito: ${tick.digit})`);

    // Atualizar ticks globais
    const assetTicks = this.atlasTicks[assetSymbol];
    assetTicks.push(tick);
    if (assetTicks.length > 200) {
      assetTicks.shift();
    }

    // Processar para cada usuário deste ativo
    const allAtlasUsers = Array.from(this.atlasUsers.values());
    const activeUsers = allAtlasUsers.filter(u => u.symbol === assetSymbol && !u.isStopped);

    // ✅ DIAGNÓSTICO: Se há usuários mas nenhum fatiado por este ativo
    if (activeUsers.length === 0 && allAtlasUsers.length > 0) {
      this.logger.warn(`[ATLAS][${assetSymbol}] ⚠️ ${allAtlasUsers.length} usuários Atlas totais, mas nenhum ativo para este símbolo.`);
      // Logar símbolos dos usuários para depuração
      allAtlasUsers.forEach(u => {
        this.logger.debug(`[ATLAS][DEBUG] Usuário ${u.userId}: symbol=${u.symbol}, isStopped=${u.isStopped}`);
      });
      return;
    }

    if (activeUsers.length === 0) return;

    for (const state of activeUsers) {
      // Adicionar ao buffer do usuário
      state.digitBuffer.push(tick.digit);
      if (state.digitBuffer.length > 100) {
        state.digitBuffer.shift();
      }

      // ✅ Log de Pulso: Feedback visual periódico
      state.tickCounter = (state.tickCounter || 0) + 1;
      if (state.tickCounter >= 100) {
        state.tickCounter = 0;
        this.saveAtlasLog(state.userId, assetSymbol, 'info', `💓 IA Atlas operando | Analisando mercado ${assetSymbol}...`);
      }

      await this.processAtlasStrategies(tick, state);
    }
  }

  async activateUser(userId: string, config: any): Promise<void> {
    this.logger.log(`[ATLAS] 🔵 Ativando usuário ${userId}...`);
    const {
      mode,
      stakeAmount,
      derivToken,
      currency,
      modoMartingale,
      profitTarget,
      lossLimit,
      entryValue,
      stopLossBlindado,
      symbol,
      selectedMarket, // ✅ Pode vir do frontend como selectedMarket
    } = config;

    // ✅ Determinar símbolo: R_10 (vol10) ou R_25 (vol25)
    let atlasSymbol: 'R_10' | 'R_25' = 'R_10'; // Default
    if (symbol && ['R_10', 'R_25'].includes(symbol)) {
      atlasSymbol = symbol as 'R_10' | 'R_25';
    } else if (selectedMarket) {
      const marketLower = selectedMarket.toLowerCase();
      // Mapeamento preciso: evitar que 'vol100' combine com 'vol10'
      if (marketLower === 'r_10' || marketLower === 'vol10' || marketLower === 'volatility 10 index') {
        atlasSymbol = 'R_10';
      } else if (marketLower === 'r_25' || marketLower === 'vol25' || marketLower === 'volatility 25 index') {
        atlasSymbol = 'R_25';
      } else {
        // Fallback robusto se for apenas substring mas não exato
        if ((marketLower.includes('vol10') && !marketLower.includes('vol100')) || marketLower.includes('r_10')) {
          atlasSymbol = 'R_10';
        } else if (marketLower.includes('vol25') || marketLower.includes('r_25')) {
          atlasSymbol = 'R_25';
        }
      }
    }

    const stakeAmountNum = Number(stakeAmount);
    const profitTargetNum = profitTarget != null ? Number(profitTarget) : null;
    const lossLimitNum = lossLimit != null ? Number(lossLimit) : null;
    const stopLossNormalized = lossLimitNum != null ? -Math.abs(lossLimitNum) : null;
    const apostaInicial = entryValue != null ? Number(entryValue) : 0.35;

    const { isNew, hasConfigChanges } = this.upsertAtlasUserState({
      userId,
      stakeAmount: stakeAmountNum,
      apostaInicial,
      derivToken,
      currency,
      mode: mode || 'veloz',
      modoMartingale: modoMartingale || 'conservador',
      profitTarget: profitTargetNum,
      lossLimit: stopLossNormalized,
      stopLossBlindado: Boolean(stopLossBlindado),
      symbol: atlasSymbol,
    });

    const now = Date.now();
    const lastLogTime = this.lastActivationLog.get(userId) || 0;

    if (isNew || (hasConfigChanges && (now - lastLogTime > 5000))) {
      const logPrefix = isNew ? 'Usuário ATIVADO' : 'Usuário JÁ ATIVO (config atualizada)';
      this.logger.log(`[ATLAS] ✅ ${logPrefix} ${userId} | Ativo: ${atlasSymbol} | Total de usuários: ${this.atlasUsers.size}`);

      this.saveAtlasLog(userId, 'SISTEMA', 'info',
        `${logPrefix} | Modo: ${mode || 'veloz'} | Ativo: ${atlasSymbol} | Capital: $${stakeAmountNum.toFixed(2)} | ` +
        `Martingale: ${modoMartingale || 'conservador'} | ` +
        `Meta: ${profitTargetNum ? `+$${profitTargetNum.toFixed(2)}` : 'Não definida'} | ` +
        `Stop-loss: ${lossLimitNum ? `-$${Math.abs(lossLimitNum).toFixed(2)}` : 'Não definido'} | ` +
        `Stop blindado: ${stopLossBlindado ? 'Ativo' : 'Inativo'}`);

      this.lastActivationLog.set(userId, now);

      // Limpar suppressors para dar feedback fresco
      this.coletaLogsEnviados.delete(userId);
      this.intervaloLogsEnviados.delete(`${atlasSymbol}_${userId}_intervalo`);
    }
  }

  async deactivateUser(userId: string): Promise<void> {
    this.atlasUsers.delete(userId);
    this.logger.log(`[ATLAS] Usuário ${userId} desativado`);
  }

  getUserState(userId: string): AtlasUserState | null {
    return this.atlasUsers.get(userId) || null;
  }

  /**
   * ✅ ATLAS: Processa estratégias para um usuário específico
   */
  private async processAtlasStrategies(tick: Tick, state: AtlasUserState): Promise<void> {
    const symbol = state.symbol;
    this.logger.debug(`[ATLAS][${symbol}][${state.userId}] 🔄 Analisando... Buffer: ${state.digitBuffer.length} dígitos`);

    // Verificar se pode processar
    if (!this.canProcessAtlasAsset(state)) {
      return;
    }

    // ✅ ATLAS: Verificar resultado do contrato pendente primeiro
    if (state.pendingContractId && state.isOperationActive) {
      // Aguardar resultado (vem no próximo tick)
      return;
    }

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) {
      this.logger.error(`[ATLAS][${symbol}][${state.userId}] ❌ Erro: Configuração do modo '${state.mode}' não encontrada.`);
      return;
    }

    // ✅ ATLAS: Verificar amostra mínima
    if (state.digitBuffer.length < modeConfig.amostraInicial) {
      const keyUser = state.userId;
      const set = this.coletaLogsEnviados.get(keyUser) || new Set<string>();
      // ✅ Log mais frequente para diagnóstico (a cada 5 dígitos coletados)
      const logKey = `${symbol}_coleta`;
      const shouldLog = !set.has(logKey) || state.digitBuffer.length % 5 === 0;
      if (shouldLog) {
        this.saveAtlasLog(state.userId, symbol, 'info',
          `📊 Aguardando ${modeConfig.amostraInicial} dígitos para análise | Coletados: ${state.digitBuffer.length}/${modeConfig.amostraInicial} | Modo: ${state.mode}`);
        set.add(logKey);
        this.coletaLogsEnviados.set(keyUser, set);
        // Resetar após logar para permitir novo log quando necessário
        if (state.digitBuffer.length % 5 === 0) {
          set.delete(logKey);
        }
      }
      return;
    }

    // ✅ ATLAS: Lógica de Recuperação/Soros Imediata
    if (state.isInRecovery || state.isInSoros) {
      // Recuperação imediata: executar no próximo tick disponível
      await this.executeAtlasOperation(state, symbol, 'OVER');
      return;
    }

    // ✅ ATLAS: Verificar gatilho e análise ultrarrápida
    const { canTrade, analysis } = this.checkAtlasTriggers(state, modeConfig);
    if (canTrade) {
      await this.executeAtlasOperation(state, symbol, 'OVER', analysis);
    } else {
      // ✅ Log periódico quando análise bloqueia operação (a cada 20 ticks para não poluir)
      const key = `${symbol}_${state.userId}_bloqueio`;
      if (!this.intervaloLogsEnviados.has(key) || (state.tickCounter || 0) % 20 === 0) {
        this.saveAtlasLog(state.userId, symbol, 'analise', analysis);
        this.intervaloLogsEnviados.set(key, true);
        // Resetar após 20 ticks
        if ((state.tickCounter || 0) % 20 === 0) {
          this.intervaloLogsEnviados.delete(key);
        }
      }
    }
  }

  /**
   * ✅ ATLAS: Verifica gatilhos ultrarrápidos
   */
  private checkAtlasTriggers(state: AtlasUserState, modeConfig: ModeConfig): { canTrade: boolean; analysis: string } {
    // Mapeamento de loss virtual por modo
    const requiredLosses = { veloz: 0, normal: 1, lento: 2 };
    const requiredLossCount = requiredLosses[state.mode as keyof typeof requiredLosses] || 0;

    let analysis = `🔍 [ANÁLISE ATLAS ${state.mode.toUpperCase()}]\n`;
    analysis += ` • Gatilho Virtual: ${state.virtualLossCount}/${requiredLossCount} ${state.virtualLossCount >= requiredLossCount ? '✅' : '❌'}\n`;

    // ✅ CORREÇÃO: Permitir primeira operação sem loss virtual (evita deadlock)
    // Se nunca operou (lastOperationTimestamp é null), permitir operar sem loss virtual
    const isFirstOperation = state.lastOperationTimestamp === null;
    
    if (!isFirstOperation && state.virtualLossCount < requiredLossCount) {
      return { canTrade: false, analysis }; // Ainda não atingiu o gatilho de loss virtual
    }

    const lastDigits = state.digitBuffer.slice(-modeConfig.amostraInicial);
    analysis += ` • Últimos Dígitos: [${lastDigits.join(', ')}]\n`;

    // ✅ ATLAS VELOZ: Análise mínima - apenas verificar sequência imediata
    if (state.mode === 'veloz') {
      // Se os últimos 3 dígitos foram todos Over (> 3), evitar entrada
      const last3 = state.digitBuffer.slice(-3);
      if (last3.length === 3 && last3.every(d => d > 3)) {
        analysis += ` • Filtro de Pico (>3): ${last3.filter(d => d > 3).length}/3 (Saturado) ❌\n`;
        return { canTrade: false, analysis }; // Evita entrar no pico de sequência
      }
      analysis += ` • Filtro de Pico (>3): ${last3.filter(d => d > 3).length}/3 (OK) ✅\n`;
      analysis += `🌊 [DECISÃO] Critérios atendidos. Entrada: OVER`;
      return { canTrade: true, analysis }; // ✅ Pode operar (gatilho = 0)
    }

    // ✅ ATLAS NORMAL/LENTO: Análise de desequilíbrio
    if (state.mode === 'normal' || state.mode === 'lento') {
      const over3Count = lastDigits.filter(d => d > 3).length;
      const over3Ratio = over3Count / lastDigits.length;
      const over3Percent = Math.round(over3Ratio * 100);
      const metaPercent = Math.round(modeConfig.desequilibrioMin * 100);

      analysis += ` • Frequência Over (>3): ${over3Percent}% (Meta ≤ ${metaPercent}%) ${over3Ratio <= modeConfig.desequilibrioMin ? '✅' : '❌'}\n`;

      // Se a frequência de Over está muito alta, aguardar
      if (over3Ratio > modeConfig.desequilibrioMin) {
        return { canTrade: false, analysis };
      }

      analysis += `🌊 [DECISÃO] Critérios atendidos. Entrada: OVER`;
      return { canTrade: true, analysis };
    }

    return { canTrade: false, analysis };
  }

  /**
   * ✅ ATLAS: Verifica se pode processar ativo
   */
  private canProcessAtlasAsset(state: AtlasUserState): boolean {
    if (state.isOperationActive) return false;
    if (state.creationCooldownUntil && Date.now() < state.creationCooldownUntil) return false;

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return false;

    // Verificar intervalo de tempo
    if (state.lastOperationTimestamp && modeConfig.intervaloSegundos) {
      const secondsSinceLastOp = (Date.now() - state.lastOperationTimestamp.getTime()) / 1000;
      if (secondsSinceLastOp < modeConfig.intervaloSegundos) {
        const key = `${state.symbol}_${state.userId}_intervalo`;
        if (!this.intervaloLogsEnviados.has(key)) {
          this.saveAtlasLog(state.userId, state.symbol, 'info',
            `⏱️ Aguardando intervalo | ${secondsSinceLastOp.toFixed(1)}s / ${modeConfig.intervaloSegundos}s`);
          this.intervaloLogsEnviados.set(key, true);
        }
        return false;
      }
    }

    return true;
  }

  /**
   * ✅ ATLAS: Obtém configuração do modo
   */
  private getModeConfig(mode: string): ModeConfig | null {
    const modeLower = (mode || 'veloz').toLowerCase();
    if (modeLower === 'veloz') return ATLAS_VELOZ_CONFIG;
    if (modeLower === 'normal' || modeLower === 'moderado') return ATLAS_NORMAL_CONFIG;
    if (modeLower === 'lento' || modeLower === 'preciso' || modeLower === 'lenta') return ATLAS_LENTO_CONFIG;

    // Fallback padrão se não reconhecido
    this.logger.warn(`[ATLAS] Modo '${mode}' não mapeado, usando VELOZ por padrão.`);
    return ATLAS_VELOZ_CONFIG;
  }

  /**
   * ✅ ATLAS: Executa operação completa
   */
  private async executeAtlasOperation(
    state: AtlasUserState,
    symbol: 'R_10' | 'R_25',
    operation: 'OVER' | 'UNDER',
    analysis?: string,
  ): Promise<void> {
    // ✅ Verificações pré-entrada: meta, stop-loss e stop-blindado

    // =================================================================================
    // ✅ VERIFICAÇÕES DE RISCO (ANTES DE CALCULAR STAKE)
    // =================================================================================
    // Copiado da OrionStrategy para garantir compatibilidade com o frontend
    const lucroAtualRisco = state.capital - state.capitalInicial; // Usar nome diferente para evitar conflito
    const profitTarget = state.profitTarget || 0;
    const lossLimit = state.stopLoss ? Math.abs(state.stopLoss) : 0;
    const capitalSessao = state.capital;

    // 1. Verificar Trade Events (High Water Mark para Stop Blindado)
    if (state.capital > state.maxBalance) {
      state.maxBalance = state.capital;
    }
    const profitPeak = state.maxBalance - state.capitalInicial;

    // 2. Verificar Gatilho do Stop Blindado (40% da Meta)
    const activationTrigger = profitTarget * 0.40;
    if (state.stopLossBlindado && !state.blindadoActive && profitTarget > 0 && profitPeak >= activationTrigger) {
      state.blindadoActive = true;
      const pisoGarantido = state.capitalInicial + (profitPeak * 0.5);
      const protectedAmount = profitPeak * 0.5;
      // Log de ativação
      this.saveAtlasLog(state.userId, 'SISTEMA', 'info',
        `🛡️✅ STOP BLINDADO ATIVADO! Protegendo $${protectedAmount.toFixed(2)} (50% do pico $${profitPeak.toFixed(2)}) | Stop: $${pisoGarantido.toFixed(2)}`
      );
    }

    // 3. META DE LUCRO
    if (profitTarget > 0 && lucroAtualRisco >= profitTarget) {
      this.saveAtlasLog(state.userId, 'SISTEMA', 'info',
        `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtualRisco.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW() WHERE user_id = ? AND is_active = 1`,
        [`Meta atingida: +$${lucroAtualRisco.toFixed(2)}`, state.userId]
      );

      this.atlasUsers.delete(state.userId);
      state.isStopped = true;
      return;
    }

    // 4. STOP-LOSS BLINDADO
    if (state.stopLossBlindado && state.blindadoActive) {
      const stopBlindado = state.capitalInicial + (profitPeak * 0.5); // 50% do pico
      const lucroProtegido = profitPeak * 0.5;

      if (capitalSessao <= stopBlindado) {
        this.saveAtlasLog(state.userId, 'SISTEMA', 'alerta',
          `🛡️ STOP-LOSS BLINDADO ATIVADO! Protegido: $${lucroProtegido.toFixed(2)} (50% do pico $${profitPeak.toFixed(2)}) - IA DESATIVADA`
        );

        await this.dataSource.query(
          `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW() WHERE user_id = ? AND is_active = 1`,
          [`Stop Blindado: +$${lucroProtegido.toFixed(2)}`, state.userId]
        );

        this.atlasUsers.delete(state.userId);
        state.isStopped = true;
        return;
      }
    }

    // 5. STOP LOSS NORMAL
    // Só verifica se NÃO estiver no blindado (blindado tem prioridade)
    if (!state.blindadoActive && lossLimit > 0) {
      // Perda atual é o inverso do lucro atual (se lucro negativo)
      const perdaAtual = -lucroAtualRisco;

      if (perdaAtual >= lossLimit) {
        this.saveAtlasLog(state.userId, 'SISTEMA', 'alerta',
          `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`
        );

        await this.dataSource.query(
          `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW() WHERE user_id = ? AND is_active = 1`,
          [`Stop Loss: -$${perdaAtual.toFixed(2)}`, state.userId]
        );

        this.atlasUsers.delete(state.userId);
        state.isStopped = true;
        return;
      }
    }

    // =================================================================================
    // FIM DAS VERIFICAÇÕES DE RISCO
    // =================================================================================

    // ✅ Calcular stake
    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) {
      state.isOperationActive = false;
      return;
    }

    let stakeAmount = state.apostaInicial;

    // ✅ Martingale ou Soros
    if (state.isInRecovery && state.martingaleStep > 0) {
      const payout = modeConfig.payout;
      const perdas = state.perdaAcumulada;
      stakeAmount = calcularProximaApostaAtlas(perdas, state.modoMartingale, payout);

      if (state.modoMartingale === 'conservador' && state.martingaleStep > 5) {
        this.saveAtlasLog(state.userId, symbol, 'info',
          `🛡️ Limite de Martingale (5) atingido no modo conservador. Resetando ciclo.`);
        state.martingaleStep = 0;
        state.perdaAcumulada = 0;
        state.isInRecovery = false;
        stakeAmount = state.apostaBase;
      }

      const stopLossDisponivel = this.calculateAvailableStopLoss(state);
      if (stopLossDisponivel > 0 && stakeAmount > stopLossDisponivel) {
        stakeAmount = Math.max(0.35, Math.min(state.apostaBase, stopLossDisponivel));
      }
    } else if (state.isInSoros && state.vitoriasConsecutivas > 0) {
      const SOROS_FACTOR = 0.9;
      if (state.vitoriasConsecutivas === 1) {
        stakeAmount = state.apostaBase + (state.ultimoLucro * SOROS_FACTOR);
      } else if (state.vitoriasConsecutivas === 2) {
        stakeAmount = state.ultimaApostaUsada + (state.ultimoLucro * SOROS_FACTOR);
      }
    }

    // Ajuste final
    stakeAmount = Math.max(0.35, Number(stakeAmount.toFixed(2)));


    // =================================================================================
    // ✅ GESTÃO DE RISCO AVANÇADA - PRECISÃO (Stake Clamping)
    // =================================================================================

    // Definir Piso (Limite Inferior) para Clamping
    let minAllowedBalance = 0.0;
    let limitType = '';

    if (state.blindadoActive) {
      // MODO BLINDADO: Garante 50% do lucro máximo atingido
      // Usando 'profitPeak' que já foi calculado no topo
      const guaranteedProfit = profitPeak * 0.5;
      minAllowedBalance = state.capitalInicial + guaranteedProfit;
      limitType = 'STOP BLINDADO (LUCRO GARANTIDO)';
    } else {
      // MODO NORMAL: Stop Loss configurado
      const stopLossLimit = state.stopLoss ? Math.abs(state.stopLoss) : 0;
      if (stopLossLimit > 0) {
        minAllowedBalance = state.capitalInicial - stopLossLimit;
        limitType = 'STOP LOSS NORMAL';
      } else {
        minAllowedBalance = -Infinity; // Sem stop loss
      }
    }

    // 5. STAKE CLAMPING (Ajuste de Precisão)
    // Verifica se a perda desta aposta faria cruzar o piso
    const potentialBalanceAfterLoss = state.capital - stakeAmount;

    if (minAllowedBalance !== -Infinity && potentialBalanceAfterLoss < minAllowedBalance) {
      // Precisamos reduzir a mão para não quebrar o stop/blindado
      let adjustedStake = state.capital - minAllowedBalance;
      adjustedStake = Math.round(adjustedStake * 100) / 100;

      if (adjustedStake < 0.35) {
        // Não há margem nem para a aposta mínima. STOP!

        let logMsg = '';
        const status = state.blindadoActive ? 'stopped_blindado' : 'stopped_loss';
        const reason = state.blindadoActive ? 'Meta Parcial (Blindado)' : 'Stop Loss Atingido';

        if (state.blindadoActive) {
          const lucroProtegido = state.capital - state.capitalInicial;
          logMsg = `🛡️ STOP-LOSS BLINDADO ATIVADO! Protegido: $${lucroProtegido.toFixed(2)} (50% do pico $${profitPeak.toFixed(2)}) - IA DESATIVADA`;
        } else {
          // Calcular perda atual para exibição (simulando que atingiu o limite, já que não pode mais operar)
          const perdaAtual = state.capitalInicial - state.capital;
          const stopLimit = state.stopLoss ? Math.abs(state.stopLoss) : 0;
          logMsg = `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${stopLimit.toFixed(2)} - IA DESATIVADA`;
        }

        // ✅ Usar 'symbol' em vez de 'SISTEMA' para consistência (frontend pode filtrar)
        this.saveAtlasLog(state.userId, symbol, state.blindadoActive ? 'alerta' : 'alerta', logMsg);

        await this.dataSource.query(
          `UPDATE ai_user_config SET is_active = 0, session_status = ?, deactivation_reason = ?, deactivated_at = NOW() WHERE user_id = ? AND is_active = 1`,
          [status, `${reason}: $${state.capital.toFixed(2)}`, state.userId],
        );
        this.atlasUsers.delete(state.userId);
        state.isStopped = true;
        return;
      }

      // Se ajustou, logar o ajuste
      if (adjustedStake !== stakeAmount) {
        this.saveAtlasLog(state.userId, symbol, 'alerta',
          `⚠️ [PRECISÃO] Stake ajustada de $${stakeAmount.toFixed(2)} para $${adjustedStake.toFixed(2)} para respeitar ${limitType}`);
        stakeAmount = adjustedStake;
        state.ultimaApostaUsada = stakeAmount; // Atualizar referência
      }
    }


    // Marcar como operação ativa
    state.isOperationActive = true;
    state.lastOperationTimestamp = new Date();

    state.ultimaApostaUsada = stakeAmount;

    // ✅ ATLAS: Filtro de Latência (crítico para EHF) - DESATIVADO A PEDIDO DO CLIENTE
    /*
    const connection = this.wsConnections.get(state.derivToken);
    if (connection && connection.lastLatency > 500) {
      this.saveAtlasLog(state.userId, symbol, 'alerta', 
        `⚠️ Latência alta detectada: ${connection.lastLatency}ms | Operação abortada`);
      state.isOperationActive = false;
      state.creationCooldownUntil = Date.now() + 2000;
      return;
    }
    */

    if (analysis) {
      this.saveAtlasLog(state.userId, symbol, 'analise', analysis);
    }

    const contractType = operation === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER';

    this.logger.log(
      `[ATLAS][${symbol}] 🎲 EXECUTANDO | User: ${state.userId} | ` +
      `Operação: ${operation} | Stake: $${stakeAmount.toFixed(2)} | ` +
      `Recovery: ${state.isInRecovery ? `M${state.martingaleStep}` : 'Não'} | ` +
      `Soros: ${state.isInSoros ? `Nível ${state.vitoriasConsecutivas}` : 'Não'}`,
    );

    try {
      const entryPrice = this.atlasTicks[symbol].length > 0
        ? this.atlasTicks[symbol][this.atlasTicks[symbol].length - 1].value
        : 0;

      const tradeId = await this.saveAtlasTrade({
        userId: state.userId,
        contractId: null,
        symbol,
        contractType,
        entryPrice,
        stakeAmount,
        operation,
        mode: state.mode,
      });

      const result = await this.executeAtlasTradeDirect(
        state.userId,
        symbol,
        state.derivToken,
        {
          symbol,
          contract_type: contractType,
          amount: stakeAmount,
          currency: state.currency,
          duration: 1,
          duration_unit: 't',
        },
      );

      if (!result) {
        state.isOperationActive = false;
        state.creationCooldownUntil = Date.now() + 2000;
        this.saveAtlasLog(state.userId, symbol, 'erro', `Erro ao executar operação | Não foi possível criar contrato`);
        return;
      }

      const { contractId, profit, exitSpot } = result;
      const exitPrice = Number(exitSpot || 0);
      const confirmedStatus = profit > 0 ? 'WON' : 'LOST';

      await this.updateAtlasTrade(tradeId, state.userId, {
        contractId,
        status: confirmedStatus,
        profitLoss: profit,
        exitPrice,
      });

      this.logger.log(`[ATLAS][${symbol}] ${confirmedStatus} | User: ${state.userId} | P&L: $${profit.toFixed(2)}`);

      await this.processAtlasResult(state, symbol, confirmedStatus === 'WON', stakeAmount, operation, profit, exitPrice, tradeId);

    } catch (error) {
      this.logger.error(`[ATLAS][${symbol}] Erro ao executar operação:`, error);
      state.isOperationActive = false;
      state.creationCooldownUntil = Date.now() + 2000;
    }
  }

  /**
   * ✅ ATLAS: Executa trade via WebSocket e monitora resultado
   */
  private async executeAtlasTradeDirect(
    userId: string,
    symbol: 'R_10' | 'R_25',
    token: string,
    contractParams: any,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    try {
      const connection = await this.getOrCreateWebSocketConnection(token, userId, symbol);

      const proposalStartTime = Date.now();
      // ✅ ATLAS: Para DIGITOVER/DIGITUNDER, é necessário o parâmetro barrier (dígito de comparação)
      // ATLAS opera com OVER/UNDER baseado em dígito > 3, então barrier = 3
      const proposalPayload: any = {
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: contractParams.symbol,
      };

      // ✅ Adicionar barrier para contratos DIGITOVER/DIGITUNDER
      if (contractParams.contract_type === 'DIGITOVER' || contractParams.contract_type === 'DIGITUNDER') {
        proposalPayload.barrier = 3; // Dígito de comparação: > 3 (OVER) ou ≤ 3 (UNDER)
      }

      const proposalResponse: any = await connection.sendRequest(proposalPayload, 60000);

      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        const errorCode = errorObj?.code || '';
        const errorMessage = errorObj?.message || JSON.stringify(errorObj);
        this.logger.error(`[ATLAS][${symbol}] ❌ Erro na proposta: ${errorMessage} | Código: ${errorCode} | Tipo: ${contractParams.contract_type}`);
        this.saveAtlasLog(userId, symbol, 'erro', `❌ Erro na proposta da Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`);
        return null;
      }

      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);
      if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
        this.logger.error(`[ATLAS][${symbol}] ❌ Proposta inválida`);
        return null;
      }

      const proposalDuration = Date.now() - proposalStartTime;

      // ✅ ATLAS: Atualizar latência
      const conn = this.wsConnections.get(token);
      if (conn) {
        conn.lastLatency = proposalDuration;
      }

      const buyStartTime = Date.now();
      let buyResponse: any;
      try {
        buyResponse = await connection.sendRequest({
          buy: proposalId,
          price: proposalPrice,
        }, 60000);
      } catch (error: any) {
        this.logger.error(`[ATLAS][${symbol}] ❌ Erro ao comprar contrato: ${error.message}`);
        return null;
      }

      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        const errorCode = buyErrorObj?.code || '';
        const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);
        this.logger.error(`[ATLAS][${symbol}] ❌ Erro ao comprar contrato: ${errorMessage} | Código: ${errorCode} | ProposalId: ${proposalId}`);
        this.saveAtlasLog(userId, symbol, 'erro', `❌ Erro ao comprar contrato: ${errorMessage}`);
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[ATLAS][${symbol}] ❌ Contrato criado mas sem contract_id`);
        return null;
      }

      const buyDuration = Date.now() - buyStartTime;
      this.logger.log(`[ATLAS][${symbol}] ✅ Contrato criado | Proposal: ${proposalDuration}ms | Compra: ${buyDuration}ms | ContractId: ${contractId}`);
      this.saveAtlasLog(userId, symbol, 'operacao', `✅ Contrato criado: ${contractId} | Proposta: ${proposalDuration}ms | Compra: ${buyDuration}ms`);

      // Monitorar contrato
      return await new Promise((resolve) => {
        let hasResolved = false;
        let contractMonitorTimeout: NodeJS.Timeout | null = null;

        contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[ATLAS][${symbol}] ⏱️ Timeout ao monitorar contrato (90s) | ContractId: ${contractId}`);
            connection.removeSubscription(contractId);
            resolve(null);
          }
        }, 90000);

        connection.subscribe(
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          (msg: any) => {
            try {
              if (msg.error) {
                if (!hasResolved) {
                  hasResolved = true;
                  if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                  connection.removeSubscription(contractId);
                  resolve(null);
                }
                return;
              }

              const contract = msg.proposal_open_contract;
              if (!contract) return;

              const isFinalized =
                contract.is_sold === 1 ||
                contract.is_sold === true ||
                contract.status === 'won' ||
                contract.status === 'lost' ||
                contract.status === 'sold';

              if (isFinalized && !hasResolved) {
                hasResolved = true;
                if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);

                const profit = Number(contract.profit || 0);
                const exitSpot = contract.exit_spot || contract.current_spot;

                connection.removeSubscription(contractId);
                resolve({ contractId, profit, exitSpot });
              }
            } catch (error) {
              if (!hasResolved) {
                hasResolved = true;
                if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                connection.removeSubscription(contractId);
                resolve(null);
              }
            }
          },
          contractId,
          90000,
        ).catch((error) => {
          if (!hasResolved) {
            hasResolved = true;
            if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
            resolve(null);
          }
        });
      });
    } catch (error) {
      this.logger.error(`[ATLAS][${symbol}] ❌ Erro ao executar trade:`, error);
      return null;
    }
  }

  /**
   * ✅ ATLAS: Processa resultado da operação
   */
  private async processAtlasResult(
    state: AtlasUserState,
    symbol: 'R_10' | 'R_25',
    isWin: boolean,
    stakeAmount: number,
    operation: 'OVER' | 'UNDER',
    profit: number = 0,
    exitPrice: number = 0,
    tradeId?: number | null,
  ): Promise<void> {
    state.isOperationActive = false;
    state.pendingContractId = null;
    state.lastOperationTimestamp = new Date();
    state.creationCooldownUntil = Date.now() + 500; // ✅ ATLAS: Cooldown mínimo para EHF

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return;

    if (isWin) {
      // ✅ VITÓRIA
      // O profit da API Deriv já é o lucro líquido (ganho bruto - aposta)
      // Se profit > 0, usar diretamente; se não, calcular ganho bruto - aposta
      const lucro = profit > 0 ? profit : (stakeAmount * modeConfig.payout - stakeAmount);
      state.capital += lucro;
      state.totalProfitLoss += lucro;

      // ✅ Recuperação: resetar
      if (state.isInRecovery) {
        const nivelAntes = state.martingaleStep;
        const perdaRecuperada = state.perdaAcumulada;

        // ✅ Calcular ganho bruto para exibição (lucro líquido + aposta)
        const ganhoBrutoRecuperacao = lucro + stakeAmount;
        this.saveAtlasLog(state.userId, symbol, 'info',
          `MARTINGALE RECUPERADO ✅ | Nível: ${nivelAntes} → 0 | Perda recuperada: $${perdaRecuperada.toFixed(2)} | Ganho: $${ganhoBrutoRecuperacao.toFixed(2)} | Lucro: $${lucro.toFixed(2)}`);

        state.martingaleStep = 0;
        state.perdaAcumulada = 0;
        state.isInRecovery = false;
        state.apostaInicial = state.apostaBase;
        state.virtualLossCount = 0; // ✅ ATLAS: Resetar loss virtual na recuperação
      }
      // ✅ Soros: verificar ciclo (Apenas se NÃO estava em recuperação)
      else if (!state.isInRecovery) {
        if (state.vitoriasConsecutivas === 0) {
          // Primeira vitória: ativar Soros Nível 1
          state.vitoriasConsecutivas = 1;
          state.isInSoros = true;
          state.ultimoLucro = lucro;
        } else if (state.vitoriasConsecutivas === 1) {
          // Soros Nível 1 vitorioso: ativar Soros Nível 2
          state.vitoriasConsecutivas = 2;
          state.ultimoLucro = lucro;
        } else if (state.vitoriasConsecutivas === 2) {
          // Soros Nível 2 vitorioso: ciclo completo
          state.vitoriasConsecutivas = 0;
          state.isInSoros = false;
          state.ultimoLucro = 0;
        }
      }

      const digitoResultado = exitPrice > 0 ? this.extractLastDigit(exitPrice) : 0;
      // ✅ O profit da API Deriv já é lucro líquido (ganho bruto - aposta)
      // Para exibir o ganho bruto, somamos a aposta de volta
      const ganhoBruto = lucro + stakeAmount;
      this.saveAtlasLog(state.userId, symbol, 'resultado',
        `✅ VITÓRIA! | Dígito: ${digitoResultado} (${digitoResultado > 3 ? 'OVER' : 'UNDER'}) ✅ | ` +
        `Aposta: $${stakeAmount.toFixed(2)} | Ganho: $${ganhoBruto.toFixed(2)} | Lucro: $${lucro.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`);

    } else {
      // ✅ DERROTA
      const perda = stakeAmount;
      state.capital -= perda;
      state.totalProfitLoss -= perda;

      // ✅ Interromper Soros
      if (state.isInSoros) {
        state.vitoriasConsecutivas = 0;
        state.isInSoros = false;
        state.ultimoLucro = 0;
      }

      // ✅ Ativar/incrementar Martingale (recuperação imediata)
      if (state.martingaleStep === 0) {
        state.martingaleStep = 1;
        state.perdaAcumulada = perda;
        state.isInRecovery = true; // ✅ ATLAS: Recuperação imediata
        state.virtualLossCount = (state.virtualLossCount || 0) + 1;
      } else {
        state.martingaleStep += 1;
        state.perdaAcumulada += perda;
        state.virtualLossCount = (state.virtualLossCount || 0) + 1;
      }

      // ✅ ATLAS: Atualizar loss virtual conforme modo
      const requiredLosses = { veloz: 0, normal: 1, lento: 2 };
      const maxLosses = requiredLosses[state.mode as keyof typeof requiredLosses] || 0;

      if (state.virtualLossCount > maxLosses) {
        state.virtualLossCount = maxLosses; // Limitar conforme modo
        state.virtualLossActive = true;
      }

      const digitoResultado = exitPrice > 0 ? this.extractLastDigit(exitPrice) : 0;
      this.saveAtlasLog(state.userId, symbol, 'resultado',
        `❌ DERROTA! | Dígito: ${digitoResultado} (${digitoResultado > 3 ? 'OVER' : 'UNDER'}) ❌ | ` +
        `Aposta: $${stakeAmount.toFixed(2)} | Perda: -$${perda.toFixed(2)} | Capital: $${state.capital.toFixed(2)} | ` +
        `Martingale: M${state.martingaleStep} | Recovery: ${state.isInRecovery ? 'SIM' : 'NÃO'}`);
    }

    // Verificar limites
    await this.checkAtlasLimits(state);

    // Atualizar trade
    if (tradeId) {
      await this.updateAtlasTrade(tradeId, state.userId, {
        status: isWin ? 'WON' : 'LOST',
        profitLoss: profit,
        exitPrice: exitPrice || 0,
      });
    }
  }

  /**
   * ✅ ATLAS: Verifica limites (meta, stop-loss)
   */
  private async checkAtlasLimits(state: AtlasUserState): Promise<void> {
    const stopLossValue = state.stopLoss != null ? -Math.abs(state.stopLoss) : null;
    const lucroAtual = state.capital - state.capitalInicial;
    const symbol = state.symbol || 'SISTEMA';

    // 1. Meta de Lucro (Profit Target)
    if (state.profitTarget && lucroAtual >= state.profitTarget) {
      state.isStopped = true;

      // ✅ Log padronizado para o Frontend
      this.saveAtlasLog(state.userId, symbol, 'info',
        `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${state.profitTarget.toFixed(2)} - IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)}`, state.userId],
      );
      this.atlasUsers.delete(state.userId);
      return;
    }

    // 2. Stop-loss blindado (Prioridade sobre Stop Loss Normal)
    if (state.stopLossBlindado && lucroAtual > 0) {
      try {
        const configResult = await this.dataSource.query(
          `SELECT COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent, COALESCE(profit_peak, 0) as profitPeak
           FROM ai_user_config WHERE user_id = ? AND is_active = 1 LIMIT 1`,
          [state.userId],
        );

        let profitPeak = parseFloat(configResult[0]?.profitPeak || 0);
        let updatedPeak = false;

        // Auto-healing / Update Peak
        if (lucroAtual > profitPeak) {
          const profitPeakAnterior = profitPeak;
          profitPeak = lucroAtual;
          updatedPeak = true;

          // ✅ Log quando profit peak aumenta significativamente (apenas se já estiver próximo ou acima da ativação)
          // Para evitar flood, logar apenas se o novo pico for relevante (>= 40% da meta)
          if (state.profitTarget && profitPeak >= state.profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(configResult[0]?.stopBlindadoPercent || 50.0);
            const fatorProtecao = stopBlindadoPercent / 100;
            const protectedAmount = profitPeak * fatorProtecao;

            this.saveAtlasLog(
              state.userId,
              symbol,
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

        const stopBlindadoPercent = configResult && configResult.length > 0
          ? parseFloat(configResult[0].stopBlindadoPercent) || 50.0
          : 50.0;
        const fatorProtecao = stopBlindadoPercent / 100;

        // Verificar ativação (40% da meta)
        const activationTrigger = (state.profitTarget || 0) * 0.40;

        if (state.profitTarget && profitPeak >= activationTrigger) {
          // Ativo
          const protectedAmount = profitPeak * fatorProtecao;
          const stopBlindado = state.capitalInicial + protectedAmount;

          // Se o capital caiu abaixo do stop blindado
          if (state.capital <= stopBlindado) {
            state.isStopped = true;
            const lucroProtegido = state.capital - state.capitalInicial;

            // ✅ Log padronizado para o Frontend
            this.saveAtlasLog(state.userId, symbol, 'alerta',
              `🛡️ STOP-LOSS BLINDADO ATIVADO! Protegido: $${lucroProtegido.toFixed(2)} (50% do pico $${profitPeak.toFixed(2)}) - IA DESATIVADA`
            );

            await this.dataSource.query(
              `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
                WHERE user_id = ? AND is_active = 1`,
              [`Stop Blindado: +$${lucroProtegido.toFixed(2)}`, state.userId],
            );
            this.atlasUsers.delete(state.userId);
            return;
          }
        } else if (state.profitTarget && lucroAtual > 0) {
          // Ainda não ativou, mas mostrar progresso se tiver lucro relevante
          // Evitar flood: mostrar apenas se atualizou o pico ou em intervalos específicos (opcional, deixaremos simples por enquanto)
          if (updatedPeak) {
            const percentualAteAtivacao = (lucroAtual / activationTrigger) * 100;
            this.saveAtlasLog(
              state.userId,
              symbol,
              'info',
              `🛡️ Stop Blindado: Lucro $${lucroAtual.toFixed(2)} | Meta ativação: $${activationTrigger.toFixed(2)} (${percentualAteAtivacao.toFixed(1)}%)`
            );
          }
        }

      } catch (error) {
        this.logger.error(`[ATLAS] Erro ao verificar stop-loss blindado:`, error);
      }
    }

    // 3. Stop-loss normal (Apenas se não caiu no blindado)
    if (stopLossValue !== null && lucroAtual < 0 && lucroAtual <= stopLossValue) {
      state.isStopped = true;
      const perdaAtual = Math.abs(lucroAtual); // Formato positivo para exibição
      const limitVal = Math.abs(stopLossValue);

      // ✅ Log padronizado para o Frontend
      this.saveAtlasLog(state.userId, symbol, 'alerta',
        `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${limitVal.toFixed(2)} - IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Stop loss atingido: -$${perdaAtual.toFixed(2)}`, state.userId],
      );
      this.atlasUsers.delete(state.userId);
      return;
    }
  }

  /**
   * ✅ ATLAS: Calcula stop-loss disponível
   */
  private calculateAvailableStopLoss(state: AtlasUserState): number {
    if (!state.stopLoss || state.stopLoss >= 0) {
      return Infinity;
    }
    const capitalDisponivel = state.capital;
    const stopLossDisponivel = capitalDisponivel - (state.capitalInicial + state.stopLoss);
    return Math.max(0, stopLossDisponivel);
  }

  /**
   * ✅ ATLAS: Cria ou atualiza estado do usuário
   */
  private upsertAtlasUserState(params: {
    userId: string;
    stakeAmount: number;
    apostaInicial?: number;
    derivToken: string;
    currency: string;
    mode: string;
    modoMartingale?: ModoMartingale;
    profitTarget?: number | null;
    lossLimit?: number | null;
    stopLossBlindado?: boolean | null;
    symbol: 'R_10' | 'R_25';
  }): { isNew: boolean; hasConfigChanges: boolean } {
    const existing = this.atlasUsers.get(params.userId);
    const stopLossNormalized = params.lossLimit != null ? -Math.abs(params.lossLimit) : null;
    let hasConfigChanges = false;

    if (existing) {
      hasConfigChanges =
        existing.capital !== params.stakeAmount ||
        existing.mode !== params.mode ||
        existing.modoMartingale !== (params.modoMartingale || 'conservador') ||
        existing.profitTarget !== (params.profitTarget || null) ||
        existing.stopLoss !== stopLossNormalized ||
        existing.stopLossBlindado !== Boolean(params.stopLossBlindado) ||
        existing.symbol !== params.symbol ||
        existing.apostaBase !== params.apostaInicial;

      Object.assign(existing, {
        capital: params.stakeAmount,
        capitalInicial: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        mode: params.mode,
        modoMartingale: params.modoMartingale || 'conservador',
        profitTarget: params.profitTarget || null,
        stopLoss: stopLossNormalized,
        stopLossBlindado: Boolean(params.stopLossBlindado),
        symbol: params.symbol,
        isStopped: false,
        totalProfitLoss: 0,
      });

      if (params.apostaInicial !== undefined) {
        existing.apostaInicial = params.apostaInicial;
        existing.apostaBase = params.apostaInicial;
        existing.ultimaApostaUsada = params.apostaInicial;
      }

      return { isNew: false, hasConfigChanges };
    }

    // Criar novo estado
    const apostaInicial = params.apostaInicial || 0.35;

    this.atlasUsers.set(params.userId, {
      userId: params.userId,
      derivToken: params.derivToken,
      currency: params.currency,
      capital: params.stakeAmount,
      capitalInicial: params.stakeAmount,
      maxBalance: params.stakeAmount,
      modoMartingale: params.modoMartingale || 'conservador',
      mode: params.mode,
      symbol: params.symbol,

      isOperationActive: false,
      pendingContractId: null,

      martingaleStep: 0,
      perdaAcumulada: 0,
      apostaInicial: apostaInicial,
      apostaBase: apostaInicial,
      ultimaApostaUsada: apostaInicial,
      vitoriasConsecutivas: 0,
      ultimoLucro: 0,
      isInRecovery: false,
      isInSoros: false,

      virtualLossCount: 0,
      virtualLossActive: false,

      lastOperationTimestamp: null,
      lastApiLatency: 0,

      stopLoss: stopLossNormalized || undefined,
      stopLossBlindado: Boolean(params.stopLossBlindado),
      blindadoActive: false,
      profitTarget: params.profitTarget || undefined,
      isStopped: false,
      totalProfitLoss: 0,

      creationCooldownUntil: undefined,

      digitBuffer: [], // ✅ ATLAS: Buffer de dígitos para análise ultrarrápida
    });

    return { isNew: true, hasConfigChanges: true };
  }

  /**
   * ✅ ATLAS: Extrai último dígito
   */
  private extractLastDigit(value: number): number {
    const numeric = Math.abs(value);
    const normalized = numeric.toString().replace('.', '').replace('-', '');
    const lastChar = normalized.charAt(normalized.length - 1);
    const digit = parseInt(lastChar, 10);
    return Number.isNaN(digit) ? 0 : digit;
  }

  /**
   * ✅ ATLAS: Salva trade no banco
   */
  private async saveAtlasTrade(trade: {
    userId: string;
    contractId: string | null;
    symbol: 'R_10' | 'R_25';
    contractType: string;
    entryPrice: number;
    stakeAmount: number;
    operation: 'OVER' | 'UNDER';
    mode: string;
  }): Promise<number | null> {
    try {
      const analysisData = {
        strategy: 'atlas',
        mode: trade.mode,
        symbol: trade.symbol,
        operation: trade.operation,
        timestamp: new Date().toISOString(),
      };

      let insertResult: any;
      try {
        insertResult = await this.dataSource.query(
          `INSERT INTO ai_trades 
           (user_id, gemini_signal, entry_price, stake_amount, status, 
            gemini_duration, contract_type, contract_id, created_at, analysis_data, symbol)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
          [
            trade.userId,
            trade.operation,
            trade.entryPrice,
            trade.stakeAmount,
            'PENDING',
            1,
            trade.contractType,
            trade.contractId,
            JSON.stringify(analysisData),
            trade.symbol,
          ]
        );
      } catch (error: any) {
        if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
          insertResult = await this.dataSource.query(
            `INSERT INTO ai_trades 
             (user_id, gemini_signal, entry_price, stake_amount, status, 
              gemini_duration, contract_type, contract_id, created_at, analysis_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [
              trade.userId,
              trade.operation,
              trade.entryPrice,
              trade.stakeAmount,
              'PENDING',
              1,
              trade.contractType,
              trade.contractId,
              JSON.stringify(analysisData),
            ]
          );
        } else {
          throw error;
        }
      }

      const result = Array.isArray(insertResult) ? insertResult[0] : insertResult;
      const tradeId = result?.insertId || null;

      if (tradeId) {
        this.tradeEvents.emit({
          userId: trade.userId,
          type: 'created',
          tradeId,
          status: 'PENDING',
          strategy: 'atlas',
          symbol: trade.symbol,
          contractType: trade.contractType,
        });
      }

      return tradeId;
    } catch (error) {
      this.logger.error(`[ATLAS][${trade.symbol}] Erro ao salvar trade:`, error);
      return null;
    }
  }

  /**
   * ✅ ATLAS: Atualiza trade no banco
   */
  private async updateAtlasTrade(
    tradeId: number | null,
    userId: string,
    update: {
      contractId?: string | null;
      status?: 'WON' | 'LOST' | 'PENDING';
      profitLoss?: number;
      exitPrice?: number;
    }
  ): Promise<void> {
    if (!tradeId) return;

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (update.contractId !== undefined) {
        updates.push('contract_id = ?');
        values.push(update.contractId);
      }
      if (update.status !== undefined) {
        updates.push('status = ?');
        values.push(update.status);
      }
      if (update.profitLoss !== undefined) {
        updates.push('profit_loss = ?');
        values.push(update.profitLoss);
      }
      if (update.exitPrice !== undefined) {
        updates.push('exit_price = ?');
        values.push(update.exitPrice);
      }

      if (update.status === 'WON' || update.status === 'LOST') {
        updates.push('closed_at = NOW()');
      }

      if (updates.length === 0) return;

      values.push(tradeId);
      await this.dataSource.query(
        `UPDATE ai_trades SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      if (update.status || update.profitLoss !== undefined) {
        this.tradeEvents.emit({
          userId,
          type: 'updated',
          tradeId,
          status: update.status,
          strategy: 'atlas',
          profitLoss: update.profitLoss,
          exitPrice: update.exitPrice,
        });
      }
    } catch (error) {
      this.logger.error(`[ATLAS] Erro ao atualizar trade (ID=${tradeId}):`, error);
    }
  }

  /**
   * ✅ ATLAS: Sistema de Logs Detalhados
   */
  private saveAtlasLog(
    userId: string,
    symbol: 'R_10' | 'R_25' | 'SISTEMA',
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro',
    message: string,
    details?: any,
  ): void {
    if (!userId || !type || !message || message.trim() === '') {
      return;
    }

    this.logQueue.push({ userId, symbol, type, message, details });
    this.processAtlasLogQueue().catch(error => {
      this.logger.error(`[ATLAS][SaveLog] Erro ao processar fila:`, error);
    });
  }

  /**
   * ✅ ATLAS: Processa fila de logs em batch
   */
  private async processAtlasLogQueue(): Promise<void> {
    if (this.logProcessing || this.logQueue.length === 0) {
      return;
    }

    this.logProcessing = true;

    try {
      const batch = this.logQueue.splice(0, 50);
      if (batch.length === 0) {
        this.logProcessing = false;
        return;
      }

      const logsByUser = new Map<string, typeof batch>();
      for (const log of batch) {
        if (!logsByUser.has(log.userId)) {
          logsByUser.set(log.userId, []);
        }
        logsByUser.get(log.userId)!.push(log);
      }

      await Promise.all(
        Array.from(logsByUser.entries()).map(([userId, logs]) =>
          this.saveAtlasLogsBatch(userId, logs)
        )
      );

      if (this.logQueue.length > 0) {
        setImmediate(() => this.processAtlasLogQueue());
      }
    } catch (error) {
      this.logger.error(`[ATLAS][ProcessLogQueue] Erro:`, error);
    } finally {
      this.logProcessing = false;
    }
  }

  /**
   * ✅ ATLAS: Salva múltiplos logs em batch
   */
  private async saveAtlasLogsBatch(
    userId: string,
    logs: Array<{
      symbol: 'R_10' | 'R_25' | 'SISTEMA';
      type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
      message: string;
      details?: any;
    }>,
  ): Promise<void> {
    if (logs.length === 0) return;

    try {
      const icons = {
        info: 'ℹ️',
        tick: '📊',
        analise: '🔍',
        sinal: '⚡',
        operacao: '💰',
        resultado: '✅',
        alerta: '⚠️',
        erro: '🚫',
      };

      const values = logs.map(log => {
        const icon = icons[log.type] || 'ℹ️';
        const messageWithSymbol = log.symbol === 'SISTEMA'
          ? log.message
          : `[${log.symbol}] ${log.message}`;

        return [
          userId,
          log.type,
          icon,
          messageWithSymbol.substring(0, 5000),
          log.details ? JSON.stringify({
            symbol: log.symbol,
            ...(log.details || {}),
          }).substring(0, 10000) : JSON.stringify({ symbol: log.symbol }).substring(0, 10000),
          userId,
        ];
      });

      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, NOW(3))').join(', ');
      const flatValues = values.flat();

      await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, type, icon, message, details, session_id, timestamp)
         VALUES ${placeholders}`,
        flatValues,
      );

      this.tradeEvents.emit({
        userId,
        type: 'updated',
        strategy: 'atlas',
        status: 'LOG',
      });
    } catch (error) {
      this.logger.error(`[ATLAS][SaveLogsBatch][${userId}] Erro:`, error);
    }
  }

  /**
   * ✅ ATLAS: Obtém ou cria conexão WebSocket reutilizável
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string, symbol?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    const existing = this.wsConnections.get(token);
    if (existing && existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
      return {
        ws: existing.ws,
        sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
        subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
          this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
        removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
      };
    }

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.logger.log(`[ATLAS][${symbol || 'POOL'}] 🔌 Abrindo WebSocket reutilizável`);

    const socket = new WebSocket(endpoint, {
      headers: { Origin: 'https://app.deriv.com' },
    });

    let authResolved = false;
    let connectionTimeout: NodeJS.Timeout | null = null;
    let authPromiseResolve: (() => void) | null = null;
    let authPromiseReject: ((error: Error) => void) | null = null;

    const connInit = {
      ws: socket,
      authorized: false,
      keepAliveInterval: null as NodeJS.Timeout | null,
      requestIdCounter: 0,
      pendingRequests: new Map(),
      subscriptions: new Map(),
      lastLatency: 0,
    };
    this.wsConnections.set(token, connInit);

    // ✅ Promise para aguardar autorização
    const authPromise = new Promise<void>((resolve, reject) => {
      authPromiseResolve = resolve;
      authPromiseReject = reject;
    });

    connectionTimeout = setTimeout(() => {
      if (!authResolved) {
        authResolved = true;
        socket.close();
        this.wsConnections.delete(token);
        if (authPromiseReject) {
          authPromiseReject(new Error('Timeout ao aguardar autorização'));
        }
      }
    }, 30000);

    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const conn = this.wsConnections.get(token);
        if (!conn) return;

        if (msg.msg_type === 'authorize' && !authResolved) {
          authResolved = true;
          if (connectionTimeout) clearTimeout(connectionTimeout);

          if (msg.error || (msg.authorize && msg.authorize.error)) {
            const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido';
            this.logger.error(`[ATLAS][${symbol || 'POOL'}] ❌ Erro na autorização: ${errorMsg}`);
            socket.close();
            this.wsConnections.delete(token);
            if (authPromiseReject) {
              authPromiseReject(new Error(errorMsg));
            }
            return;
          }

          conn.authorized = true;
          this.logger.log(`[ATLAS][${symbol || 'POOL'}] ✅ Autorizado`);

          conn.keepAliveInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              try {
                socket.send(JSON.stringify({ ping: 1 }));
              } catch {
                // ignorar
              }
            }
          }, 90000);

          // ✅ Resolver promise de autorização
          if (authPromiseResolve) {
            authPromiseResolve();
          }
          return;
        }

        if (msg.proposal_open_contract) {
          const contractId = msg.proposal_open_contract.contract_id;
          if (contractId && conn.subscriptions.has(contractId)) {
            const callback = conn.subscriptions.get(contractId)!;
            callback(msg);
            return;
          }
        }

        if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
          const firstKey = conn.pendingRequests.keys().next().value;
          if (firstKey) {
            const pending = conn.pendingRequests.get(firstKey);
            if (pending) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(firstKey);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                pending.resolve(msg);
              }
            }
          }
          return;
        }
      } catch {
        // Ignorar erros de parse
      }
    });

    socket.on('open', () => {
      const conn = this.wsConnections.get(token)!;
      socket.send(JSON.stringify({ authorize: token }));
    });

    socket.on('error', (error) => {
      if (!authResolved) {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        authResolved = true;
        this.wsConnections.delete(token);
        if (authPromiseReject) {
          authPromiseReject(new Error(`Erro no WebSocket: ${error.message || 'Erro desconhecido'}`));
        }
      }
    });

    socket.on('close', () => {
      const conn = this.wsConnections.get(token);
      if (conn) {
        if (conn.keepAliveInterval) clearInterval(conn.keepAliveInterval);
        conn.pendingRequests.forEach((pending) => {
          clearTimeout(pending.timeout);
          pending.reject(new Error('WebSocket fechado'));
        });
        conn.subscriptions.clear();
      }
      this.wsConnections.delete(token);
      if (!authResolved) {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        authResolved = true;
        if (authPromiseReject) {
          authPromiseReject(new Error('WebSocket fechado antes da autorização'));
        }
      }
    });

    // ✅ Aguardar autorização antes de retornar
    try {
      await authPromise;
    } catch (error) {
      throw new Error(`Falha ao autorizar conexão WebSocket: ${error.message}`);
    }

    const conn = this.wsConnections.get(token)!;
    return {
      ws: conn.ws,
      sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
      subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
      removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
    };
  }

  /**
   * ✅ ATLAS: Envia requisição via conexão
   */
  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    return new Promise((resolve, reject) => {
      const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });
      conn.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * ✅ ATLAS: Inscreve-se para atualizações
   */
  private async subscribeViaConnection(
    token: string,
    payload: any,
    callback: (msg: any) => void,
    subId: string,
    timeoutMs: number,
  ): Promise<void> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    const timeout = setTimeout(() => {
      conn.subscriptions.delete(subId);
    }, timeoutMs);

    conn.subscriptions.set(subId, (msg: any) => {
      clearTimeout(timeout);
      callback(msg);
    });

    conn.ws.send(JSON.stringify(payload));
  }

  /**
   * ✅ ATLAS: Remove subscription
   */
  private removeSubscriptionFromConnection(token: string, subId: string): void {
    const conn = this.wsConnections.get(token);
    if (conn) {
      conn.subscriptions.delete(subId);
    }
  }

  // Getters
  getTicks(symbol: 'R_10' | 'R_25'): Tick[] {
    return this.atlasTicks[symbol];
  }

  getUsers(): Map<string, AtlasUserState> {
    return this.atlasUsers;
  }

  getActiveUsers(): AtlasUserState[] {
    return Array.from(this.atlasUsers.values()).filter((u) => !u.isStopped);
  }
}
