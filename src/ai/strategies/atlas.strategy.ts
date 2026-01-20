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
      // Recupera 100% da perda (Zero a Zero)
      aposta = perdasTotais / payout;
      break;
    case 'moderado':
      // Recupera 100% da perda + 15% de lucro
      aposta = (perdasTotais * 1.15) / payout;
      break;
    case 'agressivo':
      // Recupera 100% da perda + 30% de lucro
      aposta = (perdasTotais * 1.30) / payout;
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
  originalMode: string; // ✅ ATLAS: Modo original configurado pelo usuário
  symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V';

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
    R_100: Tick[];
    '1HZ100V': Tick[];
  } = {
      R_10: [],
      R_25: [],
      R_100: [],
      '1HZ100V': [],
    };

  private appId: string;
  private maxTicks = 50; // ✅ ATLAS: Buffer menor para análise ultrarrápida

  // ✅ Sistema de logs (similar à Trinity)
  private logQueue: Array<{
    userId: string;
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V' | 'SISTEMA';
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'vitoria' | 'derrota' | 'alerta' | 'erro';
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
    this.logger.log('[ATLAS] ✅ Aguardando ticks do AIService (R_10, R_25, R_100, 1HZ100V)...');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    if (!symbol || !['R_10', 'R_25', 'R_100', '1HZ100V'].includes(symbol)) {
      // ✅ DIAGNÓSTICO: Log quando recebe símbolo inválido
      if (symbol) {
        this.logger.debug(`[ATLAS] ⚠️ Tick recebido com símbolo inválido: ${symbol} (esperado R_10, R_25, R_100 ou 1HZ100V)`);
      }
      return;
    }

    const assetSymbol = symbol as 'R_10' | 'R_25' | 'R_100' | '1HZ100V';
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
        this.saveAtlasLog(state.userId, assetSymbol, 'info',
          `💓 IA ATLAS OPERA\n` +
          `• Mercado: ${assetSymbol}\n` +
          `• Status: Analisando padrões...`);
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

    let atlasSymbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V' = '1HZ100V';

    if (symbol && ['R_10', 'R_25', 'R_100', '1HZ100V'].includes(symbol)) {
      atlasSymbol = symbol as 'R_10' | 'R_25' | 'R_100' | '1HZ100V';
    } else if (selectedMarket) {
      const marketLower = selectedMarket.toLowerCase();

      // ✅ Mapear preferência "Vol 10" e "Vol 100" para "1HZ100V" (1s)
      if (marketLower === 'r_10' || marketLower === 'vol10' || marketLower === 'volatility 10 index') {
        atlasSymbol = '1HZ100V';
      } else if (marketLower.includes('1hz100v') || marketLower.includes('1hz10v') || marketLower.includes('1s')) {
        atlasSymbol = '1HZ100V';
      } else if (marketLower === 'r_100' || marketLower === 'vol100' || marketLower === 'volatility 100 index') {
        atlasSymbol = '1HZ100V'; // ✅ Atlas v3.0 prefere 1s (1HZ100V)
      } else if (marketLower === 'r_25' || marketLower === 'vol25' || marketLower === 'volatility 25 index') {
        atlasSymbol = 'R_25';
      } else {
        // Fallback robusto
        if (marketLower.includes('vol10') || marketLower.includes('r_10') || marketLower.includes('100')) {
          atlasSymbol = '1HZ100V'; // ✅ Preferência para 1HZ100V
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

      const state = this.atlasUsers.get(userId);
      const saldoAtual = state ? state.capital : stakeAmountNum;

      // ✅ LOG PADRONIZADO V2: Configuração Inicial
      this.logInitialConfigV2(userId, {
        strategyName: 'ATLAS 3.0',
        operationMode: mode || 'veloz',
        riskProfile: modoMartingale || 'conservador',
        profitTarget: profitTargetNum || 0,
        stopLoss: lossLimitNum ? Math.abs(lossLimitNum) : 0,
        stopBlindadoEnabled: Boolean(stopLossBlindado),
      });

      // ✅ LOG PADRONIZADO V2: Início de Sessão
      this.logSessionStart(userId, {
        date: new Date(),
        initialBalance: saldoAtual,
        profitTarget: profitTargetNum || 0,
        stopLoss: lossLimitNum ? Math.abs(lossLimitNum) : 0,
        mode: mode || 'veloz',
        strategyName: 'ATLAS 3.0',
      });

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
        // ✅ LOG PADRONIZADO V2: Coleta de Dados
        this.logDataCollection(state.userId, {
          targetCount: modeConfig.amostraInicial,
          currentCount: state.digitBuffer.length,
          mode: state.mode.toUpperCase(),
        });
        set.add(logKey);
        this.coletaLogsEnviados.set(keyUser, set);
        // Resetar após logar para permitir novo log quando necessário
        if (state.digitBuffer.length % 5 === 0) {
          set.delete(logKey);
        }
      }
      return;
    }

    // ✅ [ZENIX v3.0] Lógica de Recuperação: M1 em Digits, M2+ em Price Action
    if (state.isInRecovery) {
      if (state.martingaleStep >= 2) {
        // Tentar obter sinal de Price Action para recuperação (M2+)
        const recoverySignal = this.getRecoverySignal(state, symbol);

        if (recoverySignal) {
          // Se encontrou sinal de recuperação, entra com a stake de recuperação
          const signalOp = recoverySignal === 'CALL' ? 'CALL' : 'PUT';
          const typeLabel = recoverySignal === 'CALL' ? 'Rise' : 'Fall';
          await this.executeAtlasOperation(state, symbol, signalOp, `🔄 Recuperação ${state.mode.toUpperCase()} (M${state.martingaleStep}): ${recoverySignal} (${typeLabel})`);
        } else {
          // Se não encontrou sinal, aguarda e loga (mas com moderação)
          const key = `${symbol}_${state.userId}_waiting_recovery`;
          if (!this.intervaloLogsEnviados.has(key) || (state.tickCounter || 0) % 10 === 0) {
            this.intervaloLogsEnviados.set(key, true);
          }
        }
        return;
      } else {
        // M1 ainda opera em Digits (Digit Over 2)
        const { canTrade, analysis } = this.checkAtlasTriggers(state, modeConfig);
        if (canTrade) {
          await this.executeAtlasOperation(state, symbol, 'OVER', analysis);
        }
        return;
      }
    }

    // ✅ ATLAS: Se for SOROS, usa a lógica de entrada normal (Gatilhos)
    // Mas se quiser usar a mesma lógica de recuperação para Soros, altere aqui.
    // Por padrão, Soros segue a lógica de entrada da estratégia (Digit Over).


    // ✅ ATLAS: Verificar gatilho e análise ultrarrápida
    const { canTrade, analysis } = this.checkAtlasTriggers(state, modeConfig);
    if (canTrade) {
      await this.executeAtlasOperation(state, symbol, 'OVER', analysis);
    } else {
      // ✅ Log periódico quando análise bloqueia operação (a cada 10 ticks para mostrar atividade real)
      const key = `${symbol}_${state.userId}_bloqueio`;
      if (!this.intervaloLogsEnviados.has(key) || (state.tickCounter || 0) % 10 === 0) {
        this.saveAtlasLog(state.userId, symbol, 'analise', analysis);
        this.intervaloLogsEnviados.set(key, true);
        // Resetar após 10 ticks
        if ((state.tickCounter || 0) % 10 === 0) {
          this.intervaloLogsEnviados.delete(key);
        }
      }
    }
  }

  /**
   * ✅ ATLAS: Verifica gatilhos ultrarrápidos (Conforme Documentação)
   */
  private checkAtlasTriggers(state: AtlasUserState, modeConfig: ModeConfig): { canTrade: boolean; analysis: string } {
    const modeLower = (state.mode || 'veloz').toLowerCase();
    const normalizedMode = modeLower === 'moderado' ? 'normal' :
      (modeLower === 'lenta' || modeLower === 'preciso' ? 'lento' : modeLower);

    // Mapeamento de loss virtual por modo
    const requiredLosses = { veloz: 0, normal: 1, lento: 2 };
    const requiredLossCount = requiredLosses[normalizedMode as keyof typeof requiredLosses] || 0;

    let analysis = `🔍 [ANÁLISE ATLAS ${normalizedMode.toUpperCase()}]\n`;
    analysis += ` • Gatilho Virtual: ${state.virtualLossCount}/${requiredLossCount} ${state.virtualLossCount >= requiredLossCount ? '✅' : '❌'}\n`;

    // Lógica de Bypass de Virtual Loss (Primeira operação ou Win recente)
    const isFirstOperation = state.lastOperationTimestamp === null;
    const hasRecentWin = state.virtualLossCount === 0 && state.lastOperationTimestamp !== null;
    const timeSinceLastOp = state.lastOperationTimestamp
      ? (Date.now() - state.lastOperationTimestamp.getTime()) / 1000
      : 0;
    const intervalPassed = !modeConfig.intervaloSegundos || timeSinceLastOp >= modeConfig.intervaloSegundos;
    const canBypassVirtualLoss = isFirstOperation || (hasRecentWin && intervalPassed);

    if (!canBypassVirtualLoss && state.virtualLossCount < requiredLossCount) {
      if (hasRecentWin && !intervalPassed) {
        analysis += ` • Aguardando intervalo: ${timeSinceLastOp.toFixed(1)}s / ${modeConfig.intervaloSegundos}s ⏱️\n`;
      }
      return { canTrade: false, analysis };
    }

    const lastDigit = state.digitBuffer[state.digitBuffer.length - 1];

    analysis += `\n🧠 ANÁLISE INICIADA...\n`;
    analysis += `• Verificando condições para o modo: ${normalizedMode.toUpperCase()}\n`;

    // ✅ 1. MODO VELOZ: Último dígito > 2
    if (normalizedMode === 'veloz') {
      if (lastDigit > 2) {
        analysis += `✅ FILTRO: Último Dígito (${lastDigit}) > 2\n`;
        analysis += `✅ GATILHO: Padrão de Fluxo Confirmado\n`;
        analysis += `💪 FORÇA DO SINAL: 70%\n`;
        analysis += `📊 ENTRADA: DIGITOVER 2`;
        return { canTrade: true, analysis };
      } else {
        analysis += `❌ FILTRO: Último Dígito (${lastDigit}) <= 2\n`;
        analysis += `⏳ AGUARDANDO: Tendência de Alta Frequência...`;
        return { canTrade: false, analysis };
      }
    }

    // ✅ 2. MODO NORMAL: 3 dígitos consecutivos <= 2 (Lógica de Exaustão V3.0)
    if (normalizedMode === 'normal') {
      const window = state.digitBuffer.slice(-3);
      const allUnderOrEqual2 = window.length === 3 && window.every(d => d <= 2);

      if (allUnderOrEqual2) {
        analysis += `✅ GATILHO: 3 dígitos consecutively <= 2 (Exaustão)\n`;
        analysis += `✅ PADRÃO: Reversão Esperada Confirmada\n`;
        analysis += `💪 FORÇA DO SINAL: 72%\n`;
        analysis += `📊 ENTRADA: DIGITOVER 2`;
        return { canTrade: true, analysis };
      } else {
        const countUnder = window.filter(d => d <= 2).length;
        analysis += `❌ FILTRO: Aguardando Sequência (${countUnder}/3 <= 2)\n`;
        analysis += `⏳ STATUS: Monitorando Exaustão...`;
        return { canTrade: false, analysis };
      }
    }

    // ✅ 3. MODO LENTO: 5 dígitos consecutivos <= 2 (Lógica de Exaustão V3.0)
    if (normalizedMode === 'lento') {
      const window = state.digitBuffer.slice(-5);
      const allUnderOrEqual2 = window.length === 5 && window.every(d => d <= 2);

      if (allUnderOrEqual2) {
        analysis += `✅ GATILHO: 5 dígitos consecutively <= 2 (Exaustão Extrema)\n`;
        analysis += `✅ PADRÃO: Reversão Sniper Confirmada\n`;
        analysis += `💪 FORÇA DO SINAL: 85%\n`;
        analysis += `📊 ENTRADA: DIGITOVER 2`;
        return { canTrade: true, analysis };
      } else {
        const countUnder = window.filter(d => d <= 2).length;
        analysis += `❌ FILTRO: Aguardando Sequência (${countUnder}/5 <= 2)\n`;
        analysis += `⏳ STATUS: Monitorando Estabilidade...`;
        return { canTrade: false, analysis };
      }
    }

    return { canTrade: false, analysis };
  }

  /**
   * ✅ ATLAS: Sinal de Recuperação (Price Action)
   */
  /**
   * ✅ ATLAS: Sinal de Recuperação (Price Action) - Filtros Específicos por Modo
   */
  private getRecoverySignal(state: AtlasUserState, symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V'): 'CALL' | 'PUT' | null {
    const ticks = this.atlasTicks[symbol];
    if (ticks.length < 3) return null;

    const modeLower = (state.mode || 'veloz').toLowerCase();
    const normalizedMode = modeLower === 'moderado' ? 'normal' :
      (modeLower === 'lenta' || modeLower === 'preciso' ? 'lento' : modeLower);

    const t0 = ticks[ticks.length - 1]; // Atual
    const t1 = ticks[ticks.length - 2]; // Anterior
    const t2 = ticks[ticks.length - 3]; // Penúltimo

    const move1 = t0.value - t1.value;
    const move2 = t1.value - t2.value;

    const isConsecutiveUp = move1 > 0 && move2 > 0;
    const isConsecutiveDown = move1 < 0 && move2 < 0;

    if (!isConsecutiveUp && !isConsecutiveDown) return null;

    const direction = isConsecutiveUp ? 'CALL' : 'PUT';
    const absDiff = Math.abs(move1); // Delta do último movimento (conforme padrão)


    // ✅ [ZENIX v3.3] Filtro Progressivo Simplificado
    // VELOZ: Sem delta | NORMAL: 0.5 | LENTO: 0.7
    const threshold = normalizedMode === 'veloz' ? 0.0 : (normalizedMode === 'normal' ? 0.5 : 0.7);

    if (absDiff >= threshold) {
      return direction;
    } else {
      // ✅ Log de rejeição por delta insuficiente (apenas em recuperação)
      const key = `${symbol}_${state.userId}_recovery_rejection`;
      if (!this.intervaloLogsEnviados.has(key) || (state.tickCounter || 0) % 5 === 0) {
        this.saveAtlasLog(state.userId, symbol, 'analise',
          `🛡️ [RECUPERAÇÃO ${normalizedMode.toUpperCase()}] Aguardando força.\n` +
          `• Movimento: ${absDiff.toFixed(2)}\n` +
          `• Mínimo Exigido: ${threshold.toFixed(2)}\n` +
          `• Status: Delta Insuficiente ⏳`);
        this.intervaloLogsEnviados.set(key, true);
        if ((state.tickCounter || 0) % 5 === 0) {
          this.intervaloLogsEnviados.delete(key);
        }
      }
      return null;
    }
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
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V',
    operation: 'OVER' | 'UNDER' | 'CALL' | 'PUT' | 'EVEN' | 'ODD',
    analysis?: string,
  ): Promise<void> {
    // ✅ [ZENIX v3.0] Bloqueio imediato para evitar race condition de múltiplos disparos por tick
    if (state.isOperationActive) {
      return;
    }
    state.isOperationActive = true;

    // ✅ LOG PADRONIZADO V2: Sinal Gerado
    // Tenta extrair informações da string de análise ou usa padrão
    const probMatch = analysis ? analysis.match(/FORÇA DO SINAL: (\d+)%/) : null;
    const probability = probMatch ? parseInt(probMatch[1]) : 75;

    this.logSignalGenerated(state.userId, {
      mode: state.mode.toUpperCase(),
      isRecovery: state.isInRecovery,
      filters: ['Análise de Fluxo', 'Padrão Numérico'],
      trigger: 'Padrão Confirmado',
      probability: probability,
      contractType: operation === 'OVER' ? 'DIGIT OVER' : (operation === 'UNDER' ? 'DIGIT UNDER' : operation),
      direction: operation === 'CALL' ? 'CALL' : (operation === 'PUT' ? 'PUT' : undefined)
    });

    try {
      // ✅ [ORION PARALLEL CHECK] - Buscar limites frescos do banco antes de qualquer aposta
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

      if (!stopLossConfig || stopLossConfig.length === 0) {
        state.isOperationActive = false;
        return;
      }

      const config = stopLossConfig[0];
      const lossLimit = parseFloat(config.lossLimit) || 0;
      const profitTarget = parseFloat(config.profitTarget) || 0;
      const capitalInicial = parseFloat(config.capitalInicial) || 0;
      const profitPeak = parseFloat(config.profitPeak) || 0;
      const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;

      const lucroAtual = parseFloat(config.sessionBalance) || 0;
      const capitalSessao = capitalInicial + lucroAtual;

      // Sincronizar estado em memória com banco (para exibição correta)
      state.capital = capitalSessao;
      state.capitalInicial = capitalInicial;
      state.totalProfitLoss = lucroAtual;

      // Meta de Lucro
      if (profitTarget > 0 && lucroAtual >= profitTarget) {
        this.saveAtlasLog(state.userId, symbol, 'info',
          `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`
        );

        await this.dataSource.query(
          `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
           WHERE user_id = ? AND is_active = 1`,
          [`Meta atingida: +$${lucroAtual.toFixed(2)}`, state.userId],
        );

        this.tradeEvents.emit({
          userId: state.userId,
          type: 'stopped_profit',
          strategy: 'atlas',
          symbol: symbol,
          profitLoss: lucroAtual
        });

        this.atlasUsers.delete(state.userId);
        state.isStopped = true;
        return;
      }

      // Stop Blindado
      if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
        let currentPeak = profitPeak;
        const activationThreshold = profitTarget * 0.40;

        if (lucroAtual > currentPeak) {
          currentPeak = lucroAtual;
          await this.dataSource.query(`UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`, [currentPeak, state.userId]);

          if (currentPeak >= activationThreshold) {
            const protectedAmount = currentPeak * (stopBlindadoPercent / 100);
            this.saveAtlasLog(state.userId, symbol, 'info',
              `ℹ️🛡️Stop Blindado: Ativado | Lucro atual $${currentPeak.toFixed(2)} | Protegendo ${stopBlindadoPercent}%: $${protectedAmount.toFixed(2)}`
            );
          }
        }

        if (profitTarget > 0 && currentPeak >= activationThreshold) {
          const factor = stopBlindadoPercent / 100;
          const stopBlindado = capitalInicial + (currentPeak * factor);

          if (capitalSessao <= stopBlindado) {
            const lucroFinal = capitalSessao - capitalInicial;
            this.saveAtlasLog(state.userId, symbol, 'alerta',
              `💰✅Stoploss blindado atingido, o sistema parou as operações com um lucro de $${lucroFinal.toFixed(2)} para proteger o seu capital.`
            );

            await this.dataSource.query(
              `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
               WHERE user_id = ? AND is_active = 1`,
              [`Stop Blindado atingido com lucro de $${lucroFinal.toFixed(2)}`, state.userId],
            );

            this.tradeEvents.emit({
              userId: state.userId,
              type: 'stopped_blindado',
              strategy: 'atlas',
              symbol: symbol,
              profitProtected: lucroFinal,
              profitLoss: lucroFinal
            });

            this.atlasUsers.delete(state.userId);
            state.isStopped = true;
            return;
          }
        }
      }

      // Stop Loss Normal
      const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
      if (lossLimit > 0 && perdaAtual >= lossLimit) {
        this.saveAtlasLog(state.userId, symbol, 'alerta',
          `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`
        );

        await this.dataSource.query(
          `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
           WHERE user_id = ? AND is_active = 1`,
          [`Stop Loss atingido: -$${perdaAtual.toFixed(2)}`, state.userId],
        );

        this.tradeEvents.emit({
          userId: state.userId,
          type: 'stopped_loss',
          strategy: 'atlas',
          symbol: symbol,
          profitLoss: -perdaAtual
        });

        this.atlasUsers.delete(state.userId);
        state.isStopped = true;
        return;
      }

      const modeConfig = this.getModeConfig(state.mode);
      if (!modeConfig) {
        state.isOperationActive = false;
        return;
      }

      let stakeAmount = state.apostaInicial;

      // Martingale ou Soros
      if (state.isInRecovery && state.martingaleStep > 0) {
        // ✅ [ZENIX v3.2] Payout dinâmico para Martingale: 0.95 para Price Action (CALL/PUT), ou modeConfig.payout (~0.40)
        // [V3.0] Rise/Fall apenas no M2+
        const isPriceAction = (operation === 'CALL' || operation === 'PUT') && state.martingaleStep >= 2;
        const payout = isPriceAction ? 0.95 : 0.40; // 0.40 para Digit Over 2 (M0, M1)

        const perdas = state.perdaAcumulada;
        stakeAmount = calcularProximaApostaAtlas(perdas, state.modoMartingale, payout);

        // ✅ LOG PADRONIZADO V2: Martingale
        this.logMartingaleLevelV2(state.userId, {
          level: state.martingaleStep,
          lossNumber: state.martingaleStep,
          accumulatedLoss: perdas,
          calculatedStake: stakeAmount,
          profitPercentage: state.modoMartingale === 'moderado' ? 15 : (state.modoMartingale === 'agressivo' ? 30 : 0),
          contractType: operation
        });

        // ✅ Todos os modos agora recuperam infinitamente (sem limite de M5)
        // Veloz: +5% | Moderado: +15% | Agressivo: +15%


        const stopLossDisponivel = this.calculateAvailableStopLoss(state);

        if (stopLossDisponivel > 0 && stakeAmount > stopLossDisponivel) {
          this.saveAtlasLog(state.userId, symbol, 'alerta',
            `🛡️ [MODO SOBREVIVÊNCIA]\n` +
            `• Motivo: Stake do Martingale ($${stakeAmount.toFixed(2)}) excede Stop Loss.\n` +
            `• Ação: Ajustando para stake disponível ($${stopLossDisponivel.toFixed(2)}).`);

          stakeAmount = stopLossDisponivel;
        }
      } else if (state.isInSoros && state.vitoriasConsecutivas === 1) {
        stakeAmount = state.apostaBase + state.ultimoLucro;
        // ✅ LOG PADRONIZADO V2: Soros
        this.logSorosActivation(state.userId, {
          previousProfit: state.ultimoLucro,
          stakeBase: state.apostaBase,
          level: 1
        });
      }

      stakeAmount = Math.max(0.35, Number(stakeAmount.toFixed(2)));

      // GESTÃO DE RISCO - Clamping
      let minAllowedBalance = 0.0;
      let limitType = '';
      const activationThreshold = profitTarget * 0.40;

      if (profitTarget > 0 && profitPeak >= activationThreshold) {
        const factor = stopBlindadoPercent / 100;
        const guaranteedProfit = profitPeak * factor;
        minAllowedBalance = capitalInicial + guaranteedProfit;
        limitType = 'STOP BLINDADO (LUCRO GARANTIDO)';
      } else {
        if (lossLimit > 0) {
          minAllowedBalance = capitalInicial - lossLimit;
          limitType = 'STOP LOSS NORMAL';
        } else {
          minAllowedBalance = -Infinity;
        }
      }

      const potentialBalanceAfterLoss = capitalSessao - stakeAmount;

      if (minAllowedBalance !== -Infinity && potentialBalanceAfterLoss < minAllowedBalance) {
        let adjustedStake = state.capital - minAllowedBalance;
        adjustedStake = Math.round(adjustedStake * 100) / 100;

        if (adjustedStake < 0.35) {
          this.saveAtlasLog(state.userId, symbol, 'alerta',
            `🛡️ [MODO SOBREVIVÊNCIA]\n` +
            `• Motivo: Sem margem de risco para Martingale.\n` +
            `• Ação: Resetando para Stake Base ($${state.apostaBase.toFixed(2)}) para continuar operando.`);

          state.martingaleStep = 0;
          state.perdaAcumulada = 0;
          state.isInRecovery = false;
          stakeAmount = state.apostaBase;
        } else {
          if (adjustedStake !== stakeAmount) {
            this.saveAtlasLog(state.userId, symbol, 'alerta',
              `⚠️ [PRECISÃO] Stake ajustada de $${stakeAmount.toFixed(2)} para $${adjustedStake.toFixed(2)} para respeitar ${limitType}`);
            stakeAmount = adjustedStake;
          }
        }
      }

      state.isOperationActive = true;
      state.lastOperationTimestamp = new Date();
      state.ultimaApostaUsada = stakeAmount;

      if (analysis) {
        this.saveAtlasLog(state.userId, symbol, 'analise', analysis);
      }

      let contractType = '';
      if (operation === 'OVER') contractType = 'DIGITOVER';
      else if (operation === 'UNDER') contractType = 'DIGITUNDER';
      else if (operation === 'CALL') contractType = 'CALL';
      else if (operation === 'PUT') contractType = 'PUT';

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
        this.logger.error(`[ATLAS][${symbol}] Erro ao executar operação (Interno):`, error);
        state.isOperationActive = false;
        state.creationCooldownUntil = Date.now() + 2000;
      }
    } catch (error) {
      this.logger.error(`[ATLAS][${symbol}] Erro crítico em executeAtlasOperation:`, error);
      state.isOperationActive = false;
    }
  }

  /**
   * ✅ ATLAS: Executa trade via WebSocket e monitora resultado
   */
  private async executeAtlasTradeDirect(
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V',
    token: string,
    contractParams: any,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    try {
      const connection = await this.getOrCreateWebSocketConnection(token, userId, symbol);

      const proposalStartTime = Date.now();
      // ✅ ATLAS: Para DIGITOVER/DIGITUNDER, é necessário o parâmetro barrier (dígito de comparação)
      // ATLAS opera com OVER/UNDER baseado em dígito > 2, então barrier = 2
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
        proposalPayload.barrier = 2; // Dígito de comparação: > 2 (OVER) ou ≤ 2 (UNDER)
      }
      // ✅ Contratos CALL/PUT (Rise/Fall) não usam barrier na Deriv padrão (apenas duration)
      // Se fosse barrier trading, precisaria. Mas Rise/Fall padrão não precisa.


      const proposalResponse: any = await connection.sendRequest(proposalPayload, 60000);

      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        const errorCode = errorObj?.code || '';
        const errorMessage = errorObj?.message || JSON.stringify(errorObj);
        this.logger.error(`[ATLAS][${symbol}] ❌ Erro na proposta: ${errorMessage} | Código: ${errorCode} | Tipo: ${contractParams.contract_type}`);
        this.saveAtlasLog(userId, symbol, 'erro',
          `❌ ERRO NA PROPOSTA\n` +
          `• Código: ${errorCode}\n` +
          `• Mensagem: ${errorMessage}`);
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
        this.saveAtlasLog(userId, symbol, 'erro',
          `❌ ERRO AO COMPRAR\n` +
          `• Mensagem: ${error.message}`);
        return null;
      }

      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        const errorCode = buyErrorObj?.code || '';
        const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);
        this.logger.error(`[ATLAS][${symbol}] ❌ Erro ao comprar contrato: ${errorMessage} | Código: ${errorCode} | ProposalId: ${proposalId}`);
        this.saveAtlasLog(userId, symbol, 'erro',
          `❌ ERRO AO COMPRAR\n` +
          `• Código: ${errorCode}\n` +
          `• Mensagem: ${errorMessage}`);
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[ATLAS][${symbol}] ❌ Contrato criado mas sem contract_id`);
        return null;
      }

      const buyDuration = Date.now() - buyStartTime;
      this.logger.log(`[ATLAS][${symbol}] ✅ Contrato criado | Proposal: ${proposalDuration}ms | Compra: ${buyDuration}ms | ContractId: ${contractId}`);
      this.saveAtlasLog(userId, symbol, 'operacao',
        `✅ CONTRATO CRIADO\n` +
        `• ID: ${contractId}\n` +
        `• Latência Proposta: ${proposalDuration}ms\n` +
        `• Latência Compra: ${buyDuration}ms`);

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
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V',
    isWin: boolean,
    stakeAmount: number,
    operation: 'OVER' | 'UNDER' | 'CALL' | 'PUT' | 'EVEN' | 'ODD',
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

    // Se foi operação de Price Action (CALL/PUT), o payout é diferente (~0.95)
    // Se foi OVER/UNDER, é (~0.63)
    const isPriceAction = operation === 'CALL' || operation === 'PUT';
    const currentPayout = isPriceAction ? 0.95 : modeConfig.payout;


    if (isWin) {
      // ✅ VITÓRIA
      const lucro = profit > 0 ? profit : (stakeAmount * currentPayout - stakeAmount);
      state.capital += lucro;
      state.totalProfitLoss += lucro;

      // ✅ Recuperação: resetar
      if (state.isInRecovery) {
        const nivelAntes = state.martingaleStep;
        const perdaRecuperada = state.perdaAcumulada;

        // ✅ Calcular ganho bruto para exibição
        // ✅ Calcular ganho bruto para exibição
        const ganhoBrutoRecuperacao = lucro + stakeAmount;

        // ✅ LOG PADRONIZADO V2: Recuperação Bem-Sucedida
        this.logSuccessfulRecoveryV2(state.userId, {
          recoveredLoss: perdaRecuperada,
          additionalProfit: lucro,
          profitPercentage: (lucro / perdaRecuperada) * 100,
          stakeBase: state.apostaBase
        });

        state.martingaleStep = 0;
        state.perdaAcumulada = 0;
        state.isInRecovery = false;
        state.apostaInicial = state.apostaBase;
        state.virtualLossCount = 0; // ✅ ATLAS: Resetar loss virtual na recuperação

        // ✅ ATLAS: Auto-Revert -> Voltar ao modo original após recuperar
        if (state.mode !== state.originalMode) {
          this.saveAtlasLog(state.userId, symbol, 'info',
            `✅ RECUPERAÇÃO CONCLUÍDA\n` +
            `• Ação: Retornando ao modo ${state.originalMode.toUpperCase()}\n` +
            `• Status: Meta de recuperação atingida.`);
          state.mode = state.originalMode;
        }
      }
      // ✅ Soros: verificar ciclo (Apenas se NÃO estava em recuperação)
      else if (!state.isInRecovery) {
        state.virtualLossCount = 0;
        state.virtualLossActive = false;

        if (state.vitoriasConsecutivas === 0) {
          state.vitoriasConsecutivas = 1;
          state.isInSoros = true;
          state.ultimoLucro = lucro;
        } else if (state.vitoriasConsecutivas === 1) {
          state.vitoriasConsecutivas = 2;
          state.ultimoLucro = lucro;
        } else if (state.vitoriasConsecutivas === 2) {
          state.vitoriasConsecutivas = 0;
          state.isInSoros = false;
          state.ultimoLucro = 0;
        }
      }

      state.virtualLossCount = 0;
      state.virtualLossActive = false;

      const opLabel = operation === 'CALL' ? 'Rise' : (operation === 'PUT' ? 'Fall' : operation);

      // ✅ LOG PADRONIZADO V2: Vitória
      this.logTradeResultV2(state.userId, {
        status: 'WIN',
        profit: lucro,
        stake: stakeAmount,
        balance: state.capital
      });

    } else {
      // ✅ DERROTA
      const perda = stakeAmount;
      state.capital -= perda;
      state.totalProfitLoss -= perda;

      if (state.isInSoros) {
        state.vitoriasConsecutivas = 0;
        state.isInSoros = false;
        state.ultimoLucro = 0;
      }

      if (state.martingaleStep === 0) {
        state.martingaleStep = 1;
        state.perdaAcumulada = perda;
        state.isInRecovery = true;
        state.virtualLossCount = (state.virtualLossCount || 0) + 1;
      } else {
        state.martingaleStep += 1;
        state.perdaAcumulada += perda;
        state.virtualLossCount = (state.virtualLossCount || 0) + 1;
      }

      const requiredLosses = { veloz: 0, normal: 1, lento: 2 };
      const maxLosses = requiredLosses[state.mode as keyof typeof requiredLosses] || 0;

      if (state.virtualLossCount > maxLosses) {
        state.virtualLossCount = maxLosses;
        state.virtualLossActive = true;
      }

      // ✅ ATLAS: Defesa Automática (Switch to Lento após 4 perdas consecutivas na recuperação)
      if (state.isInRecovery && state.martingaleStep >= 4 && state.mode !== 'lento') {
        state.mode = 'lento';
        this.saveAtlasLog(state.userId, symbol, 'alerta',
          `🛡️ DEFESA AUTOMÁTICA ATIVADA\n` +
          `• Motivo: 4 Perdas Consecutivas.\n` +
          `• Ação: Mudando para MODO LENTO para proteção de capital.`);
      }

      // ✅ ATLAS: Reset após M5 (6ª perda) - Limite máximo de recuperação
      if (state.isInRecovery && state.martingaleStep > 5) {
        this.saveAtlasLog(state.userId, symbol, 'alerta',
          `🛑 LIMITE DE RECUPERAÇÃO ATINGIDO\n` +
          `• Motivo: 6 Perdas Consecutivas (M5).\n` +
          `• Ação: Resetando ciclo de martingale.\n` +
          `• Perda Total: $${state.perdaAcumulada.toFixed(2)}`);

        state.martingaleStep = 0;
        state.perdaAcumulada = 0;
        state.isInRecovery = false;

        // Voltar ao modo original após reset
        if (state.mode !== state.originalMode) {
          state.mode = state.originalMode;
        }
      }

      const digitoResultado = exitPrice > 0 ? this.extractLastDigit(exitPrice) : 0;
      const opLabel = operation === 'CALL' ? 'Rise' : (operation === 'PUT' ? 'Fall' : operation);

      // ✅ LOG PADRONIZADO V2: Derrota
      this.logTradeResultV2(state.userId, {
        status: 'LOSS',
        profit: -perda,
        stake: stakeAmount,
        balance: state.capital
      });

    }

    // ✅ [ZENIX v3.1] Lucro da SESSÃO (Recalculado após a trade)
    const lucroSessao = state.totalProfitLoss;

    // Atualizar saldo da sessão no banco de dados (Sincronismo para Dashboard)
    this.dataSource.query(
      `UPDATE ai_user_config SET session_balance = ? WHERE user_id = ? AND is_active = 1`,
      [lucroSessao, state.userId]
    ).catch(e => { });

    // Verificar Limites (Meta, Stop Loss, Blindado)
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
    const symbol = state.symbol || 'SISTEMA';

    // ✅ [ORION PARALLEL CHECK] - Reerificar limites do banco (Segunda Camada)
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

    if (!configResult || configResult.length === 0) return;

    const config = configResult[0];
    const lossLimit = parseFloat(config.lossLimit) || 0;
    const profitTarget = parseFloat(config.profitTarget) || 0;
    const capitalInicial = parseFloat(config.capitalInicial) || 0;

    const lucroAtual = parseFloat(config.sessionBalance) || 0;
    const capitalSessao = capitalInicial + lucroAtual;

    // 1. Meta de Lucro (Profit Target)
    if (profitTarget > 0 && lucroAtual >= profitTarget) {
      this.saveAtlasLog(state.userId, symbol, 'info',
        `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)}`, state.userId],
      );

      this.tradeEvents.emit({
        userId: state.userId,
        type: 'stopped_profit',
        strategy: 'atlas',
        symbol: symbol,
        profitLoss: lucroAtual
      });

      this.atlasUsers.delete(state.userId);
      state.isStopped = true;
      return;
    }

    // 2. Stop-loss blindado
    if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
      const profitPeak = parseFloat(config.profitPeak) || 0;
      const activationThreshold = profitTarget * 0.40;

      if (profitTarget > 0 && profitPeak >= activationThreshold) {
        const factor = (parseFloat(config.stopBlindadoPercent) || 50.0) / 100;
        const stopBlindado = capitalInicial + (profitPeak * factor);

        if (capitalSessao <= stopBlindado) {
          const lucroFinal = capitalSessao - capitalInicial;
          this.saveAtlasLog(state.userId, symbol, 'alerta',
            `💰✅Stoploss blindado atingido, o sistema parou as operações com um lucro de $${lucroFinal.toFixed(2)} para proteger o seu capital.`
          );

          await this.dataSource.query(
            `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop Blindado: +$${lucroFinal.toFixed(2)}`, state.userId],
          );

          this.tradeEvents.emit({
            userId: state.userId,
            type: 'stopped_blindado',
            strategy: 'atlas',
            symbol: symbol,
            profitProtected: lucroFinal,
            profitLoss: lucroFinal
          });

          this.atlasUsers.delete(state.userId);
          state.isStopped = true;
          return;
        }
      }
    }

    // 3. Stop Loss Normal
    const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
    if (lossLimit > 0 && perdaAtual >= lossLimit) {
      this.saveAtlasLog(state.userId, symbol, 'alerta',
        `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Stop Loss atingido: -$${perdaAtual.toFixed(2)}`, state.userId],
      );

      this.tradeEvents.emit({
        userId: state.userId,
        type: 'stopped_loss',
        strategy: 'atlas',
        symbol: symbol,
        profitLoss: -perdaAtual
      });

      this.atlasUsers.delete(state.userId);
      state.isStopped = true;
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
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V';
  }): { isNew: boolean; hasConfigChanges: boolean } {
    const existing = this.atlasUsers.get(params.userId);
    const stopLossNormalized = params.lossLimit != null ? -Math.abs(params.lossLimit) : null;
    let hasConfigChanges = false;

    if (existing) {
      hasConfigChanges =
        existing.capitalInicial !== params.stakeAmount ||
        existing.originalMode !== params.mode ||
        existing.modoMartingale !== (params.modoMartingale || 'conservador') ||
        existing.profitTarget !== (params.profitTarget || null) ||
        existing.stopLoss !== stopLossNormalized ||
        existing.stopLossBlindado !== Boolean(params.stopLossBlindado) ||
        existing.symbol !== params.symbol ||
        existing.apostaBase !== params.apostaInicial;

      const configChanged = existing.originalMode !== params.mode;

      Object.assign(existing, {
        capital: params.stakeAmount,
        // capitalInicial: Mantido para não resetar meta/stop loss
        derivToken: params.derivToken,
        currency: params.currency,
        // ✅ ATLAS: Só atualiza o mode SE o usuário mudou a configuração explicitamente
        // Se for apenas uma reconexão/update e estivermos em defesa (mode != originalMode), mantemos a defesa.
        mode: configChanged ? params.mode : existing.mode,
        originalMode: params.mode, // Sempre atualiza a preferência do usuário
        modoMartingale: params.modoMartingale || 'conservador',
        profitTarget: params.profitTarget || null,
        stopLoss: stopLossNormalized,
        stopLossBlindado: Boolean(params.stopLossBlindado),
        symbol: params.symbol,
        isStopped: false, // ✅ Permite reiniciar após bater stop se o usuário salvou nova config
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
      originalMode: params.mode, // Inicializa com o modo escolhido
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
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V';
    contractType: string;
    entryPrice: number;
    stakeAmount: number;
    operation: 'OVER' | 'UNDER' | 'CALL' | 'PUT' | 'EVEN' | 'ODD';
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
            gemini_duration, contract_type, contract_id, created_at, analysis_data, symbol, strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'atlas')`,
          [
            trade.userId,
            // ✅ AJUSTE VISUAL: Mapear para 'Rise'/'Fall' para garantir seta correta no frontend
            (trade.operation === 'CALL' ? 'Rise' :
              trade.operation === 'PUT' ? 'Fall' : trade.operation),
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
              gemini_duration, contract_type, contract_id, created_at, analysis_data, strategy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'atlas')`,
            [
              trade.userId,
              // ✅ AJUSTE VISUAL: Mapear para 'Rise'/'Fall' para garantir seta correta no frontend
              (trade.operation === 'CALL' ? 'Rise' : (trade.operation === 'PUT' ? 'Fall' : trade.operation)),
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
    symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V' | 'SISTEMA',
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'vitoria' | 'derrota' | 'alerta' | 'erro',
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

  // ------------------------------------------------------------------
  // ✅ LOGS PADRONIZADOS ZENIX v2.0 (Helpers)
  // ------------------------------------------------------------------

  private logInitialConfigV2(userId: string, config: {
    strategyName: string;
    operationMode: string;
    riskProfile: string;
    profitTarget: number;
    stopLoss: number;
    stopBlindadoEnabled: boolean;
  }) {
    const message = `⚙️ CONFIGURAÇÃO INICIAL\n` +
      `• Estratégia: ${config.strategyName}\n` +
      `• Modo: ${config.operationMode}\n` +
      `• Perfil: ${config.riskProfile}\n` +
      `• Meta: ${config.profitTarget > 0 ? '$' + config.profitTarget.toFixed(2) : 'N/A'}\n` +
      `• Stop Loss: ${config.stopLoss > 0 ? '$' + config.stopLoss.toFixed(2) : 'N/A'}\n` +
      `• Stop Blindado: ${config.stopBlindadoEnabled ? 'Ativado' : 'Desativado'}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'info', message);
  }

  private logSessionStart(userId: string, session: {
    date: Date;
    initialBalance: number;
    profitTarget: number;
    stopLoss: number;
    mode: string;
    strategyName: string;
  }) {
    const message = `🚀 INÍCIO DE SESSÃO DIÁRIA\n` +
      `• Data: ${session.date.toLocaleDateString('pt-BR')}\n` +
      `• Banca Inicial: $${session.initialBalance.toFixed(2)}\n` +
      `• Meta do Dia: $${session.profitTarget.toFixed(2)}\n` +
      `• Stop Loss: $${session.stopLoss.toFixed(2)}\n` +
      `• Modo: ${session.mode}\n` +
      `• Estratégia: ${session.strategyName}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'info', message);
  }

  private logDataCollection(userId: string, data: {
    targetCount: number;
    currentCount: number;
    mode?: string;
  }) {
    const percentage = Math.min(100, Math.round((data.currentCount / data.targetCount) * 100));
    const message = `📡 COLETA DE DADOS${data.mode ? ` (${data.mode})` : ''}\n` +
      `• Progresso: ${percentage}% (${data.currentCount}/${data.targetCount})\n` +
      `• Status: Aguardando dados suficientes...`;

    this.saveAtlasLog(userId, 'SISTEMA', 'info', message);
  }

  private logAnalysisStarted(userId: string, mode: string) {
    const message = `🔍 ANÁLISE DE MERCADO EXECUTADA\n` +
      `• Modo: ${mode}\n` +
      `• Status: Buscando oportunidades...`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logSignalGenerated(userId: string, signal: {
    mode: string;
    isRecovery: boolean;
    filters: string[];
    trigger: string;
    probability: number;
    contractType: string;
    direction?: 'CALL' | 'PUT';
  }) {
    // Definir ícone baseado no tipo de análise
    const icon = signal.isRecovery ? '🛡️' : '⚡'; // Escudo para recuperação, Raio para normal
    const title = signal.isRecovery ? `SINAL GERADO (RECUPERAÇÃO)` : `SINAL IDENTIFICADO`;
    const modeLabel = signal.isRecovery ? `${signal.mode} (RECUPERAÇÃO)` : signal.mode;

    let message = `${icon} ${title}\n` +
      `• Modo: ${modeLabel}\n`;

    // Adicionar filtros aprovados
    signal.filters.forEach((filter, index) => {
      message += `✅ Filtro ${index + 1}: ${filter}\n`;
    });

    message += `✅ Gatilho: ${signal.trigger}\n` +
      `💪 Probabilidade: ${signal.probability}%\n` +
      `🎯 Contrato: ${signal.contractType}${signal.direction ? ` (${signal.direction})` : ''}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'sinal', message);
  }

  private logTradeResultV2(userId: string, result: {
    status: 'WIN' | 'LOSS';
    profit: number;
    stake: number;
    balance: number;
  }) {
    const isWin = result.status === 'WIN';
    const icon = isWin ? '✅' : '❌';
    const profitLabel = isWin ? 'Lucro' : 'Prejuízo';

    // Formatação do valor (positivo para lucro, negativo para prejuízo)
    const profitValue = isWin ? `+$${result.profit.toFixed(2)}` : `-$${Math.abs(result.profit).toFixed(2)}`;

    const message = `🏁 TRADE FINALIZADO: ${result.status}\n` +
      `${isWin ? '💰' : '📉'} ${profitLabel.toUpperCase()}: ${profitValue}\n` +
      `📈 BANCA ATUAL: $${result.balance.toFixed(2)}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'resultado', message);
  }

  private logMartingaleLevelV2(userId: string, martingale: {
    level: number;
    lossNumber: number;
    accumulatedLoss: number;
    calculatedStake: number;
    profitPercentage: number;
    contractType: string;
  }) {
    const message = `📊 NÍVEL DE RECUPERAÇÃO\n` +
      `• Nível Atual: M${martingale.level} (${martingale.lossNumber}ª perda)\n` +
      `• Perdas Acumuladas: $${martingale.accumulatedLoss.toFixed(2)}\n` +
      `• Stake Calculada: $${martingale.calculatedStake.toFixed(2)}\n` +
      `• Objetivo: Recuperar + ${martingale.profitPercentage.toFixed(0)}%\n` +
      `• Contrato: ${martingale.contractType}`;

    // Usar tipo 'alerta' para destacar recuperação
    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logSorosActivation(userId: string, soros: {
    previousProfit: number;
    stakeBase: number;
    level?: number;
  }) {
    const level = soros.level || 1;
    const newStake = soros.stakeBase + soros.previousProfit;

    const message = `🚀 APLICANDO SOROS NÍVEL ${level}\n` +
      `• Lucro Anterior: $${soros.previousProfit.toFixed(2)}\n` +
      `• Nova Stake (Base + Lucro): $${newStake.toFixed(2)}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'info', message);
  }

  private logWinStreak(userId: string, streak: {
    consecutiveWins: number;
    accumulatedProfit: number;
    currentStake: number;
  }) {
    const message = `🔥 WIN STREAK: ${streak.consecutiveWins} VITÓRIAS\n` +
      `• Lucro Acumulado: $${streak.accumulatedProfit.toFixed(2)}\n` +
      `• Stake Atual: $${streak.currentStake.toFixed(2)}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'vitoria', message);
  }

  private logSuccessfulRecoveryV2(userId: string, recovery: {
    recoveredLoss: number;
    additionalProfit: number;
    profitPercentage: number;
    stakeBase: number;
  }) {
    const message = `✅ RECUPERAÇÃO BEM-SUCEDIDA!\n` +
      `• Perdas Recuperadas: $${recovery.recoveredLoss.toFixed(2)}\n` +
      `• Lucro Adicional: $${recovery.additionalProfit.toFixed(2)} (${recovery.profitPercentage.toFixed(2)}%)\n` +
      `• Ação: Resetando sistema e voltando à entrada principal\n` +
      `• Próxima Operação: Entrada Normal (Stake Base: $${recovery.stakeBase.toFixed(2)})`;

    this.saveAtlasLog(userId, 'SISTEMA', 'vitoria', message);
  }

  private logConservativeReset(userId: string, reset: {
    stakeBase: number;
  }) {
    const message = `⚠️ LIMITE DE RECUPERAÇÃO ATINGIDO (CONSERVADOR)\n` +
      `• Ação: Aceitando perda e resetando stake.\n` +
      `• Próxima Entrada: Valor Inicial ($${reset.stakeBase.toFixed(2)})`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private async saveAtlasLogsBatch(
    userId: string,
    logs: Array<{
      symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V' | 'SISTEMA';
      type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'vitoria' | 'derrota' | 'alerta' | 'erro';
      message: string;
      details?: any;
    }>,
  ): Promise<void> {
    if (logs.length === 0) return;

    try {
      const icons = {
        info: '',
        tick: '',
        analise: '',
        sinal: '',
        operacao: '',
        resultado: '',
        vitoria: '',
        derrota: '',
        alerta: '',
        erro: '',
      };

      const values = logs.map(log => {
        const icon = icons[log.type] || '';
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
  getTicks(symbol: 'R_10' | 'R_25' | 'R_100' | '1HZ100V'): Tick[] {
    return this.atlasTicks[symbol];
  }

  getUsers(): Map<string, AtlasUserState> {
    return this.atlasUsers;
  }

  getActiveUsers(): AtlasUserState[] {
    return Array.from(this.atlasUsers.values()).filter((u) => !u.isStopped);
  }
}
