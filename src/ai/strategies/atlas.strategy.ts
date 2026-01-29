import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity, CONFIGS_MARTINGALE } from '../ai.service';
import { TradeEventsService } from '../trade-events.service';

import { IStrategy, ModeConfig, ATLAS_VELOZ_CONFIG, ATLAS_NORMAL_CONFIG, ATLAS_LENTO_CONFIG, ModoMartingale } from './common.types';
import { CopyTradingService } from '../../copy-trading/copy-trading.service';
import { getMinStakeByCurrency, formatCurrency } from '../../utils/currency.utils';

// ✅ [ZENIX v3.4] Suporte para moedas dinâmicas (BTC, etc)
// Removidas funções locais, usando currency.utils.ts

// ✅ ATLAS: Função para calcular próxima aposta de martingale - ATLAS v2.0
// Atualizado: Payout ajustado para 0.83 (83%) para garantir recuperação com margem de segurança
function calcularProximaApostaAtlas(
  perdasTotais: number,
  modo: ModoMartingale,
  payoutCliente: number = 0.35,
  currency: string = 'USD' // Default inicial, deve ser sobrescrito pelo state real
): number {
  let aposta = 0;
  const minStake = getMinStakeByCurrency(currency);

  // Ajuste do payout se vier como porcentagem (ex: 92)
  const payout = payoutCliente > 1 ? payoutCliente / 100 : payoutCliente;

  switch (modo) {
    case 'conservador':
      // Recupera 100% da perda + 2% de lucro
      aposta = (perdasTotais * 1.02) / payout;
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

  const decimals = ['BTC', 'ETH'].includes(currency.toUpperCase()) ? 8 : 2;
  return Math.max(minStake, Math.round(aposta * Math.pow(10, decimals)) / Math.pow(10, decimals));
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
  symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V';

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

  // Rastreamento para logs
  // ✅ ATLAS R50 Spec Fields
  consecutiveLosses: number;
  consecutiveWins: number;
  sessionProfit: number;
  sessionLoss: number;

  // Recovery Cycle
  recovering: boolean;
  recoveryLosses: number;
  recoveryTargetProfit: number;
  recoveryRecovered: number;
  protectedFloor: number; // ✅ ATLAS: Piso protegido pelo Stop Blindado

  // Pausa
  pauseUntilTs: number;
  recoveredFromLossStreak: number;

  // Legacy/Compatibilidade (manter para não quebrar)
  ultimaDirecaoOp?: string;
}

@Injectable()
export class AtlasStrategy implements IStrategy {
  name = 'atlas';
  private readonly logger = new Logger(AtlasStrategy.name);

  private atlasUsers = new Map<string, AtlasUserState>();
  private atlasTicks: {
    R_10: Tick[];
    R_25: Tick[];
    R_50: Tick[];
    R_100: Tick[];
    '1HZ10V': Tick[];
    '1HZ100V': Tick[];
  } = {
      R_10: [],
      R_25: [],
      R_50: [],
      R_100: [],
      '1HZ10V': [],
      '1HZ100V': [],
    };

  private appId: number;
  private maxTicks = 50; // ✅ ATLAS: Buffer menor para análise ultrarrápida

  // ✅ Sistema de logs (similar à Trinity)
  private logQueue: Array<{
    userId: string;
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V' | 'SISTEMA';
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
      authorizedCurrency: string | null;
      keepAliveInterval: NodeJS.Timeout | null;
      requestIdCounter: number;
      pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
      subscriptions: Map<string, (msg: any) => void>;
      lastLatency: number; // ✅ ATLAS: Rastrear latência
    }
  > = new Map();
  private lastActivationLog: Map<string, number> = new Map();

  constructor(
    private readonly dataSource: DataSource,
    private readonly tradeEvents: TradeEventsService,
    private readonly copyTradingService: CopyTradingService,

  ) {
    this.appId = Number(process.env.DERIV_APP_ID || 1089);
  }

  async initialize(): Promise<void> {
    this.logger.log('[ATLAS] Estratégia ATLAS v2.0 (EHF) inicializada');
    this.logger.log('[ATLAS] Aguardando ticks do AIService (R_10, R_25, R_100, 1HZ10V, 1HZ100V)...');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    if (!symbol || !['R_10', 'R_25', 'R_50', 'R_100', '1HZ10V', '1HZ100V'].includes(symbol)) {
      // ✅ DIAGNÓSTICO: Log quando recebe símbolo inválido
      if (symbol) {
        this.logger.debug(`[ATLAS] ⚠️ Tick recebido com símbolo inválido: ${symbol} (esperado R_10, R_25, R_100, 1HZ10V ou 1HZ100V)`);
      }
      return;
    }

    const assetSymbol = symbol as 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V';
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
        this.saveAtlasLog(state.userId, assetSymbol, 'analise',
          `IA ATLAS EM OPERAÇÃO
Mercado: ${assetSymbol}
Status: Analisando padrões...`);
      }

      await this.processAtlasStrategies(tick, state);
    }
  }

  private setUltimaDirecaoOp(state: AtlasUserState, operation: string) {
    if (operation === 'OVER') state.ultimaDirecaoOp = 'DIGIT OVER';
    else if (operation === 'UNDER') state.ultimaDirecaoOp = 'DIGIT UNDER';
    else if (operation === 'CALL') state.ultimaDirecaoOp = 'CALL';
    else if (operation === 'PUT') state.ultimaDirecaoOp = 'PUT';
    else state.ultimaDirecaoOp = operation;
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

    // ✅ [ATLAS v3.5] MERCADO FIXO: R_50 (Volatility 50)
    let atlasSymbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V' = 'R_50';

    if (symbol && ['R_10', 'R_25', 'R_50', 'R_100', '1HZ10V', '1HZ100V'].includes(symbol)) {
      atlasSymbol = symbol as any;
    } else if (selectedMarket) {
      const marketLower = selectedMarket.toLowerCase();
      // Mapeamento flexível
      if (marketLower.includes('50') || marketLower.includes('r_50')) atlasSymbol = 'R_50';
      else if (marketLower.includes('100') && !marketLower.includes('1hz')) atlasSymbol = 'R_100';
      else if (marketLower.includes('1hz100v')) atlasSymbol = '1HZ100V';
      else if (marketLower.includes('1hz10v')) atlasSymbol = '1HZ10V';
      else if (marketLower.includes('10') && !marketLower.includes('1hz')) atlasSymbol = 'R_10';
      else if (marketLower.includes('25')) atlasSymbol = 'R_25';
    }

    const stakeAmountNum = Number(stakeAmount);
    const profitTargetNum = profitTarget != null ? Number(profitTarget) : null;
    const lossLimitNum = lossLimit != null ? Number(lossLimit) : null;
    const stopLossNormalized = lossLimitNum != null ? -Math.abs(lossLimitNum) : null;
    const normalizedCurrency = (currency || 'USD').toUpperCase(); // Fallback para USD apenas se realmente não houver nada
    const minStake = getMinStakeByCurrency(normalizedCurrency);
    const apostaInicial = entryValue != null ? Number(entryValue) : minStake;

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
      this.logger.log(`[ATLAS] ${logPrefix} ${userId} | Ativo: ${atlasSymbol} | Total de usuários: ${this.atlasUsers.size}`);

      const state = this.atlasUsers.get(userId);
      const saldoAtual = state ? state.capital : stakeAmountNum;

      // ✅ LOG PADRONIZADO V2: Configuração Inicial
      this.logInitialConfigV2(userId, {
        strategyName: 'ATLAS 3.5',
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
        strategyName: 'ATLAS 3.5',
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

    // ✅ [ATLAS R_50] Pausa Estratégica
    if (state.pauseUntilTs && Date.now() < state.pauseUntilTs) {
      return;
    }

    // ✅ ATLAS: Verificar amostra mínima (Janela dinâmica)
    let minWindow = 12; // Veloz
    if (state.mode === 'normal') minWindow = 25;
    if (state.mode === 'lento' || state.mode === 'preciso') minWindow = 40;

    if (state.digitBuffer.length < minWindow) {
      // Logs de coleta (mantendo lógica existente de log periódico)
      const keyUser = state.userId;
      const set = this.coletaLogsEnviados.get(keyUser) || new Set<string>();
      const logKey = `${symbol}_coleta`;
      const shouldLog = !set.has(logKey) || state.digitBuffer.length % 5 === 0;
      if (shouldLog) {
        this.logDataCollection(state.userId, {
          targetCount: minWindow,
          currentCount: state.digitBuffer.length,
          mode: state.mode.toUpperCase(),
        });
        set.add(logKey);
        this.coletaLogsEnviados.set(keyUser, set);
        if (state.digitBuffer.length % 5 === 0) {
          set.delete(logKey);
        }
      }
      return;
    }

    // ✅ [ATLAS v3.5] Geração de Sinal (Novo Fluxo)
    let analysisRes: { canTrade: boolean; analysis: string; operation?: 'OVER' | 'CALL' | 'PUT' } = {
      canTrade: false,
      analysis: 'Aguardando gatilho...'
    };

    if (state.recovering) {
      // ✅ RECUPERAÇÃO: Rise/Fall
      const signalRF = this.getRecoverySignal(state, symbol);
      if (signalRF) {
        analysisRes = {
          canTrade: true,
          operation: signalRF,
          analysis: `MODO RECUPERAÇÃO: Gatilho Rise/Fall detectado (${signalRF})`
        };
      }
    } else {
      // ✅ OPERAÇÃO NORMAL: Digits Over 2
      const triggerRes = this.checkAtlasTriggers(state, modeConfig);
      if (triggerRes.canTrade) {
        analysisRes = {
          canTrade: true,
          operation: 'OVER',
          analysis: triggerRes.analysis
        };
      }
    }

    if (analysisRes.canTrade && analysisRes.operation) {
      await this.executeAtlasOperation(state, symbol, analysisRes.operation, analysisRes.analysis);
    } else {
      // Log periódico de observação
      if ((state.tickCounter || 0) % 15 === 0) {
        const obsMsg = state.recovering ? 'Monitorando tendência para Recuperação...' : 'Analisando dígitos para Over 2...';
        this.saveAtlasLog(state.userId, symbol, 'analise', obsMsg);
      }
    }
  }

  /**
   * ✅ ATLAS: Verifica gatilhos ultrarrápidos (Conforme Documentação)
   */
  private checkAtlasTriggers(state: AtlasUserState, modeConfig: ModeConfig): { canTrade: boolean; analysis: string } {
    const modeLower = (state.mode || 'veloz').toLowerCase();
    const normalizedMode = modeLower === 'preciso' || modeLower === 'lento' ? 'preciso' :
      (modeLower === 'normal' || modeLower === 'moderado' ? 'normal' : 'veloz');

    const lastDigit = state.digitBuffer[state.digitBuffer.length - 1];

    // ✅ 1. MODO VELOZ: Janela 6 ticks | Máx 1 dígito <= 2
    if (normalizedMode === 'veloz') {
      const window = state.digitBuffer.slice(-6);
      const underCount = window.filter(d => d <= 2).length;

      if (underCount <= 1) {
        const strength = underCount === 0 ? '90% (Alta)' : '75% (Média)';
        return {
          canTrade: true,
          analysis: `ANÁLISE v3.5 [VELOZ]
Gatilho: Over 2
Filtro: Janela 6 Ticks
Detectado: ${underCount} perdedores
Força: ${strength}
Entrada: DIGIT OVER 2`
        };
      }
    }

    // ✅ 2. MODO NORMAL: Janela 10 ticks | Máx 1 dígito <= 2
    if (normalizedMode === 'normal') {
      const window = state.digitBuffer.slice(-10);
      const underCount = window.filter(d => d <= 2).length;

      if (underCount <= 1) {
        const strength = underCount === 0 ? '92% (Alta)' : '80% (Média)';
        return {
          canTrade: true,
          analysis: `ANÁLISE v3.5 [NORMAL]
Gatilho: Over 2
Filtro: Janela 10 Ticks
Detectado: ${underCount} perdedores
Força: ${strength}
Entrada: DIGIT OVER 2`
        };
      }
    }

    // ✅ 3. MODO PRECISO: Janela 15 ticks | ZERO dígitos <= 2
    if (normalizedMode === 'preciso') {
      const window = state.digitBuffer.slice(-15);
      const underCount = window.filter(d => d <= 2).length;

      if (underCount === 0) {
        return {
          canTrade: true,
          analysis: `ANÁLISE v3.5 [PRECISO]
Gatilho: Over 2
Filtro: Janela 15 Ticks (Pureza Total)
Detectado: 0 perdedores
Força: 95% (Máxima)
Entrada: DIGIT OVER 2`
        };
      }
    }

    return {
      canTrade: false,
      analysis: 'Monitorando força do sinal...'
    };
  }

  /**
   * ✅ ATLAS: Sinal de Recuperação (Price Action)
   */
  /**
   * ✅ ATLAS: Sinal de Recuperação (Price Action) - Filtros Específicos por Modo
   */
  private getRecoverySignal(state: AtlasUserState, symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V'): 'CALL' | 'PUT' | null {
    const ticks = this.atlasTicks[symbol];
    const modeLower = (state.mode || 'veloz').toLowerCase();
    const normalizedMode = modeLower === 'preciso' || modeLower === 'lento' ? 'preciso' :
      (modeLower === 'normal' || modeLower === 'moderado' ? 'normal' : 'veloz');

    // Mapeamento de Ticks por Modo (Spec v3.5)
    // VELOZ: 3 ticks | NORMAL: 5 ticks | PRECISO: 7 ticks
    const requiredTicks = normalizedMode === 'veloz' ? 3 : (normalizedMode === 'normal' ? 5 : 7);
    if (ticks.length < requiredTicks) return null;

    const recent = ticks.slice(-requiredTicks);

    // Análise de Tendência (Todos na mesma direção)
    let isUp = true;
    let isDown = true;
    let totalDelta = 0;

    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i].value - recent[i - 1].value;
      if (diff <= 0) isUp = false;
      if (diff >= 0) isDown = false;
      totalDelta += Math.abs(diff);
    }

    if (!isUp && !isDown) return null;

    // Filtro de Delta Progressivo (Spec v3.5)
    // VELOZ: 0.013 | NORMAL: 0.021 | PRECISO: 0.030
    const threshold = normalizedMode === 'veloz' ? 0.013 : (normalizedMode === 'normal' ? 0.021 : 0.030);

    if (totalDelta < threshold) {
      // Log periódico de rejeição por delta insuficiente
      if ((state.tickCounter || 0) % 10 === 0) {
        this.logger.debug(`[ATLAS][RECOVERY] Delta insuficiente: ${totalDelta.toFixed(4)} < ${threshold}`);
      }
      return null;
    }

    return isUp ? 'CALL' : 'PUT';
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
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V',
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

    this.setUltimaDirecaoOp(state, operation);

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
      const currentPeak = Math.max(profitPeak, lucroAtual);

      // Sincronizar estado em memória com banco (para exibição correta)
      state.capital = capitalSessao;
      state.capitalInicial = capitalInicial;
      state.totalProfitLoss = lucroAtual;

      // Meta de Lucro
      if (profitTarget > 0 && lucroAtual >= profitTarget) {
        this.logSessionEnd(state.userId, {
          result: 'TAKE_PROFIT',
          totalProfit: lucroAtual,
          trades: state.consecutiveWins + state.consecutiveLosses
        });

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

          if (currentPeak >= activationThreshold && !state.blindadoActive) {
            state.blindadoActive = true;
            const fixedProtectedAmount = activationThreshold * 0.50; // 20% da meta
            this.logStrategicPause(state.userId, 'ATIVADA', `🛡️ Stop Blindado Ativado! (META: ${formatCurrency(profitTarget, state.currency)})\n• LUCRO ATUAL: +${formatCurrency(currentPeak, state.currency)}\n• PROTEÇÃO FIXA: +${formatCurrency(fixedProtectedAmount, state.currency)} (20% da Meta)`);
          }
        }

        if (profitTarget > 0 && currentPeak >= activationThreshold) {
          // [ZENIX v3.5] Stop Blindado Fixo: 
          // Piso: 50% do valor de ATIVAÇÃO (20% do TP)
          const fixedGuaranteedProfit = activationThreshold * 0.50;
          const stopBlindado = capitalInicial + fixedGuaranteedProfit;

          if (capitalSessao <= stopBlindado) {
            const lucroFinal = capitalSessao - capitalInicial;
            this.logSessionEnd(state.userId, {
              result: 'STOP_LOSS',
              totalProfit: lucroFinal,
              trades: state.consecutiveWins + state.consecutiveLosses
            });

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
        this.logSessionEnd(state.userId, {
          result: 'STOP_LOSS',
          totalProfit: -perdaAtual,
          trades: state.consecutiveWins + state.consecutiveLosses
        });

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

      // ✅ [ATLAS R_50] Calculation of Stake (Spec Logic)
      const balance = state.capital; // Using internal state capital which is sync'd
      stakeAmount = this.calculateStake(state, balance);

      // Safety Checks (Existing)
      const minStake = getMinStakeByCurrency(state.currency);
      const decimals = ['BTC', 'ETH'].includes(state.currency.toUpperCase()) ? 8 : 2;
      const stopLossDisponivel = this.calculateAvailableStopLoss(state);

      if (stakeAmount > stopLossDisponivel) {
        // Keep existing Stop Loss Logic
        if (stopLossDisponivel < minStake) {
          // ... (Logic to stop if no balance for min stake)
          // Copying existing logic below for safety
          const isBlindado = state.blindadoActive;
          const msg = isBlindado
            ? `🛡️ STOP BLINDADO ATINGIDO POR AJUSTE DE ENTRADA!`
            : `🛑 STOP LOSS ATINGIDO POR AJUSTE DE ENTRADA!`;

          this.saveAtlasLog(state.userId, symbol, 'alerta', msg);
          state.isStopped = true;
          state.isOperationActive = false;
          await this.deactivateUser(state.userId);
          return;
        }
        stakeAmount = stopLossDisponivel;
      }

      // ✅ FORCE 2 DECIMAL PLACES - Prevent "Stake can not have more than 2 decimal places" error
      stakeAmount = Math.floor(stakeAmount * Math.pow(10, decimals)) / Math.pow(10, decimals); // Use floor to avoid rounding up issues
      stakeAmount = Math.max(minStake, stakeAmount);

      // ✅ [ATLAS R_50] Contract Type Mapping
      let contractType = '';
      if (operation === 'EVEN') contractType = 'DIGITEVEN';
      else if (operation === 'ODD') contractType = 'DIGITODD';
      else if (operation === 'OVER') contractType = 'DIGITOVER'; // Fallback
      else if (operation === 'UNDER') contractType = 'DIGITUNDER'; // Fallback
      else if (operation === 'CALL') contractType = 'CALL';
      else if (operation === 'PUT') contractType = 'PUT';

      state.isOperationActive = true;
      state.lastOperationTimestamp = new Date();
      state.ultimaApostaUsada = stakeAmount;

      if (analysis) {
        this.saveAtlasLog(state.userId, symbol, 'analise', analysis);
      }

      this.logger.log(
        `[ATLAS][${symbol}] 🎲 EXECUTANDO | User: ${state.userId} | ` +
        `Op: ${operation} | Stake: ${stakeAmount} | Recovering: ${state.recovering}`
      );

      this.logger.log(
        `[ATLAS][${symbol}] 🎲 EXECUTANDO | User: ${state.userId} | ` +
        `Operação: ${operation} | Stake: ${formatCurrency(stakeAmount, state.currency)} | ` +
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

        // ✅ ATLAS v3.2: Alinhamento com Orion - Usar token do estado (já resolvido pelo AiService)
        // Isso remove a verificação redundante que estava bloqueando trades
        if (!state.derivToken) {
          this.logger.warn(`[ATLAS][${symbol}] ❌ Token não encontrado no estado. Abortando.`);
          state.isOperationActive = false;
          return;
        }

        const effectiveToken = state.derivToken;
        const effectiveCurrency = state.currency || 'USD';

        const result = await this.executeAtlasTradeDirect(
          state.userId,
          symbol,
          effectiveToken,
          {
            symbol,
            contract_type: contractType,
            amount: stakeAmount,
            currency: effectiveCurrency,
            duration: 1,
            duration_unit: 't',
          },
          async (contractId, entryPrice) => {
            // ✅ [ATLAS] Master Trader Replication - IMMEDIATE (at entry)
            try {
              const userMaster = await this.dataSource.query('SELECT trader_mestre FROM users WHERE id = ?', [state.userId]);
              const isMasterTraderFlag = userMaster && userMaster.length > 0 && userMaster[0].trader_mestre === 1;

              if (isMasterTraderFlag) {
                const percent = state.capital > 0 ? (stakeAmount / state.capital) * 100 : 0;
                const unixTimestamp = Math.floor(Date.now() / 1000);

                // 1. Gravar na tabela master_trader_operations as OPEN
                await this.dataSource.query(
                  `INSERT INTO master_trader_operations
                       (trader_id, symbol, contract_type, barrier, stake, percent, multiplier, duration, duration_unit, trade_type, status, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                  [
                    state.userId,
                    symbol,
                    contractType, // 'DIGITOVER', 'DIGITUNDER', etc
                    contractType === 'DIGITOVER' || contractType === 'DIGITUNDER' ? 3 : null, // barrier
                    stakeAmount,
                    percent,
                    0, // multiplier
                    1, // duration
                    't', // duration_unit
                    operation === 'OVER' ? 'CALL' : (operation === 'UNDER' ? 'PUT' : 'CALL'), // Mapper simples
                    'OPEN',
                  ]
                );

                // 2. Chamar serviço de cópia para execução imediata
                if (this.copyTradingService) {
                  await this.copyTradingService.replicateManualOperation(
                    state.userId,
                    {
                      contractId: contractId || '',
                      contractType: contractType,
                      symbol: symbol,
                      duration: 1,
                      durationUnit: 't',
                      stakeAmount: stakeAmount,
                      percent: percent,
                      entrySpot: entryPrice || 0,
                      entryTime: unixTimestamp,
                      barrier: (contractType === 'DIGITOVER' || contractType === 'DIGITUNDER') ? 3 : undefined,
                    },
                  );
                }
              }
            } catch (repError) {
              this.logger.error(`[ATLAS] Erro na replicação Master Trader (Entry):`, repError);
            }
          }
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

        this.logger.log(`[ATLAS][${symbol}] ${confirmedStatus} | User: ${state.userId} | P&L: ${formatCurrency(profit, state.currency)}`);

        await this.processAtlasResult(state, symbol, confirmedStatus === 'WON', stakeAmount, operation, profit, exitPrice, tradeId);

        if (confirmedStatus === 'WON' || confirmedStatus === 'LOST') {
          // ✅ [ATLAS] Master Trader Result Update
          try {
            const userMaster = await this.dataSource.query('SELECT trader_mestre FROM users WHERE id = ?', [state.userId]);
            if (userMaster && userMaster.length > 0 && userMaster[0].trader_mestre === 1 && this.copyTradingService) {
              const resMap = confirmedStatus === 'WON' ? 'win' : 'loss';
              await this.copyTradingService.updateCopyTradingOperationsResult(
                state.userId,
                contractId,
                resMap,
                profit,
                stakeAmount
              );
            }
          } catch (resError) {
            this.logger.error(`[ATLAS] Erro ao atualizar resultados do Copy Trading:`, resError);
          }
        }


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
   * ✅ ATLAS R_50: Geração de Sinal (Digits Even/Odd)
   */
  private generateDigitsSignal(state: AtlasUserState): 'EVEN' | 'ODD' | null {
    const mode = (state.mode || 'veloz').toLowerCase();

    // Configurações por modo
    let window = 12;
    let threshold = 3;

    if (mode === 'normal') {
      window = 25;
      threshold = 6;
    } else if (mode === 'preciso' || mode === 'lento') {
      window = 40;
      threshold = 9;
    }

    if (state.digitBuffer.length < window) return null;

    const slice = state.digitBuffer.slice(-window);
    const evens = slice.filter(d => d % 2 === 0).length;
    const odds = window - evens;

    const diff = Math.abs(evens - odds);
    if (diff < threshold) return null;

    return evens > odds ? 'EVEN' : 'ODD';
  }

  /**
   * ✅ ATLAS R_50: Cálculo de Stake (Ciclo de Recuperação + Meta + Soros)
   */
  private calculateStake(state: AtlasUserState, balance: number): number {
    // 1) Stake Base
    let stake = state.apostaInicial;
    const payoutEst = 0.80; // Ajuste conservador para garantir recuperação total sem sobras (User req)

    // 2) Ajuste para META (Sessão curta)
    const remainingTarget = (state.profitTarget || 0) - state.sessionProfit;
    if (!state.recovering && !state.isInSoros && state.profitTarget && remainingTarget > 0 && remainingTarget < (stake * payoutEst)) {
      stake = remainingTarget / payoutEst;
    }

    // 3) Ajuste para RECUPERAÇÃO (Ciclo)
    if (state.recovering) {
      const missing = state.recoveryTargetProfit - state.recoveryRecovered;
      if (missing <= 0) return state.apostaInicial;

      // Stake para recuperar o que falta
      stake = missing / payoutEst;
    }
    // 4) SOROS (Se não estiver recuperando)
    else if (state.isInSoros) {
      // Soros Nível 1: Stake Base + Último Lucro
      stake = state.apostaBase + state.ultimoLucro;
    }

    // 5) Bloqueios de Saldo
    if (stake > balance) {
      return balance;
    }

    // ✅ ATLAS: Respeitar Stop Blindado (Recalcular para proteger piso)
    if (state.blindadoActive && state.protectedFloor > 0) {
      const maxRisk = state.sessionProfit - state.protectedFloor;
      // Se stake calculada for maior que o risco permitido, reduzimos
      if (stake > maxRisk) {
        // Se maxRisk for negativo ou zero (já furou), deve parar, mas aqui retornamos 0 ou min 
        // para que a verificaçao de stop limits pare a IA na sequencia.
        stake = Math.max(0, maxRisk);
      }
    }

    // Normalizar dinheiro
    const currency = state.currency || 'USD';
    const minStake = getMinStakeByCurrency(currency);
    const decimals = ['BTC', 'ETH'].includes(currency.toUpperCase()) ? 8 : 2;

    return Math.max(minStake, Math.round(stake * Math.pow(10, decimals)) / Math.pow(10, decimals));
  }

  /**
   * ✅ ATLAS R_50: Iniciar Recuperação
   */
  private startRecovery(state: AtlasUserState) {
    state.recovering = true;
    // state.analysis = 'recuperacao'; // (Se tiver campo analysis no state)

    // Perdas acumuladas do ciclo (simplificado para sessionLoss se for o start agora, 
    // ou pegar da perdaAcumulada existente se o sistema antigo já somou)

    // O Spec diz: "perdas do ciclo, não da sessão inteira".
    // Aqui usamos state.perdaAcumulada que a logica de processResult já preenche.
    const currentLoss = state.perdaAcumulada > 0 ? state.perdaAcumulada : 0;

    state.recoveryLosses = currentLoss;

    // Perfil de Risco
    let pct = 0.02; // Conservador (2%)
    if (state.modoMartingale === 'moderado') pct = 0.15;
    if (state.modoMartingale === 'agressivo') pct = 0.30;

    state.recoveryTargetProfit = currentLoss * (1 + pct);
    state.recoveryRecovered = 0;

    this.logger.log(`[ATLAS] 🔄 Iniciando Recuperação (${state.modoMartingale}) | Alvo: ${state.recoveryTargetProfit.toFixed(2)} (Loss: ${currentLoss})`);
  }

  /**
   * ✅ ATLAS R_50: Finalizar Recuperação
   */
  private finishRecovery(state: AtlasUserState) {
    // Regra da pausa estratégica >= 5 perdas (usando consecutiveLosses como proxy do streak antes da recup)
    // O Spec diz "recuperar sequência >= 5 perdas".
    // Precisariamos rastrear quantas perdas levaram a essa recuperação.
    // Vamos usar state.recoveryLosses / stakeBase aprox ou apenas state.martingaleStep Max atingido.
    // Simplificação: Se martingaleStep chegou alto.

    // O spec usa consecutiveLosses.

    if (state.consecutiveLosses >= 5) {
      state.pauseUntilTs = Date.now() + 60000;
      this.saveAtlasLog(state.userId, state.symbol, 'alerta', `⚠️ Pausa Estratégica: Recuperação de sequência alta.`);
    }

    state.recovering = false;
    state.martingaleStep = 0;
    state.perdaAcumulada = 0;
    state.consecutiveLosses = 0;
    state.isInSoros = false;
    state.ultimoLucro = 0;

    // Reset mode (User Requirement: "Em caso de WIN, deve voltar para o modo VELOZ")
    const oldMode = state.mode;
    state.mode = 'veloz';

    this.logger.log(`[ATLAS] ✅ Recuperação Finalizada!`);

    const total = state.consecutiveWins + state.consecutiveLosses;
    const winRate = total > 0 ? (state.consecutiveWins / total) * 100 : 0;
    this.logModeEvaluation(state.userId, state.mode, winRate, 0);
  }


  private async executeAtlasTradeDirect(
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V',
    token: string,
    contractParams: any,
    onBuy?: (contractId: string, entryPrice: number) => Promise<void>
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
        currency: connection.authorizedCurrency || contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: contractParams.symbol,
      };

      // ✅ Adicionar barrier para contratos DIGITOVER/DIGITUNDER
      if (contractParams.contract_type === 'DIGITOVER' || contractParams.contract_type === 'DIGITUNDER') {
        proposalPayload.barrier = 2; // Dígito de comparação: > 2 (OVER) ou ≤ 2 (UNDER)
      }
      // ✅ DIGITEVEN/DIGITODD não usam barrier explicitamente (implícito na API)



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

        // ✅ ATLAS v3.1: Detectar token mismatch - quando DEMO é resolvido mas balance mostra valor baixo da conta Real
        const isInsufficientBalance = errorMessage.toLowerCase().includes('insufficient balance') || errorCode === 'InsufficientBalance';
        const reportedBalance = errorMessage.match(/balance \(([0-9.]+)/)?.[1];
        const reportedBalanceValue = reportedBalance ? parseFloat(reportedBalance) : null;

        // Se o erro é de saldo insuficiente e o saldo reportado é muito baixo (< $1), 
        // provavelmente o token está apontando para a conta errada (Real vs Demo)
        if (isInsufficientBalance && reportedBalanceValue !== null && reportedBalanceValue < 1.00) {
          this.logger.error(`[ATLAS][${symbol}] ⚠️ POSSÍVEL TOKEN MISMATCH: Esperava conta com saldo alto, mas API reportou ${formatCurrency(reportedBalanceValue, connection.authorizedCurrency || 'USD')}`);
          this.saveAtlasLog(userId, symbol, 'erro',
            `⚠️ ERRO DE CONFIGURAÇÃO DE CONTA\n` +
            `• O token salvo pode estar incorreto.\n` +
            `• Saldo reportado: ${formatCurrency(reportedBalanceValue, connection.authorizedCurrency || 'USD')}\n` +
            `• SOLUÇÃO: Reconecte sua conta Deriv nas Configurações.`);
        } else {
          this.saveAtlasLog(userId, symbol, 'erro',
            `❌ ERRO AO COMPRAR\n` +
            `• Código: ${errorCode}\n` +
            `• Mensagem: ${errorMessage}`);
        }
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[ATLAS][${symbol}] ❌ Contrato criado mas sem contract_id`);
        return null;
      }

      const buyDuration = Date.now() - buyStartTime;
      this.logger.log(`[ATLAS][${symbol}] ✅ Contrato criado | Proposal: ${proposalDuration}ms | Compra: ${buyDuration}ms | ContractId: ${contractId}`);

      const userState = this.atlasUsers.get(userId);
      this.logContractCreated(userId, {
        type: contractParams.contract_type,
        direction: userState?.ultimaDirecaoOp || 'N/A',
        stake: contractParams.amount,
        proposalId: proposalId,
        latency: proposalDuration + buyDuration
      });

      // ✅ Chamar callback onBuy IMEDIATAMENTE (Replication)
      if (onBuy) {
        onBuy(contractId, buyResponse.buy.entry_tick || buyResponse.buy.price).catch(err => {
          this.logger.error(`[ATLAS] Erro no callback onBuy: ${err.message}`);
        });
      }

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
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V',
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
    const currentPayout = isPriceAction ? 0.83 : modeConfig.payout;


    if (isWin) {
      const lucro = profit > 0 ? profit : (stakeAmount * currentPayout - stakeAmount);
      state.capital += lucro;
      state.totalProfitLoss += lucro;
      state.sessionProfit += lucro;

      state.consecutiveWins++;
      state.consecutiveLosses = 0;

      // ✅ [ATLAS R_50] Recuperação por Ciclo
      if (state.recovering) {
        state.recoveryRecovered += lucro;
        this.logger.log(`[ATLAS] Recuperação progresso: ${state.recoveryRecovered.toFixed(2)} / ${state.recoveryTargetProfit.toFixed(2)}`);

        if (state.recoveryRecovered >= state.recoveryTargetProfit) {
          this.finishRecovery(state);
        } else {
          this.logRecoveryPartial(state.userId, {
            recovered: state.recoveryRecovered,
            target: state.recoveryTargetProfit
          });
        }
      } else {
        // ✅ LÓGICA SOROS (Se não estiver recuperando)
        if (state.isInSoros) {
          // Ganhou a 2ª (Soros Nível 1) -> Resetar
          state.isInSoros = false;
          state.ultimoLucro = 0;

          this.logWinStreak(state.userId, {
            consecutiveWins: state.consecutiveWins,
            accumulatedProfit: state.sessionProfit,
            currentStake: state.ultimaApostaUsada
          });
        } else {
          // Ganhou a 1ª (Base) -> Ativar Soros
          state.isInSoros = true;
          state.ultimoLucro = lucro;
          this.logger.log(`[ATLAS] Soros ativado para próxima entrada (Lucro: ${lucro})`);

          this.logSorosActivation(state.userId, {
            previousProfit: lucro,
            stakeBase: state.apostaBase,
            level: 1
          });
        }

        // Pós-win: Sempre retorna para VELOZ (Doc v3.5: "Em caso de WIN, deve voltar para o modo VELOZ")
        state.mode = 'veloz';
        this.logger.log(`[ATLAS] Win detectado. Modo resetado para VELOZ conforme v3.5.`);

        const totalW = state.consecutiveWins + state.consecutiveLosses;
        const winRateW = totalW > 0 ? (state.consecutiveWins / totalW) * 100 : 0;
        this.logModeEvaluation(state.userId, state.mode, winRateW, state.consecutiveLosses);
      }

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
      state.sessionLoss += perda;

      state.consecutiveLosses++;
      state.consecutiveWins = 0;

      // Reset Soros se perder
      if (state.isInSoros) {
        state.isInSoros = false;
        state.ultimoLucro = 0;
      }

      // ✅ [ATLAS v3.5] Recuperação (após 2 perdas seguidas)
      if (!state.recovering) {
        if (state.consecutiveLosses >= 2) {
          // Degradação Progressiva de Modo
          if (state.mode === 'veloz') state.mode = 'normal';
          else if (state.mode === 'normal') state.mode = 'preciso';

          this.logger.log(`[ATLAS] 2 losses seguidos. Iniciando MODO RECUPERAÇÃO v3.5 (Modo atual: ${state.mode.toUpperCase()}).`);

          // Resetar perda acumulada do ciclo agora que iniciamos recuperação
          state.perdaAcumulada = state.sessionLoss; // Ou apenas as perdas do ciclo, aqui usamos sessionLoss para simplificar se for o desejado

          this.startRecovery(state);
        }
      } else {
        // Já em recuperação: Se perder, degrada modo se possível
        if (state.mode === 'veloz') state.mode = 'normal';
        else if (state.mode === 'normal') state.mode = 'preciso';

        this.logger.log(`[ATLAS] Loss em RECUPERAÇÃO. Degradando modo para ${state.mode.toUpperCase()}.`);

        // Atualizar alvo de recuperação
        state.recoveryTargetProfit += perda;
      }

      this.logTradeResultV2(state.userId, {
        status: 'LOSS',
        profit: -perda,
        stake: stakeAmount,
        balance: state.capital
      });
    }

    // ✅ [ZENIX v3.1] Lucro da SESSÃO (Recalculado após a trade)
    const lucroSessao = state.totalProfitLoss;

    // ✅ [STOP BLINDADO FIX] Atualizar profit_peak se lucro atual for maior
    // Isso é essencial para o Stop Blindado funcionar corretamente
    if (lucroSessao > 0) {
      await this.dataSource.query(
        `UPDATE ai_user_config 
         SET session_balance = ?, 
             profit_peak = GREATEST(COALESCE(profit_peak, 0), ?)
         WHERE user_id = ? AND is_active = 1`,
        [lucroSessao, lucroSessao, state.userId]
      ).catch(e => {
        this.logger.error(`[ATLAS] Erro ao atualizar session_balance e profit_peak:`, e);
      });

      this.logger.log(`[ATLAS] ✅ profit_peak atualizado: ${lucroSessao}, userId: ${state.userId}`);
    } else {
      // Se está em prejuízo, só atualizar session_balance
      await this.dataSource.query(
        `UPDATE ai_user_config SET session_balance = ? WHERE user_id = ? AND is_active = 1`,
        [lucroSessao, state.userId]
      ).catch(e => { });
    }

    // ✅ [DEBUG] Log antes de verificar limites
    this.logger.log(`[ATLAS] 📊 ANTES de checkAtlasLimits():
      userId: ${state.userId}
      lucroSessao: ${lucroSessao}
      totalProfitLoss: ${state.totalProfitLoss}
      isStopped: ${state.isStopped}`);

    // Verificar Limites (Meta, Stop Loss, Blindado)
    await this.checkAtlasLimits(state);

    if (isWin) {
      state.vitoriasConsecutivas += 1;
      this.logWinStreak(state.userId, {
        consecutiveWins: state.vitoriasConsecutivas,
        accumulatedProfit: state.totalProfitLoss,
        currentStake: stakeAmount
      });
    } else {
      state.vitoriasConsecutivas = 0;
    }

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
        `META DE LUCRO ATINGIDA
Status: Meta Alcançada
Lucro: ${formatCurrency(lucroAtual, state.currency)}
Meta: ${formatCurrency(profitTarget, state.currency)}
Ação: IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Meta de lucro atingida: +${formatCurrency(lucroAtual, state.currency)}`, state.userId],
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

      // ✅ [DEBUG] Log para rastrear valores
      this.logger.log(`[ATLAS] 🛡️ Verificando Stop Blind ado:
        profitPeak: ${profitPeak}
        activationThreshold: ${activationThreshold}
        profitTarget: ${profitTarget}
        lucroAtual: ${lucroAtual}
        capitalSessao: ${capitalSessao}
        capitalInicial: ${capitalInicial}`);

      if (profitTarget > 0 && profitPeak >= activationThreshold) {
        const factor = (parseFloat(config.stopBlindadoPercent) || 50.0) / 100;
        // ✅ Fixed Floor: Protect % of Activation Threshold, not Peak
        const valorProtegidoFixo = activationThreshold * factor;
        const stopBlindado = capitalInicial + valorProtegidoFixo;

        // ✅ [DEBUG] Log para rastrear cálculo do piso
        this.logger.log(`[ATLAS] 🛡️ Stop Blindado ATIVO:
          valorProtegidoFixo: ${valorProtegidoFixo}
          stopBlindado: ${stopBlindado}
          capitalSessao: ${capitalSessao}
          Vai parar? ${capitalSessao <= stopBlindado + 0.01}`);

        // ✅ [LOG] Notificar ativação do Stop Blindado (primeira vez)
        // Só loga se o profit_peak acabou de passar o limiar (evita spam)
        // ✅ [LOG] Notificar ativação do Stop Blindado (primeira vez)
        // Só loga se o profit_peak acabou de passar o limiar (evita spam)
        const justActivated = profitPeak >= activationThreshold && profitPeak < (activationThreshold + 0.50);
        if (justActivated && !state.blindadoActive) {
          state.blindadoActive = true;
          state.protectedFloor = valorProtegidoFixo;
          this.saveAtlasLog(state.userId, symbol, 'info',
            `🛡️ STOP BLINDADO ATIVADO
Status: Proteção de Lucro Ativa
Lucro Atual: ${formatCurrency(lucroAtual, state.currency)}
Piso Protegido: ${formatCurrency(valorProtegidoFixo, state.currency)}
Percentual: ${config.stopBlindadoPercent}%
Ação: monitorando para proteger ganhos`
          );
        }

        if (capitalSessao <= stopBlindado + 0.01) { // Added tolerance again just in case
          const lucroFinal = capitalSessao - capitalInicial;
          this.saveAtlasLog(state.userId, symbol, 'info',
            `STOP BLINDADO ATINGIDO
Status: Lucro Protegido
Lucro Protegido: ${formatCurrency(lucroFinal, state.currency)}
Ação: IA DESATIVADA`
          );

          await this.dataSource.query(
            `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop Blindado: +${formatCurrency(lucroFinal, state.currency)}`, state.userId],
          );

          // ✅ [DEBUG] Confirmar que UPDATE foi executado
          this.logger.warn(`[ATLAS] 🛡️ STOP BLINDADO - UPDATE executado! session_status = 'stopped_blindado', userId: ${state.userId}`);

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

          // ✅ [FIX] Log final e RETURN imediatamente
          this.logger.warn(`[ATLAS] 🛡️ STOP BLINDADO - IA parada, saindo de checkAtlasLimits()...`);
          return;
        }
      }
    }

    // 3. Stop Loss Normal
    // ✅ [FIX] Verificar se IA já foi parada antes
    if (state.isStopped) {
      this.logger.log(`[ATLAS] ⏸️ IA já foi parada, ignorando verificação de Stop Loss Normal`);
      return;
    }
    const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
    if (lossLimit > 0 && perdaAtual >= lossLimit) {
      this.saveAtlasLog(state.userId, symbol, 'alerta',
        `STOP LOSS ATINGIDO
Status: Limite de Perda
Perda: ${formatCurrency(perdaAtual, state.currency)}
Limite: ${formatCurrency(lossLimit, state.currency)}
Ação: IA DESATIVADA`
      );

      await this.dataSource.query(
        `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Stop Loss atingido: -${formatCurrency(perdaAtual, state.currency)}`, state.userId],
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
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V';
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
    const minStake = getMinStakeByCurrency(params.currency);
    const apostaInicial = params.apostaInicial || minStake;

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

      // ✅ ATLAS R_50 Init
      consecutiveLosses: 0,
      consecutiveWins: 0,
      sessionProfit: 0,
      sessionLoss: 0,
      recovering: false,
      recoveryLosses: 0,
      recoveryTargetProfit: 0,
      recoveryRecovered: 0,
      protectedFloor: 0,
      pauseUntilTs: 0,
      recoveredFromLossStreak: 0
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
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V';
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
    symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V' | 'SISTEMA',
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
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `INÍCIO DE SESSÃO DIÁRIA
Título: Início de Sessão
Estratégia: ATLAS 3.5
Saldo Inicial: ${formatCurrency(state?.capital || 0, currency)}
Meta de Lucro: ${config.profitTarget > 0 ? formatCurrency(config.profitTarget, currency) : 'N/A'}
Stop Loss: ${config.stopLoss > 0 ? formatCurrency(config.stopLoss, currency) : 'N/A'}
Símbolo: ${state?.symbol || 'N/A'}
Modo Inicial: ${config.operationMode.toUpperCase()}
Ação: iniciar coleta de dados`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logSessionStart(userId: string, session: {
    date: Date;
    initialBalance: number;
    profitTarget: number;
    stopLoss: number;
    mode: string;
    strategyName: string;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `INÍCIO DE SESSÃO
Título: Início de Sessão
Saldo Inicial: ${formatCurrency(session.initialBalance, currency)}
Meta de Lucro: ${formatCurrency(session.profitTarget, currency)}
Stop Loss: ${formatCurrency(session.stopLoss, currency)}
Estratégia: ATLAS
Símbolo: ${state?.symbol || '1HZ100V'}
Modo Inicial: ${session.mode.toUpperCase()}
Ação: iniciar coleta de dados`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logDataCollection(userId: string, data: {
    targetCount: number;
    currentCount: number;
    mode?: string;
  }) {
    const message = `COLETA DE DADOS
Título: Coleta de Dados em Andamento
Meta de Coleta: ${data.targetCount} ticks
Progresso: ${data.currentCount} / ${data.targetCount}
Status: aguardando ticks suficientes
Ação: aguardar coleta mínima`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logAnalysisStarted(userId: string, mode: string) {
    const message = `ANÁLISE INICIADA
Título: Análise de Mercado
Tipo de Análise: PRINCIPAL
Modo Ativo: ${mode.toUpperCase()}
Contrato Avaliado: Digits Over 3 (1 tick)
Objetivo: identificar sinal válido`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logModeEvaluation(userId: string, mode: string, winRate: number, losses: number) {
    const message = `AVALIAÇÃO DE MODO
Título: Avaliação de Modo
Modo Atual: ${mode.toUpperCase()}
Win Rate Local: ${winRate.toFixed(1)}%
Perdas Consecutivas: ${losses}
Decisão: manter modo`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logContractCreated(userId: string, contract: {
    type: string;
    direction: string;
    stake: number;
    proposalId: string;
    latency: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `CONTRATO CRIADO
Título: Contrato Criado
Contrato: ${contract.type} (1 tick)
Direção: ${contract.direction}
Stake: ${formatCurrency(contract.stake, currency)}
Proposal ID: ${contract.proposalId}
Latência de Criação: ${contract.latency} ms
Ação: aguardar execução`;

    this.saveAtlasLog(userId, 'SISTEMA', 'operacao', message);
  }

  private logExecutionConfirmed(userId: string, execution: {
    contractId: string;
    latency: number;
    entryPrice: number;
  }) {
    const message = `EXECUÇÃO CONFIRMADA
Título: Execução Confirmada
Contrato ID: ${execution.contractId}
Tempo de Execução: ${execution.latency} ms
Preço de Entrada: ${execution.entryPrice}
Status: contrato ativo`;

    this.saveAtlasLog(userId, 'SISTEMA', 'operacao', message);
  }

  private logSignalGenerated(userId: string, signal: {
    mode: string;
    isRecovery: boolean;
    filters: string[];
    trigger: string;
    probability: number;
    contractType: string;
    direction?: 'CALL' | 'PUT' | string;
    stake?: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `SINAL GERADO
Título: Sinal de Entrada
Análise: ${signal.isRecovery ? 'RECUPERAÇÃO' : 'PRINCIPAL'}
Modo: ${signal.mode.toUpperCase()}
Direção: ${signal.direction || 'N/A'}
Força do Sinal: ${signal.probability}%
Contrato: ${signal.contractType} (1 tick)
Stake Calculada: ${formatCurrency(signal.stake || state?.ultimaApostaUsada || 0, currency)}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'sinal', message);
  }

  private logTradeResultV2(userId: string, result: {
    status: 'WIN' | 'LOSS';
    profit: number;
    stake: number;
    balance: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';

    if (result.status === 'WIN') {
      const message = `RESULTADO — WIN
Título: Resultado da Operação
Status: WIN
Direção: ${state?.ultimaDirecaoOp || 'CALL'}
Contrato: Digits Over 3 (1 tick)
Resultado Financeiro: +${formatCurrency(result.profit, currency)}
Saldo Atual: ${formatCurrency(result.balance, currency)}`;
      this.saveAtlasLog(userId, 'SISTEMA', 'vitoria', message);
    } else {
      const message = `RESULTADO — LOSS
Título: Resultado da Operação
Status: LOSS
Direção: ${state?.ultimaDirecaoOp || 'CALL'}
Contrato: Digits Over 3 (1 tick)
Resultado Financeiro: -${formatCurrency(Math.abs(result.profit), currency)}
Saldo Atual: ${formatCurrency(result.balance, currency)}`;
      this.saveAtlasLog(userId, 'SISTEMA', 'derrota', message);
    }
  }

  private logMartingaleLevelV2(userId: string, martingale: {
    level: number;
    lossNumber: number;
    accumulatedLoss: number;
    calculatedStake: number;
    profitPercentage: number;
    contractType: string;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `NÍVEL DE MARTINGALE
Título: Recuperação Ativa
Nível Atual: M${martingale.level}
Multiplicador: ${(martingale.calculatedStake / (state?.apostaInicial || 1)).toFixed(1)}x
Próxima Stake: ${formatCurrency(martingale.calculatedStake, currency)}
Limite Máximo: M12`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logSorosActivation(userId: string, soros: {
    previousProfit: number;
    stakeBase: number;
    level?: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const level = soros.level || 1;
    const newStake = soros.stakeBase + soros.previousProfit;

    const message = `SOROS NÍVEL ${level}
Título: Soros Nível ${level} Aplicado
Lucro Anterior: +${formatCurrency(soros.previousProfit, currency)}
Stake Base: ${formatCurrency(soros.stakeBase, currency)}
Nova Stake: ${formatCurrency(newStake, currency)}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'vitoria', message);
  }

  private logWinStreak(userId: string, streak: {
    consecutiveWins: number;
    accumulatedProfit: number;
    currentStake: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `SEQUÊNCIA DE VITÓRIAS
Título: Sequência Positiva Detectada
Vitórias Consecutivas: ${streak.consecutiveWins}
Lucro Acumulado: +${formatCurrency(streak.accumulatedProfit, currency)}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'vitoria', message);
  }

  private logSuccessfulRecoveryV2(userId: string, recovery: {
    recoveredLoss: number;
    additionalProfit: number;
    profitPercentage: number;
    stakeBase: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `RECUPERAÇÃO CONCLUÍDA
Título: Recuperação Finalizada
Alvo Atingido: ${formatCurrency(recovery.recoveredLoss + recovery.additionalProfit, currency)}
Saldo Atual: ${formatCurrency(state?.capital || 0, currency)}
Ação: reset para análise principal`;

    this.saveAtlasLog(userId, 'SISTEMA', 'resultado', message);
  }

  private logRecoveryPartial(userId: string, recovery: {
    recovered: number;
    target: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `RECUPERAÇÃO PARCIAL
Título: Recuperação Parcial
Recuperado até agora: +${formatCurrency(recovery.recovered, currency)}
Falta para concluir: ${formatCurrency(recovery.target - recovery.recovered, currency)}
Ação: recalcular stake`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logRecoveryStarted(userId: string, recovery: {
    accumulatedLoss: number;
    target: number;
    riskProfile: string;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `INÍCIO DA RECUPERAÇÃO
Título: Entrada em Recuperação
Perfil de Risco: ${recovery.riskProfile.toUpperCase()}
Perdas Acumuladas: -${formatCurrency(recovery.accumulatedLoss, currency)}
Alvo de Recuperação: ${formatCurrency(recovery.target, currency)}
Contrato: Rise/Fall (1 tick)`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logConservativeReset(userId: string, reset: {
    stakeBase: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `LIMITE DE SEGURANÇA
Limite Conservador Atingido
Ação: Resetando para Stake Base
Nova Stake: ${formatCurrency(reset.stakeBase, currency)}
Status: Proteção Ativada`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logAnalysisSwitch(userId: string, from: string, to: string, reason: string) {
    const message = `TROCA DE ANÁLISE
Título: Troca de Análise
Análise Anterior: ${from.toUpperCase()}
Nova Análise: ${to.toUpperCase()}
Motivo: ${reason}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logContractSwitch(userId: string, from: string, to: string, reason: string) {
    const message = `TROCA DE CONTRATO
Título: Troca de Contrato
Contrato Anterior: ${from}
Contrato Atual: ${to}
Motivo: ${reason}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  } private logStrategicPause(userId: string, phase: 'AVALIADA' | 'ATIVADA' | 'ENCERRADA', details: string) {
    const message = `PAUSA ESTRATÉGICA
Título: Pausa Estratégica (${phase})
Status: ${phase === 'AVALIADA' ? 'em análise' : phase === 'ATIVADA' ? 'suspensão temporária' : 'retomando operações'}
Motivo: ${details}
Ação: ${phase === 'ENCERRADA' ? 'voltar à análise' : 'aguardar resfriamento'}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logBlockedEntry(userId: string, reason: string, type: 'FILTRO' | 'ESTADO') {
    const message = `ENTRADA BLOQUEADA — ${type}
Título: Operação Bloqueada
Motivo: ${reason}
Fator: ${type === 'FILTRO' ? 'critério técnico' : 'gerenciamento de risco'}
Ação: aguardar próxima janela`;

    this.saveAtlasLog(userId, 'SISTEMA', 'alerta', message);
  }

  private logStateReset(userId: string, reason: string) {
    const message = `RESET DE ESTADO
Título: Reinicialização de Ciclo
Motivo: ${reason}
Status: dados limpos
Ação: reiniciar monitoramento`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private logSessionEnd(userId: string, summary: {
    result: 'PROFIT' | 'LOSS' | 'STOP_LOSS' | 'TAKE_PROFIT';
    totalProfit: number;
    trades: number;
  }) {
    const state = this.atlasUsers.get(userId);
    const currency = state?.currency || 'USD';
    const message = `ENCERRAMENTO DE SESSÃO
Título: Sessão Finalizada
Resultado Global: ${formatCurrency(summary.totalProfit, currency)}
Total de Entradas: ${summary.trades}
Status Final: ${summary.result.replace('_', ' ')}`;

    this.saveAtlasLog(userId, 'SISTEMA', 'analise', message);
  }

  private async saveAtlasLogsBatch(
    userId: string,
    logs: Array<{
      userId?: string;
      symbol: 'R_10' | 'R_25' | 'R_50' | 'R_100' | '1HZ10V' | '1HZ100V' | 'SISTEMA';
      type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'vitoria' | 'derrota' | 'alerta' | 'erro';
      message: string;
      details?: any;
    }>,
  ): Promise<void> {
    if (logs.length === 0) return;

    try {
      const icons = {
        info: 'ℹ️',
        tick: '⏱️',
        analise: '🔍',
        sinal: '🟢',
        operacao: '🚀',
        resultado: '📊',
        vitoria: '✅',
        derrota: '❌',
        alerta: '⚠️',
        erro: '🚨',
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
    authorizedCurrency: string | null;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    const existing = this.wsConnections.get(token);
    if (existing && existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
      return {
        ws: existing.ws,
        authorizedCurrency: existing.authorizedCurrency,
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
      authorizedCurrency: null as string | null,
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
            const isAppIdError = errorMsg.includes('app ID') || msg.error?.code === 'AppIdInvalid';

            if (isAppIdError) {
              this.logger.error(`[ATLAS][${symbol || 'POOL'}] ❌ Token Inválido: O token não pertence ao APP_ID atual.`);
              if (userId) {
                this.saveAtlasLog(
                  userId,
                  'SISTEMA',
                  'erro',
                  `❌ ERRO DE AUTENTICAÇÃO: Os tokens atuais não são válidos para o novo APP_ID configurado. Por favor, reconecte sua conta Deriv nas configurações para gerar novos tokens.`
                );
              }
            } else {
              this.logger.error(`[ATLAS][${symbol || 'POOL'}] ❌ Erro na autorização: ${errorMsg}`);
            }

            socket.close();
            this.wsConnections.delete(token);
            if (authPromiseReject) {
              authPromiseReject(new Error(errorMsg));
            }
            return;
          }

          conn.authorized = true;
          conn.authorizedCurrency = msg.authorize?.currency || null;
          this.logger.log(`[ATLAS][${symbol || 'POOL'}] ✅ Autorizado | Moeda: ${conn.authorizedCurrency}`);

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

        // ✅ Processar respostas de requisições (ROTEAMENDO POR REQ_ID) - PRIORIDADE 2
        const msgReqId = msg.req_id ? Number(msg.req_id) : null;
        if (msgReqId !== null && conn.pendingRequests.has(msgReqId)) {
          const pending = conn.pendingRequests.get(msgReqId);
          if (pending) {
            clearTimeout(pending.timeout);
            conn.pendingRequests.delete(msgReqId);
            if (msg.error) {
              pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              pending.resolve(msg);
            }
          }
          return;
        }

        // ✅ FALLBACK: Processar por tipo se não tiver reqId (Apenas para garantir compatibilidade)
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
      authorizedCurrency: conn.authorizedCurrency,
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
      // ✅ Deriv API req_id deve ser um INTEIRO (1 a 2^31 - 1)
      const requestId = ++conn.requestIdCounter;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });

      // ✅ [ZENIX v3.0] Injetar req_id E passthrough para redundância de roteamento
      const finalPayload = {
        ...payload,
        req_id: requestId,
        passthrough: {
          ...payload.passthrough,
          req_id: requestId
        }
      };
      conn.ws.send(JSON.stringify(finalPayload));
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

  /**
   * ✅ ATLAS v3.2: Resolve token com ESTRITA observância da conta selecionada (Demo vs Real)
   * NUNCA faz fallback entre contas para evitar operar na conta errada.
   */
  private async resolveDerivToken(userId: string, fallbackToken: string): Promise<{ token: string; currency: string; isVirtual: boolean } | null> {
    try {
      // 1. Buscar configurações do usuário e dados raw
      const userResult = await this.dataSource.query(
        `SELECT u.deriv_raw, s.trade_currency 
         FROM users u
         LEFT JOIN user_settings s ON u.id = s.user_id
         WHERE u.id = ?`,
        [userId]
      );

      if (!userResult || userResult.length === 0) {
        this.logger.warn(`[ATLAS][ResolveToken] Usuário não encontrado: ${userId}`);
        return null;
      }

      const row = userResult[0];
      const userPreferredCurrency = (row.trade_currency || 'USD').toUpperCase();
      const wantsDemo = userPreferredCurrency === 'DEMO';

      if (!row.deriv_raw) {
        this.logger.warn(`[ATLAS][ResolveToken] deriv_raw não encontrado para user ${userId}`);
        // Se não temos dados para validar, não arriscamos usar token antigo cego.
        return null;
      }

      let derivRaw: any;
      try {
        derivRaw = typeof row.deriv_raw === 'string'
          ? JSON.parse(row.deriv_raw)
          : row.deriv_raw;
      } catch (e) {
        this.logger.error(`[ATLAS][ResolveToken] Erro ao parsear deriv_raw`, e);
        return null;
      }

      // Buscar Tokens por loginid
      const tokens = derivRaw.tokensByLoginId || {};
      let targetToken = '';
      let foundLoginId = '';
      let isVirtual = false;

      for (const [loginid, tokenValue] of Object.entries(tokens)) {
        const isDemoAccount = loginid.toUpperCase().startsWith('VRTC');

        if (wantsDemo && isDemoAccount) {
          targetToken = tokenValue as string;
          foundLoginId = loginid;
          isVirtual = true;
          break;
        } else if (!wantsDemo && !isDemoAccount) {
          targetToken = tokenValue as string;
          foundLoginId = loginid;
          isVirtual = false;
          // Se houver múltiplas contas reais, geralmente pegamos a primeira (USD/BRL)
          break;
        }
      }

      if (targetToken) {
        let resolvedCurrency = 'USD';
        let balance = 0;

        if (isVirtual) {
          const demoBalances = derivRaw.balancesByCurrencyDemo || {};
          const demoCurrencies = Object.keys(demoBalances);
          if (demoCurrencies.length > 0) {
            resolvedCurrency = demoCurrencies[0]; // Pega a primeira moeda encontrada (ex: 'USD', 'EUR', 'GBP')
          }
          balance = demoBalances[resolvedCurrency] || 0;
        } else {
          // Para conta Real, tentamos usar a preferência do usuário se for uma moeda válida
          // Se userPreferredCurrency for 'DEMO' (impossível aqui) ou inválido, tentamos pegar do saldo
          const realBalances = derivRaw.balancesByCurrencyReal || {};
          const realCurrencies = Object.keys(realBalances);

          if (userPreferredCurrency !== 'DEMO' && realCurrencies.includes(userPreferredCurrency)) {
            resolvedCurrency = userPreferredCurrency;
          } else if (realCurrencies.length > 0) {
            resolvedCurrency = realCurrencies[0];
          }
          balance = realBalances[resolvedCurrency] || 0;
        }

        this.logger.debug(`[ATLAS][ResolveToken] ✅ Conta Resolvida: ${foundLoginId} (${isVirtual ? 'DEMO' : 'REAL'}) | Moeda: ${resolvedCurrency} | Saldo Cache: $${balance}`);
        return { token: targetToken, currency: resolvedCurrency, isVirtual };
      }

      // ❌ Se chegou aqui, não existe token para o tipo de conta desejado
      const tipoDesejado = wantsDemo ? 'DEMO' : 'REAL';
      this.logger.error(`[ATLAS][ResolveToken] ❌ Token ${tipoDesejado} não encontrado para user ${userId}`);

      this.saveAtlasLog(userId, 'SISTEMA', 'erro',
        `❌ CONTA NÃO ENCONTRADA\n` +
        `• Você selecionou conta ${tipoDesejado}, mas não há login válido para ela.\n` +
        `• Ação: Vá em Configurações > Deriv e reconecte sua conta.`);

      return null;

    } catch (error) {
      this.logger.error(`[ATLAS][ResolveToken] ❌ Erro na resolução:`, error);
      return null;
    }
  }
}