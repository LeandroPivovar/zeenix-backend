import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import WebSocket from 'ws';
import {
  IAutonomousAgentStrategy,
  AutonomousAgentConfig,
  AutonomousAgentState,
  MarketAnalysis,
  TradeDecision,
} from './common.types';
import { Tick, DigitParity } from '../../ai/ai.service';
import { LogQueueService } from '../../utils/log-queue.service';

/**
 * 🦅 FALCON Strategy para Agente Autônomo - Versão 2.1
 * 
 * CORE: Price Action (Trend + Volatility/Delta)
 * - MODO NORMAL: Janela 7 ticks, 4/6 moves, delta >= 0.5. WR esperado ~76%.
 * - MODO LENTO: Janela 8 ticks, 5/7 moves, delta >= 0.7. WR esperado ~90%.
 * - Gestão: Soros Nível 1 no Normal, Smart Martingale no Lento.
 * - Proteção: Stop Blindado (40% meta ativa, proteção fixa de 50%).
 */

const FALCON_MODES = {
  PRECISO: {
    name: 'PRECISO',
    windowSize: 9,
    requiredMovements: 6,
    totalMovements: 8,
    minDelta: 0.7,
    lastTicks: 3,
    minStrength: 0.0065, // 0.65%
    maxVolatility: 0.15,
  },
  ULTRA: {
    name: 'ULTRA PRECISO',
    windowSize: 10,
    requiredMovements: 7,
    totalMovements: 9,
    minDelta: 0.8,
    lastTicks: 4,
    minStrength: 0.007,
    maxVolatility: 0.15,
  },
  HIPER: {
    name: 'HIPER PRECISO',
    windowSize: 11,
    requiredMovements: 8,
    totalMovements: 10,
    minDelta: 0.9,
    lastTicks: 5,
    minStrength: 0.0075,
    maxVolatility: 0.15,
  },
};

const FALCON_V21_RISK = {
  CONSERVADOR: { profitFactor: 1.0, maxMartingale: 5 },
  MODERADO: { profitFactor: 1.15, maxMartingale: -1 }, // Sem limite
  AGRESSIVO: { profitFactor: 1.30, maxMartingale: -1 }, // Sem limite
};
@Injectable()
export class FalconStrategy implements IAutonomousAgentStrategy, OnModuleInit {
  name = 'falcon';
  displayName = '🦅 FALCON';
  description = 'Agente de alta precisão com recuperação inteligente e gestão blindada';

  private readonly logger = new Logger(FalconStrategy.name);
  private readonly userConfigs = new Map<string, FalconUserConfig>();
  private readonly userStates = new Map<string, FalconUserState>();
  private readonly ticks = new Map<string, Tick[]>();
  private readonly maxTicks = 200;
  private readonly comissaoPlataforma = 0.03; // 3%
  private readonly processingLocks = new Map<string, boolean>(); // ✅ Lock para evitar processamento simultâneo
  private readonly appId: string;

  // ✅ Pool de conexões WebSocket por token (reutilização - uma conexão por token)
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

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async onModuleInit() {
    this.logger.log('🦅 FALCON Strategy inicializado');
    await this.initialize();
  }

  async initialize(): Promise<void> {
    await this.syncActiveUsersFromDb();
  }

  /**
   * Sincroniza usuários ativos do banco de dados
   */
  private async syncActiveUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT 
            c.user_id, c.initial_stake, c.daily_profit_target, c.daily_loss_limit, 
            c.initial_balance, c.deriv_token as config_token, c.currency, c.symbol, c.agent_type,
            u.token_demo, u.token_real, u.deriv_raw,
            s.trade_currency
         FROM autonomous_agent_config c
         JOIN users u ON c.user_id = u.id
         LEFT JOIN user_settings s ON c.user_id = s.user_id
         WHERE c.is_active = TRUE 
           AND c.agent_type = 'falcon'
           AND c.session_status NOT IN ('stopped_profit', 'stopped_loss', 'stopped_blindado')`,
      );

      for (const user of activeUsers) {
        const userId = user.user_id.toString();

        // ✅ [RESOLUÇÃO DE TOKEN CENTRALIZADA]
        // Prioridade: 1. Preferência (user_settings) -> 2. Colunas Específicas (users) -> 3. Parsing Raw -> 4. Config Antiga
        let resolvedToken = user.config_token;
        const wantDemo = user.trade_currency === 'DEMO';

        if (wantDemo) {
          if (user.token_demo) {
            resolvedToken = user.token_demo;
          } else if (user.deriv_raw) {
            // Fallback: Tentar extrair token VRTC do JSON raw
            try {
              const raw = typeof user.deriv_raw === 'string' ? JSON.parse(user.deriv_raw) : user.deriv_raw;
              if (raw.tokensByLoginId) {
                const entry = Object.entries(raw.tokensByLoginId).find(([lid]) => (lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              }
            } catch (e) {
              this.logger.warn(`[Falcon][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token: ${e.message}`);
            }
          }
        } else {
          // Real Account
          if (user.token_real) {
            resolvedToken = user.token_real;
          } else if (user.deriv_raw) {
            // Fallback: Tentar extrair token Real (não-VRTC) do JSON raw
            try {
              const raw = typeof user.deriv_raw === 'string' ? JSON.parse(user.deriv_raw) : user.deriv_raw;
              if (raw.tokensByLoginId) {
                const entry = Object.entries(raw.tokensByLoginId).find(([lid]) => !(lid as string).startsWith('VRTC'));
                if (entry) resolvedToken = entry[1] as string;
              }
            } catch (e) {
              this.logger.warn(`[Falcon][${userId}] Erro ao fazer parsing do deriv_raw para fallback de token (Real): ${e.message}`);
            }
          }
        }

        // Log para debug da resolução
        if (resolvedToken !== user.config_token) {
          this.logger.log(`[Falcon][ResolucaoToken] User ${userId}: Token atualizado dinamicamente. Modo=${wantDemo ? 'DEMO' : 'REAL'}.`);
        } else {
          // Se for igual, ainda assim pode ser que o config_token esteja certo, mas bom logar se estivermos inconsistentes
          // Mas para não floodar, deixamos quieto se não houve mudança.
        }

        const config: FalconUserConfig = {
          userId: userId,
          initialStake: parseFloat(user.initial_stake),
          dailyProfitTarget: parseFloat(user.daily_profit_target),
          dailyLossLimit: parseFloat(user.daily_loss_limit),
          derivToken: resolvedToken, // ✅ Usa o token resolvido
          currency: user.currency,
          symbol: 'R_100',
          initialBalance: parseFloat(user.initial_balance) || 0,
          stopLossType: 'normal',
          riskProfile: 'MODERADO',
        };

        this.userConfigs.set(userId, config);
        this.initializeUserState(userId, config);
      }

      this.logger.log(`[Falcon] Sincronizados ${activeUsers.length} usuários ativos`);
    } catch (error) {
      this.logger.error('[Falcon] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Inicializa estado do usuário
   */
  private initializeUserState(userId: string, config: FalconUserConfig): void {
    const state: FalconUserState = {
      userId,
      isActive: true,
      saldoInicial: config.initialBalance,
      lucroAtual: 0,
      picoLucro: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      opsCount: 0,
      mode: 'PRECISO',
      stopBlindadoAtivo: false,
      pisoBlindado: 0,
      lastProfit: 0,
      martingaleLevel: 0,
      sorosLevel: 0,
      totalLosses: 0,
      recoveryAttempts: 0,
      totalLossAccumulated: 0,
      currentContractId: null,
      currentTradeId: null,
      isWaitingContract: false,
      lastContractType: undefined,
      ticksSinceLastAnalysis: 0,
      lastSignals: [],
      consecutiveLossesSinceModeChange: 0,
    };

    this.userStates.set(userId, state);
    this.ticks.set(userId, []);
  }

  async activateUser(userId: string, config: AutonomousAgentConfig): Promise<void> {
    const falconConfig: FalconUserConfig = {
      userId: config.userId,
      initialStake: config.initialStake,
      dailyProfitTarget: config.dailyProfitTarget,
      dailyLossLimit: config.dailyLossLimit,
      derivToken: config.derivToken,
      currency: config.currency,
      symbol: 'R_100',
      initialBalance: config.initialBalance || 0,
      stopLossType: (config as any).stopLossType || 'normal',
      riskProfile: (config as any).riskProfile || 'MODERADO',
    };

    // ✅ Proteção contra reset de estado pelo Sync (5min)
    if (this.userConfigs.has(userId)) {
      this.logger.log(`[Falcon][${userId}] 🔄 Atualizando configuração (Usuário já ativo).`);
      this.userConfigs.set(userId, falconConfig);

      // Apenas garantir que está ativo (se não estiver pausado por stop)
      // Mas se estiver pausado na memória, não deveríamos reativar?
      // O syncActiveUsersFromDb FILTRA os stopped. Se chegou aqui, é porque deve estar ativo.
      // E se foi um "Start" manual? Deve resetar?
      // Se for start manual, o controller provavelmente chamou deactivate antes? Não.
      // Vamos assumir que se chamou activateUser, é para estar ativo.
      const state = this.userStates.get(userId);
      if (state && !state.isActive) {
        // Se estava inativo em memória, reativar flag (ex: reinício de servidor após pausa?)
        // Mas cuidado com o stop do dia. 
        // Se o sync chamou, o status não é stopped. Então pode reativar.
        state.isActive = true;
      }
      return;
    }

    this.userConfigs.set(userId, falconConfig);
    this.initializeUserState(userId, falconConfig);

    // ✅ PRÉ-AQUECER conexão WebSocket para evitar erro "Conexão não está pronta"
    try {
      this.logger.log(`[Falcon][${userId}] 🔌 Pré-aquecendo conexão WebSocket...`);
      await this.warmUpConnection(falconConfig.derivToken);
      this.logger.log(`[Falcon][${userId}] ✅ Conexão WebSocket pré-aquecida e pronta`);
    } catch (error: any) {
      this.logger.warn(`[Falcon][${userId}] ⚠️ Erro ao pré-aquecer conexão (continuando mesmo assim):`, error.message);
    }

    // ✅ Obter modo do estado (inicializado como 'NORMAL')
    const state = this.userStates.get(userId);
    const mode = state?.mode || 'NORMAL';

    // ✅ Log de ativação no padrão Orion
    this.logInitialConfigV2(userId, {
      agentName: 'FALCON',
      operationMode: mode,
      riskProfile: falconConfig.riskProfile || 'MODERADO',
      profitTarget: falconConfig.dailyProfitTarget,
      stopLoss: falconConfig.dailyLossLimit,
      stopBlindadoEnabled: falconConfig.stopLossType === 'blindado'
    });

    this.logSessionStart(userId, {
      date: new Date(),
      initialBalance: falconConfig.initialBalance,
      profitTarget: falconConfig.dailyProfitTarget,
      stopLoss: falconConfig.dailyLossLimit,
      mode: mode,
      agentName: 'FALCON'
    });

    this.logger.log(`[Falcon] ✅ Usuário ${userId} ativado | Symbol: ${falconConfig.symbol} | Total configs: ${this.userConfigs.size}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.userConfigs.delete(userId);
    this.userStates.delete(userId);
    this.ticks.delete(userId);
    this.logger.log(`[Falcon] ✅ Usuário ${userId} desativado`);
  }

  /**
   * Processa um tick recebido
   */
  async processTick(tick: Tick, symbol?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    const tickSymbol = symbol || 'R_100'; // ✅ Todos os agentes autônomos usam R_100

    // ✅ Log de debug para verificar se está recebendo ticks
    // ✅ Log de debug para verificar se está recebendo ticks (Logar SEMPRE para debug)
    // if (this.userConfigs.size > 0) {
    this.logger.debug(`[Falcon] 📥 Tick recebido: symbol=${tickSymbol}, value=${tick.value}, users=${this.userConfigs.size}`);
    // }

    // ✅ Processar para todos os usuários ativos (sempre R_100, ignorar símbolo do banco se for R_75)
    for (const [userId, config] of this.userConfigs.entries()) {
      // Sempre processar se o tick for R_100 (todos os agentes autônomos usam R_100)
      if (tickSymbol === 'R_100') {
        promises.push(this.processTickForUser(userId, tick).catch((error) => {
          this.logger.error(`[Falcon][${userId}] Erro ao processar tick:`, error);
        }));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Processa tick para um usuário específico
   */
  private async processTickForUser(userId: string, tick: Tick): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || !state.isActive) {
      return;
    }

    // ✅ Verificar lock de processamento (evitar múltiplas análises simultâneas)
    if (this.processingLocks.get(userId)) {
      return; // Já está processando, ignorar este tick
    }

    // Se está aguardando resultado de contrato, não processar novos ticks
    if (state.isWaitingContract) {
      return;
    }

    // Adicionar tick à coleção
    const userTicks = this.ticks.get(userId) || [];
    userTicks.push(tick);

    // Manter apenas os últimos maxTicks
    if (userTicks.length > this.maxTicks) {
      userTicks.shift();
    }
    this.ticks.set(userId, userTicks);

    // ✅ Verificar novamente se está aguardando resultado (pode ter mudado durante coleta de ticks)
    if (state.isWaitingContract) {
      return;
    }

    // ✅ TICK ADVANCE LÓGICA
    // Incrementa contador de ticks sem análise
    state.ticksSinceLastAnalysis = (state.ticksSinceLastAnalysis || 0) + 1;

    // Verificar se precisa avançar (skip) ticks
    // Normal: Avanço de 2 ticks (só analisa no 3º)
    // Lento: Avanço de 3 ticks (só analisa no 4º)
    const requiredSkip = state.mode === 'PRECISO' ? 2 : 3;

    if (state.ticksSinceLastAnalysis <= requiredSkip) {
      return; // Pular este tick
    }

    // FALCON 2.2 PRECISO Settings
    const settings = FALCON_MODES[state.mode as keyof typeof FALCON_MODES];
    const requiredTicks = settings.windowSize;

    if (userTicks.length < requiredTicks) {
      if (userTicks.length % 5 === 0) {
        this.logDataCollection(userId, {
          targetCount: requiredTicks,
          currentCount: userTicks.length,
          mode: settings.name
        });
      }
      return;
    }

    // ✅ Log inicial de análise ou heartbeat a cada X ticks
    if (userTicks.length === requiredTicks || userTicks.length % 50 === 0) {
      this.logAnalysisStarted(userId, state.mode, userTicks.length);
    }

    // ✅ Verificar novamente ANTES de fazer análise (evitar análise desnecessária)
    if (state.isWaitingContract) {
      return;
    }

    // ✅ Setar lock de processamento ANTES de fazer análise
    this.processingLocks.set(userId, true);

    try {
      // Realizar análise de mercado
      const marketAnalysis = await this.analyzeMarket(userId, userTicks);

      // ✅ Resetar contador de avanço (usando a info do mercado se disponivel, ou apenas resetando)
      // Se analisou, reseta o contador
      state.ticksSinceLastAnalysis = 0;

      // ✅ Verificar novamente APÓS análise (pode ter mudado durante análise)
      if (state.isWaitingContract) {
        this.processingLocks.set(userId, false); // Liberar lock antes de retornar
        return;
      }

      // ✅ Log de debug da análise (Sempre logar se houver análise)
      if (marketAnalysis) {
        const { signal, probability, details } = marketAnalysis;
        const ups = details?.ups || 0;
        const downs = details?.downs || 0;
        const total = details?.totalMoves || 0;

        this.logger.debug(`[Falcon][${userId}] Análise (${state.mode}): prob=${probability.toFixed(1)}%, signal=${signal}, moves=${ups}^/${downs}v`);

        // Se usuário pediu logs detalhados, salvar no banco - Usando INFO para garantir visibilidade
        const cutoff = state.mode === 'PRECISO' ? 70 : (state.mode === 'ULTRA' ? 80 : 90);
        const message = `📊 ANÁLISE COMPLETA\n` +
          `• Padrão: ${ups} altas / ${downs} baixas (de ${total})\n` +
          `• Status: ${signal ? 'SINAL ENCONTRADO ✅' : 'SEM PADRÃO CLARO ❌'}\n` +
          `• Probabilidade: ${probability}% (Cutoff: ${cutoff}%)`;

        this.saveLog(userId, signal ? 'INFO' : 'INFO', 'ANALYZER', message);
      }

      if (marketAnalysis && marketAnalysis.signal) {
        // ✅ Verificar novamente ANTES de processar decisão (pode ter mudado durante análise)
        if (state.isWaitingContract) {
          this.processingLocks.set(userId, false); // Liberar lock antes de retornar
          return;
        }

        // Processar decisão de trade
        const decision = await this.processAgent(userId, marketAnalysis);

        // ✅ Verificar novamente ANTES de executar (pode ter mudado durante processAgent)
        if (state.isWaitingContract) {
          this.processingLocks.set(userId, false); // Liberar lock antes de retornar
          return;
        }

        if (decision.action === 'BUY') {
          await this.executeTrade(userId, decision, marketAnalysis);
        } else if (decision.action === 'STOP') {
          await this.handleStopCondition(userId, decision.reason || 'UNKNOWN');
        }
      }
    } finally {
      // ✅ Sempre liberar lock, mesmo em caso de erro ou retorno antecipado
      this.processingLocks.set(userId, false);
    }
  }

  /**
   * Análise de mercado FALCON v2.2 (8 Filtros)
   */
  private async analyzeMarket(userId: string, ticks: Tick[]): Promise<MarketAnalysis | null> {
    const state = this.userStates.get(userId);
    if (!state) return null;

    const currentMode = state.mode as keyof typeof FALCON_MODES;
    const settings = FALCON_MODES[currentMode];
    const windowSize = settings.windowSize;

    if (ticks.length < windowSize) return null;

    const recent = ticks.slice(-windowSize);
    const recentValues = recent.map(t => t.value);

    // FILTRO 6: Horário de Operação
    if (!this.isValidTradingHour()) {
      this.logBlockedEntry(userId, { reason: 'Horário', details: 'Aguardando horário operacional estável' });
      return null;
    }

    // FILTRO 1: Contagem de Movimentos (Base)
    let ups = 0;
    let downs = 0;
    const totalPossibleMoves = settings.totalMovements;
    const windowData = recentValues.slice(-(totalPossibleMoves + 1));

    for (let i = 1; i < windowData.length; i++) {
      if (windowData[i] > windowData[i - 1]) ups++;
      else if (windowData[i] < windowData[i - 1]) downs++;
    }

    const totalMoves = ups + downs;
    const maxMoves = Math.max(ups, downs);
    let signal: 'CALL' | 'PUT' | null = null;

    if (maxMoves >= settings.requiredMovements && totalMoves >= settings.totalMovements) {
      signal = ups > downs ? 'CALL' : 'PUT';
    } else {
      this.logBlockedEntry(userId, {
        reason: 'Filtro Base',
        details: `Movimentos insuficientes (${maxMoves}/${settings.requiredMovements} de ${totalMoves}/${settings.totalMovements})`
      });
      return null;
    }

    // FILTRO 2: Delta (Força da Tendência) + FILTRO 8: Ajuste por Histórico
    const firstTick = windowData[0];
    const lastTick = windowData[windowData.length - 1];
    const calculatedDelta = Math.abs(lastTick - firstTick);

    let requiredDelta = settings.minDelta;
    // Ajuste por histórico recente (se teve 2+ perdas consecutivas no modo atual)
    if (state.consecutiveLossesSinceModeChange >= 2) {
      requiredDelta += 0.15;
      this.logger.log(`[Falcon][${userId}] 📊 Rigor Delta aumentado (+0.15) devido a ${state.consecutiveLossesSinceModeChange} perdas recentes.`);
    }

    if (calculatedDelta < requiredDelta) {
      this.logBlockedEntry(userId, { reason: 'Delta', details: `Delta baixo: ${calculatedDelta.toFixed(2)} < ${requiredDelta.toFixed(2)}` });
      return null;
    }

    // FILTRO 3: Confirmação Momentum (Últimos Ticks)
    const lastTicks = recentValues.slice(-settings.lastTicks);
    let momentumConfirmed = true;
    for (let i = 1; i < lastTicks.length; i++) {
      const movement = lastTicks[i] > lastTicks[i - 1] ? 'CALL' : (lastTicks[i] < lastTicks[i - 1] ? 'PUT' : null);
      if (movement !== signal) {
        momentumConfirmed = false;
        break;
      }
    }

    if (!momentumConfirmed) {
      this.logBlockedEntry(userId, { reason: 'Momentum', details: `Momentum divergiu nos últimos ${settings.lastTicks} ticks` });
      return null;
    }

    // FILTRO 4: Força do Movimento (Strength)
    const strength = this.calculateStrength(recentValues);
    if (strength < settings.minStrength) {
      this.logBlockedEntry(userId, { reason: 'Força', details: `Mercado lento: ${(strength * 100).toFixed(4)}% < ${(settings.minStrength * 100).toFixed(2)}%` });
      return null;
    }

    // FILTRO 5: Volatilidade
    const volatility = this.calculateVolatility(recentValues);
    if (volatility > settings.maxVolatility) {
      this.logBlockedEntry(userId, { reason: 'Volatilidade', details: `Mercado caótico: ${(volatility * 100).toFixed(2)}% > ${(settings.maxVolatility * 100).toFixed(2)}%` });
      return null;
    }

    // FILTRO 7: Confirmação Dupla
    if (!this.checkDoubleConfirmation(userId, signal)) {
      this.logBlockedEntry(userId, { reason: 'Confirmação Dupla', details: 'Sinal aguardando persistência em janela consecutiva' });
      return null;
    }

    // Se todos os filtros passaram, calcular Score final (0-100)
    // 50% Movimentos, 30% Strength, 20% Volatilidade (inverso)
    const moveScore = (maxMoves / totalPossibleMoves) * 50;
    const strengthScore = Math.min((strength / 0.01) * 30, 30);
    const volScore = Math.max(0, (1 - volatility / (settings.maxVolatility * 2)) * 20);
    const probability = Math.round(moveScore + strengthScore + volScore);

    return {
      probability,
      signal,
      payout: 0.92,
      confidence: probability / 100,
      details: {
        trend: signal,
        trendStrength: probability / 100,
        ups,
        downs,
        delta: calculatedDelta,
        totalMoves: totalPossibleMoves,
        volatility,
        strength
      },
    };
  }

  // Métodos antigos removidos (calculateVolatility, calculateEMA, analyzeDigits) pois não são usados na V2.0

  /**
   * FILTRO 4: Calcula força do movimento
   */
  private calculateStrength(window: number[]): number {
    let totalChange = 0;
    for (let i = 1; i < window.length; i++) {
      totalChange += Math.abs(window[i] - window[i - 1]);
    }
    const avgChange = totalChange / (window.length - 1);
    const strength = avgChange / window[0];
    return strength;
  }

  /**
   * FILTRO 5: Calcula volatilidade
   */
  private calculateVolatility(window: number[]): number {
    const mean = window.reduce((sum, price) => sum + price, 0) / window.length;
    const variance = window.reduce((sum, price) => {
      return sum + Math.pow(price - mean, 2);
    }, 0) / window.length;
    const stdDev = Math.sqrt(variance);
    const volatility = stdDev / mean;
    return volatility;
  }

  /**
   * FILTRO 6: Verifica se horário é válido
   */
  private isValidTradingHour(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const time = hour + (minute / 60);

    // Bloqueia primeiros 30min (09:00 - 09:30)
    if (time < 9.5 && hour >= 9) {
      return false;
    }
    // Bloqueia últimos 30min (17:30 - 18:00)
    if (time >= 17.5 && hour <= 18) {
      return false;
    }

    // Horário operacional total (ex: 7h às 18h)
    if (hour < 7 || hour >= 18) {
      return false;
    }

    return true;
  }

  /**
   * FILTRO 7: Confirmação dupla
   */
  private checkDoubleConfirmation(userId: string, currentDirection: string): boolean {
    const state = this.userStates.get(userId);
    if (!state) return false;

    // Adiciona o sinal atual ao histórico
    const now = Date.now();
    state.lastSignals.push({ direction: currentDirection, timestamp: now });

    // Mantém apenas os últimos 5 sinais
    if (state.lastSignals.length > 5) {
      state.lastSignals.shift();
    }

    // Se é o primeiro sinal, não tem como confirmar
    if (state.lastSignals.length < 2) {
      return false;
    }

    // Verifica se o sinal anterior é na mesma direção e recente (últimos 5 segundos)
    const lastSignal = state.lastSignals[state.lastSignals.length - 1];
    const prevSignal = state.lastSignals[state.lastSignals.length - 2];

    const isSameDirection = lastSignal.direction === prevSignal.direction;
    const isRecent = (lastSignal.timestamp - prevSignal.timestamp) <= 5000;

    return isSameDirection && isRecent;
  }

  /**
   * Processa agente (chamado via interface)
   */
  async processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || !state.isActive) {
      return { action: 'WAIT', reason: 'USER_NOT_ACTIVE' };
    }

    // ✅ Verificar se já está aguardando resultado de contrato
    if (state.isWaitingContract) {
      return { action: 'WAIT', reason: 'WAITING_CONTRACT_RESULT' };
    }

    // A. Verificações de Segurança (Hard Stops)
    if (state.lucroAtual >= config.dailyProfitTarget) {
      return { action: 'STOP', reason: 'TAKE_PROFIT' };
    }

    // B. Filtro de Precisão baseado no Modo (v2.2 thresholds)
    const currentMode = state.mode as keyof typeof FALCON_MODES;
    const settings = FALCON_MODES[currentMode];
    const requiredProb = currentMode === 'PRECISO' ? 70 : (currentMode === 'ULTRA' ? 80 : 90);

    // Calcular requiredDelta com base no histórico
    let requiredDelta = settings.minDelta;
    if (state.consecutiveLossesSinceModeChange >= 2) {
      requiredDelta += 0.15;
    }

    if (marketAnalysis.probability >= requiredProb && marketAnalysis.signal) {
      // ✅ Calcular stake (sem ajustes ainda)
      const stake = this.calculateStake(userId, marketAnalysis.payout);

      if (stake <= 0) {
        return { action: 'WAIT', reason: 'NO_STAKE' };
      }

      // ✅ Verificar Stop Loss (Normal e Blindado)
      const stopLossCheck = await this.checkStopLoss(userId, stake);
      if (stopLossCheck.action === 'STOP') {
        return stopLossCheck;
      }

      // Usar stake ajustado se houver
      const finalStake = stopLossCheck.stake ? stopLossCheck.stake : stake;

      // ✅ Log de sinal no padrão Orion v2.2
      this.logSignalGenerated(userId, {
        mode: settings.name,
        isRecovery: state.mode !== 'PRECISO',
        filters: [
          `Janela: ${settings.windowSize} ticks (${settings.totalMovements} moves)`,
          `Delta: ${marketAnalysis.details?.delta?.toFixed(2)} (Min ${requiredDelta.toFixed(2)})`,
          `Moves: ${Math.max(marketAnalysis.details?.ups || 0, marketAnalysis.details?.downs || 0)}/${settings.totalMovements}`,
          `Volatilidade: ${(marketAnalysis.details?.volatility * 100).toFixed(2)}%`,
          `Força: ${(marketAnalysis.details?.strength * 100).toFixed(4)}%`
        ],
        trigger: 'Momentum Confirmado 🦅',
        probability: marketAnalysis.probability,
        contractType: 'RISE/FALL',
        direction: marketAnalysis.signal as 'CALL' | 'PUT'
      });

      return {
        action: 'BUY',
        stake: finalStake,
        contractType: marketAnalysis.signal === 'CALL' ? 'CALL' : 'PUT',
        mode: state.mode,
        reason: 'HIGH_PROBABILITY',
      };
    } else {
      // ✅ Log de motivo para não comprar (formato igual ao SENTINEL)
      const missingProb = requiredProb - marketAnalysis.probability;
      const reasonMsg = marketAnalysis.probability < requiredProb
        ? `Score ${marketAnalysis.probability.toFixed(1)}% abaixo do mínimo ${requiredProb}% (faltam ${missingProb.toFixed(1)}%)`
        : 'Sinal indefinido';

      // ✅ THROTTLING: Só logar se:
      // 1. Passou pelo menos 30 segundos desde o último log de compra negada OU
      // 2. A probabilidade mudou significativamente (mais de 5%) OU
      // 3. A direção mudou
      const now = Date.now();
      const lastLogTime = state.lastDeniedLogTime || 0;
      const timeSinceLastLog = now - lastLogTime;
      const lastLogData = state.lastDeniedLogData;

      const probabilityChanged = !lastLogData ||
        Math.abs(lastLogData.probability - marketAnalysis.probability) > 5;
      const directionChanged = !lastLogData ||
        lastLogData.signal !== marketAnalysis.signal;

      const shouldLog = timeSinceLastLog > 30000 || // 30 segundos
        probabilityChanged ||
        directionChanged;

      if (shouldLog) {
        this.logBlockedEntry(userId, {
          reason: reasonMsg,
          details: `Score: ${marketAnalysis.probability.toFixed(1)}% | Dir: ${marketAnalysis.signal || 'N/A'}`
        });

        // ✅ Atualizar estado de último log
        state.lastDeniedLogTime = now;
        state.lastDeniedLogData = {
          probability: marketAnalysis.probability,
          signal: marketAnalysis.signal
        };
      }
    }

    return { action: 'WAIT', reason: 'LOW_PROBABILITY' };
  }

  /**
   * Atualiza o modo do agente baseado em vitória/derrota
   */
  private updateMode(userId: string, win: boolean): void {
    const state = this.userStates.get(userId);
    const config = this.userConfigs.get(userId);
    if (!state || !config) return;

    if (win) {
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
      state.consecutiveLossesSinceModeChange = 0;

      // Se estava em modo de recuperação, volta para PRECISO
      if (state.mode !== 'PRECISO') {
        const recoveredLoss = state.totalLossAccumulated;

        this.logSuccessfulRecoveryV2(userId, {
          recoveredLoss: recoveredLoss,
          additionalProfit: state.lastProfit - recoveredLoss,
          profitPercentage: 0, // Not easily calculated here without more context
          stakeBase: config.initialStake
        });

        state.mode = 'PRECISO';
        state.totalLossAccumulated = 0; // Resetar acumulado
        state.martingaleLevel = 0;
      }

      // Soros Nível 1: Resetar após trade de Soros ganhar (quando consecutiveWins = 2)
      if (state.consecutiveWins >= 2) {
        state.consecutiveWins = 0;
      }
    } else {
      state.consecutiveWins = 0;
      state.consecutiveLosses++;
      state.consecutiveLossesSinceModeChange++;

      // Progressão de Modos: PRECISO -> ULTRA -> HIPER
      if (state.mode === 'PRECISO') {
        state.mode = 'ULTRA';
        this.logger.log(`[Falcon][${userId}] ⚠️ LOSS (PRECISO) -> Mudando para ULTRA (Recuperação M1)`);
      } else if (state.mode === 'ULTRA') {
        state.mode = 'HIPER';
        this.logger.log(`[Falcon][${userId}] ⚠️ LOSS (ULTRA) -> Mudando para HIPER (Recuperação M2+)`);
      }

      state.martingaleLevel = state.consecutiveLosses;

      // Acumula perda para martingale
      if (state.lastProfit < 0) {
        state.totalLossAccumulated += Math.abs(state.lastProfit);
      }
    }
  }

  /**
   * Calcula o stake baseado no modo e situação
   */
  /**
   * Calcula o stake baseado no modo e situação
   */
  private calculateStake(userId: string, marketPayoutPercent: number): number {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return 0;
    }

    let stake = config.initialStake;
    const realPayout = (marketPayoutPercent - marketPayoutPercent * this.comissaoPlataforma);

    // Lógica para Modos de Recuperação (ULTRA/HIPER - Smart Martingale)
    if (state.mode !== 'PRECISO') {
      const riskSettings = FALCON_V21_RISK[config.riskProfile as keyof typeof FALCON_V21_RISK] || FALCON_V21_RISK.MODERADO;
      const profitFactor = riskSettings.profitFactor;

      const lossToRecover = state.totalLossAccumulated > 0 ? state.totalLossAccumulated : Math.abs(Math.min(0, state.lucroAtual));

      this.logger.debug(`[Falcon][${userId}] 🧮 CALC STAKE (${state.mode}): AccumLoss=${state.totalLossAccumulated}, LossToRecover=${lossToRecover}, Factor=${profitFactor}, Payout=${realPayout}`);

      if (lossToRecover > 0) {
        const targetAmount = lossToRecover * profitFactor;
        stake = targetAmount / realPayout;

        const hasLimit = riskSettings.maxMartingale !== -1;
        if (hasLimit && state.consecutiveLosses > riskSettings.maxMartingale) {
          this.logger.log(`[Falcon] ⚠️ Limite M${riskSettings.maxMartingale} atingido. Resetando para modo PRECISO.`);
          state.mode = 'PRECISO';
          state.totalLossAccumulated = 0;
          state.consecutiveLosses = 0;
          state.consecutiveLossesSinceModeChange = 0;
          return config.initialStake;
        }

        stake = Math.round(stake * 100) / 100;

        this.logMartingaleLevelV2(userId, {
          level: state.consecutiveLosses,
          lossNumber: state.consecutiveLosses,
          accumulatedLoss: lossToRecover,
          calculatedStake: stake,
          profitPercentage: Math.round((profitFactor - 1) * 100),
          maxLevel: riskSettings.maxMartingale,
          contractType: state.lastContractType || 'RISE/FALL'
        });
      } else {
        stake = config.initialStake;
      }
    }
    // Lógica para Modo NORMAL (Soros Nível 1)
    else {
      // ✅ DEBUG LOG
      this.logger.debug(`[Falcon][${userId}] 🧮 CALC STAKE (NORMAL): Wins=${state.consecutiveWins}, LastProfit=${state.lastProfit}, Base=${config.initialStake}`);

      // Soros Nível 1: Win1 = Base, Win2 = Base + Lucro, Win3 = volta para Base
      if (state.consecutiveWins === 1) { // Próximo é o trade #2 (consecutive será 1 ao entrar aqui)
        // Win1: A próxima aposta é Base + Lucro Anterior
        stake = config.initialStake + state.lastProfit;
        stake = Math.round(stake * 100) / 100;
        this.logSorosActivation(userId, {
          previousProfit: state.lastProfit,
          stakeBase: config.initialStake,
          level: 1
        });
      } else {
        // Win0 (início), Win2 (já fez soros, ganhou, vai resetar), etc.
        stake = Math.round(config.initialStake * 100) / 100;
      }
    }

    return Math.round(stake * 100) / 100;
  }

  /**
   * Verifica Stop Loss (Normal ou Blindado)
   * Unifica a lógica de stop loss normal e o stop loss blindado (Catraca do Falcon)
   */
  private async checkStopLoss(userId: string, nextStake?: number): Promise<TradeDecision> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return { action: 'WAIT', reason: 'CONFIG_NOT_FOUND' };
    }

    const stake = nextStake || 0;

    // 1. Stop Loss Normal
    const currentDrawdown = state.lucroAtual < 0 ? Math.abs(state.lucroAtual) : 0;

    // Verificação de limite simples (já estourou?)
    if (currentDrawdown >= config.dailyLossLimit) {
      return { action: 'STOP', reason: 'STOP_LOSS' };
    }

    // Verificação com a próxima stake
    if (currentDrawdown + stake > config.dailyLossLimit) {
      const remaining = config.dailyLossLimit - currentDrawdown;
      // Arredondar para 2 casas e garantir mínimo da Deriv (0.35)
      const adjustedStake = Math.round(remaining * 100) / 100;

      if (adjustedStake < 0.35) {
        this.logger.log(`[Falcon][${userId}] 🛑 STOP LOSS ATINGIDO (Margem insuficiente).`);
        await this.saveLog(userId, 'WARN', 'RISK', `Stop Loss atingido (Margem insuficiente para trade mínimo). Parando.`);
        return { action: 'STOP', reason: 'STOP_LOSS_LIMIT' };
      }

      this.logger.log(`[Falcon][${userId}] ⛔ STAKE AJUSTADA PELO STOP: De ${stake.toFixed(2)} para ${adjustedStake.toFixed(2)}`);
      await this.saveLog(userId, 'WARN', 'RISK',
        `Risco de ultrapassar Stop Loss! perdas=${currentDrawdown.toFixed(2)}, stake=${stake.toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}. Ajustando para ${adjustedStake.toFixed(2)}`);

      return {
        action: 'BUY',
        stake: adjustedStake,
        reason: 'STOP_LOSS_ADJUSTED'
      };
    }

    // 2. Stop Loss Blindado (Efeito Catraca - Lógica Falcon Preservada)
    // ✅ Verifica se o tipo de Stop Loss é 'blindado' antes de aplicar a lógica
    if (config.stopLossType === 'blindado') {
      if (!state.stopBlindadoAtivo) {
        // Ativação (40% da Meta)
        if (state.lucroAtual >= config.dailyProfitTarget * 0.40) {
          state.stopBlindadoAtivo = true;
          state.picoLucro = state.lucroAtual;
          state.pisoBlindado = state.picoLucro * 0.50; // Piso é 50% do pico

          this.logger.log(`[Falcon][${userId}] 🔒 STOP BLINDADO ATIVADO! Piso: ${state.pisoBlindado.toFixed(2)}`);
          await this.saveLog(userId, 'INFO', 'RISK',
            `Lucro atual: $${state.lucroAtual.toFixed(2)}. Ativando Stop Loss Blindado em $${state.pisoBlindado.toFixed(2)}.`);
        }
      } else {
        // Atualização Dinâmica (Trailing Stop)
        if (state.lucroAtual > state.picoLucro) {
          state.picoLucro = state.lucroAtual;
          state.pisoBlindado = state.picoLucro * 0.50;

          this.logger.log(`[Falcon][${userId}] 🔒 BLINDAGEM SUBIU! Novo Piso: ${state.pisoBlindado.toFixed(2)}`);
        }

        // Gatilho de Saída
        if (state.lucroAtual <= state.pisoBlindado) {
          this.logger.log(`[Falcon][${userId}] 🛑 STOP BLINDADO ATINGIDO. Encerrando operações.`);

          await this.saveLog(userId, 'WARN', 'RISK',
            `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${state.lucroAtual.toFixed(2)}. Encerrando operações do dia.`);

          // ✅ Pausar operações no banco de dados (Status Pausado/Blindado)
          // Mantém is_active = TRUE para permitir reset automático no dia seguinte
          state.isActive = false; // Pausa em memória
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET session_status = 'stopped_blindado', is_active = TRUE WHERE user_id = ?`,
            [userId],
          );

          return { action: 'STOP', reason: 'BLINDADO' };
        }
      }
    }

    // Se passou por todas as verificações, pode comprar
    return {
      action: 'BUY',
      stake: stake,
      reason: 'RiskCheckOK'
    };
  }

  /**
   * Executa trade
   */
  private async executeTrade(userId: string, decision: TradeDecision, marketAnalysis: MarketAnalysis): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state || decision.action !== 'BUY') {
      return;
    }

    // ✅ Verificar se já está aguardando resultado de contrato (dupla verificação de segurança)
    if (state.isWaitingContract) {
      this.logger.warn(`[Falcon][${userId}] ⚠️ Tentativa de compra bloqueada: já aguardando resultado de contrato anterior`);
      return;
    }

    // Verificar Stop Loss antes de executar (dupla verificações)
    const stopLossCheck = await this.checkStopLoss(userId, decision.stake);
    if (stopLossCheck.action === 'STOP') {
      return;
    }

    const contractType = decision.contractType || (marketAnalysis.signal === 'CALL' ? 'CALL' : 'PUT');

    // ✅ IMPORTANTE: Setar isWaitingContract ANTES de comprar para bloquear qualquer nova análise/compra
    state.isWaitingContract = true;

    // Payout fixo: 92.15%
    const zenixPayout = 0.9215;

    //  ✅ FIX: Obter preço atual do último tick disponível para usar como entry price inicial
    // Isso evita que trades sejam criados com entryPrice = 0 ou null
    const userTicks = this.ticks.get(userId) || [];
    const currentPrice = userTicks.length > 0
      ? userTicks[userTicks.length - 1].value
      : marketAnalysis.details?.currentPrice || 0;

    this.logger.debug(`[Falcon][${userId}] 💰 Usando preço atual como entry price inicial: ${currentPrice}`);

    try {
      // ✅ Salvar tipo de contrato para usar no log de resultado
      state.lastContractType = contractType;

      // ✅ Criar registro de trade ANTES de executar - com preço atual como inicial
      const tradeId = await this.createTradeRecord(
        userId,
        {
          contractType: contractType,
          stakeAmount: decision.stake || config.initialStake,
          duration: 5,
          marketAnalysis: marketAnalysis,
          payout: zenixPayout,
          entryPrice: currentPrice, // ✅ Usar preço atual instead of 0
        },
      );

      try {
        const contractId = await this.buyContract(
          userId,
          config.derivToken,
          contractType,
          config.symbol,
          decision.stake || config.initialStake,
          5, // duration em ticks
        );

        if (contractId) {
          state.currentContractId = contractId;
          state.currentTradeId = tradeId;

          // ✅ Log de operação no padrão Orion
          await this.saveLog(
            userId,
            'INFO',
            'TRADER',
            `⚡ ENTRADA CONFIRMADA: ${contractType} | Valor: $${(decision.stake || config.initialStake).toFixed(2)}`,
          );

          // ✅ Atualizar trade com contract_id
          await this.updateTradeRecord(tradeId, {
            contractId: contractId,
            status: 'ACTIVE',
          });
        } else {
          // Se falhou, resetar isWaitingContract e atualizar trade com erro
          state.isWaitingContract = false;
          await this.updateTradeRecord(tradeId, {
            status: 'ERROR',
            errorMessage: 'Falha ao comprar contrato',
          });
          await this.saveLog(userId, 'ERROR', 'API', 'Falha ao comprar contrato. Aguardando novo sinal...');
        }
      } catch (error) {
        // Se houve erro, resetar isWaitingContract
        state.isWaitingContract = false;
        this.logger.error(`[Falcon][${userId}] Erro ao comprar contrato:`, error);
        await this.saveLog(userId, 'ERROR', 'API', `Erro ao comprar contrato: ${error.message}. Aguardando novo sinal...`);
      }
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao executar trade:`, error);
      await this.saveLog(userId, 'ERROR', 'API', `Erro ao executar trade: ${error.message}`);
    }
  }

  /**
   * Obtém payout de um contrato via Deriv API
   */
  private async getPayout(token: string, contractType: string, symbol: string, duration: number): Promise<number> {
    try {
      // ✅ Obter conexão do pool interno
      const connection = await this.getOrCreateWebSocketConnection(token);

      const response = await connection.sendRequest(
        {
          proposal: 1,
          amount: 1,
          basis: 'stake',
          contract_type: contractType,
          currency: 'USD',
          duration: duration,
          duration_unit: 't',
          symbol: symbol,
        },
        60000, // timeout 60s (igual Orion)
      );

      if (response.error) {
        throw new Error(response.error.message || 'Erro ao obter payout');
      }

      if (response.proposal) {
        const payout = Number(response.proposal.payout || 0);
        const askPrice = Number(response.proposal.ask_price || 0);

        // Calcular payout percentual: (payout - askPrice) / askPrice
        const payoutPercent = askPrice > 0 ? (payout - askPrice) / askPrice : 0;
        return payoutPercent;
      }

      throw new Error('Resposta de proposal inválida');
    } catch (error) {
      this.logger.error(`[Falcon] Erro ao obter payout:`, error);
      // Retornar valores padrão em caso de erro
      return 0.95; // 95% para Rise/Fall
    }
  }

  /**
   * Pré-aquece conexão WebSocket para garantir que esteja pronta
   * Envia um ping simples para forçar criação e autorização da conexão
   */
  async warmUpConnection(token: string): Promise<void> {
    try {
      await this.getOrCreateWebSocketConnection(token, 'warmup');
    } catch (error: any) {
      this.logger.warn(`[Falcon] Falha no warm-up: ${error.message}`);
    }
  }

  /**
   * Compra contrato na Deriv via WebSocket Pool Interno com retry automático
   */
  private async buyContract(
    userId: string,
    token: string,
    contractType: string,
    symbol: string,
    stake: number,
    duration: number,
    maxRetries = 2,
  ): Promise<string | null> {
    const roundedStake = Math.round(stake * 100) / 100;
    let lastError: Error | null = null;

    // ✅ CORREÇÃO: Delay inicial de 3000ms antes da primeira tentativa
    // Isso dá tempo para a conexão WebSocket se estabilizar e AUTORIZAR
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ✅ Retry com backoff exponencial
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // ✅ Backoff exponencial: 1s, 2s, 4s...
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          this.logger.warn(`[Falcon][${userId}] 🔄 Tentativa ${attempt + 1}/${maxRetries + 1} após ${delayMs}ms | Erro anterior: ${lastError?.message}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // ✅ Obter conexão do pool interno
        const connection = await this.getOrCreateWebSocketConnection(token, userId);

        // ✅ Primeiro, obter proposta (usando timeout de 60s como Orion)
        const proposalResponse = await connection.sendRequest(
          {
            proposal: 1,
            amount: roundedStake,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            duration: duration,
            duration_unit: 't',
            symbol: symbol,
          },
          60000, // timeout 60s (igual Orion)
        );

        // ✅ Verificar erros na resposta (pode estar em error ou proposal.error) - igual Orion
        const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
        if (errorObj) {
          const errorCode = errorObj?.code || '';
          const errorMessage = errorObj?.message || JSON.stringify(errorObj);

          // ✅ Alguns erros não devem ser retentados (ex: saldo insuficiente, parâmetros inválidos)
          const nonRetryableErrors = ['InvalidAmount', 'InsufficientBalance', 'InvalidContract', 'InvalidSymbol'];
          if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
            this.logger.error(`[Falcon][${userId}] ❌ Erro não retentável na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
            throw new Error(errorMessage);
          }

          // ✅ Erros retentáveis: tentar novamente
          lastError = new Error(errorMessage);
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Erro retentável na proposta (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
            continue;
          }

          this.logger.error(`[Falcon][${userId}] ❌ Erro na proposta após ${maxRetries + 1} tentativas: ${JSON.stringify(errorObj)} | Tipo: ${contractType} | Valor: $${stake}`);
          throw lastError;
        }

        const proposalId = proposalResponse.proposal?.id;
        const proposalPrice = Number(proposalResponse.proposal?.ask_price || 0);

        if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
          lastError = new Error('Resposta de proposta inválida');
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Proposta inválida (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(proposalResponse)}`);
            continue;
          }
          this.logger.error(`[Falcon][${userId}] ❌ Proposta inválida recebida após ${maxRetries + 1} tentativas: ${JSON.stringify(proposalResponse)}`);
          throw lastError;
        }

        // ✅ Enviar compra (usando timeout de 60s como Orion)
        const buyResponse = await connection.sendRequest(
          {
            buy: proposalId,
            price: proposalPrice,
          },
          60000, // timeout 60s (igual Orion)
        );

        // ✅ Verificar erros na resposta - igual Orion
        const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
        if (buyErrorObj) {
          const errorCode = buyErrorObj?.code || '';
          const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);

          // ✅ Alguns erros não devem ser retentados
          const nonRetryableErrors = ['InvalidProposal', 'ProposalExpired', 'InsufficientBalance'];
          if (nonRetryableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
            this.logger.error(`[Falcon][${userId}] ❌ Erro não retentável ao comprar: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
            throw new Error(errorMessage);
          }

          // ✅ Erros retentáveis: tentar novamente (mas precisa obter nova proposta)
          lastError = new Error(errorMessage);
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Erro retentável ao comprar (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
            continue;
          }

          this.logger.error(`[Falcon][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractType} | Valor: $${stake} | ProposalId: ${proposalId}`);
          throw lastError;
        }

        const contractId = buyResponse.buy?.contract_id;
        if (!contractId) {
          lastError = new Error('Resposta de compra inválida - sem contract_id');
          if (attempt < maxRetries) {
            this.logger.warn(`[Falcon][${userId}] ⚠️ Contrato sem contract_id (tentativa ${attempt + 1}/${maxRetries + 1}): ${JSON.stringify(buyResponse)}`);
            continue;
          }
          this.logger.error(`[Falcon][${userId}] ❌ Contrato criado mas sem contract_id após ${maxRetries + 1} tentativas: ${JSON.stringify(buyResponse)}`);
          throw lastError;
        }

        // ✅ Inscrever para monitorar contrato usando pool interno
        await connection.subscribe(
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          (contractMsg: any) => {
            if (contractMsg.proposal_open_contract) {
              const contract = contractMsg.proposal_open_contract;
              const state = this.userStates.get(userId);

              // ✅ Log de debug para rastrear atualizações do contrato
              this.logger.debug(`[Falcon][${userId}] 📊 Atualização do contrato ${contractId}: is_sold=${contract.is_sold} (tipo: ${typeof contract.is_sold}), status=${contract.status}, profit=${contract.profit}`);

              // ✅ Atualizar entry_price quando disponível
              if (contract.entry_spot && state?.currentTradeId) {
                this.updateTradeRecord(state.currentTradeId, {
                  entryPrice: Number(contract.entry_spot),
                }).then(() => {
                  this.logger.log(`[Falcon][${userId}] ✅ Entry price atualizado para ${contract.entry_spot} (trade #${state.currentTradeId})`);
                }).catch((error) => {
                  this.logger.error(`[Falcon][${userId}] Erro ao atualizar entry_price:`, error);
                });
              }

              // ✅ Verificar se contrato foi rejeitado, cancelado ou expirado
              if (contract.status === 'rejected' || contract.status === 'cancelled' || contract.status === 'expired') {
                const errorMsg = `Contrato ${contract.status}: ${contract.error_message || 'Sem mensagem de erro'}`;
                this.logger.error(`[Falcon][${userId}] ❌ Contrato ${contractId} foi ${contract.status}: ${errorMsg}`);

                if (state?.currentTradeId) {
                  this.updateTradeRecord(state.currentTradeId, {
                    status: 'ERROR',
                    errorMessage: errorMsg,
                  }).catch((error) => {
                    this.logger.error(`[Falcon][${userId}] Erro ao atualizar trade com status ERROR:`, error);
                  });
                }

                if (state) {
                  state.isWaitingContract = false;
                  state.currentContractId = null;
                  state.currentTradeId = null;
                }

                // Remover subscription usando pool interno
                connection.removeSubscription(contractId);
                return;
              }

              // ✅ Verificar se contrato foi finalizado (igual Orion)
              // Aceitar tanto is_sold (1 ou true) quanto status ('won', 'lost', 'sold')
              const isFinalized = contract.is_sold === 1 || contract.is_sold === true ||
                contract.status === 'won' || contract.status === 'lost' || contract.status === 'sold';

              if (isFinalized) {
                const profit = Number(contract.profit || 0);
                const win = profit > 0;
                const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);

                this.logger.log(`[Falcon][${userId}] ✅ Contrato ${contractId} finalizado: ${win ? 'WIN' : 'LOSS'} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Exit: ${exitPrice}`);

                // Processar resultado
                this.onContractFinish(
                  userId,
                  { win, profit, contractId, exitPrice, stake },
                ).catch((error) => {
                  this.logger.error(`[Falcon][${userId}] Erro ao processar resultado:`, error);
                });

                // Remover subscription usando pool interno
                connection.removeSubscription(contractId);
              }
            }
          },
          contractId,
          90000, // timeout 90s
        );

        // ✅ Se chegou aqui, sucesso!
        return contractId;
      } catch (error: any) {
        lastError = error;
        const errorMessage = error?.message || JSON.stringify(error);

        // ✅ Verificar se é erro de timeout ou conexão (retentável)
        const isRetryableError = errorMessage.includes('Timeout') ||
          errorMessage.includes('WebSocket') ||
          errorMessage.includes('Conexão') ||
          errorMessage.includes('not ready') ||
          errorMessage.includes('not open');

        if (isRetryableError && attempt < maxRetries) {
          this.logger.warn(`[Falcon][${userId}] ⚠️ Erro retentável (tentativa ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
          continue;
        }

        // ✅ Se não é retentável ou esgotou tentativas, logar e retornar null
        if (attempt >= maxRetries) {
          this.logger.error(`[Falcon][${userId}] ❌ Erro ao comprar contrato após ${maxRetries + 1} tentativas: ${errorMessage}`, error?.stack);
        } else {
          this.logger.error(`[Falcon][${userId}] ❌ Erro não retentável ao comprar contrato: ${errorMessage}`, error?.stack);
        }
        return null;
      }
    }

    // ✅ Se chegou aqui, todas as tentativas falharam
    this.logger.error(`[Falcon][${userId}] ❌ Falha ao comprar contrato após ${maxRetries + 1} tentativas: ${lastError?.message || 'Erro desconhecido'}`);
    return null;
  }

  /**
   * Processa resultado de contrato finalizado
   */
  async onContractFinish(
    userId: string,
    result: { win: boolean; profit: number; contractId: string; exitPrice?: number; stake: number },
  ): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      this.logger.warn(`[Falcon][${userId}] ⚠️ onContractFinish chamado mas config ou state não encontrado`);
      return;
    }

    state.isWaitingContract = false;
    const tradeId = state.currentTradeId;
    state.currentContractId = null;
    state.currentTradeId = null;

    this.logger.log(`[Falcon][${userId}] 📋 Processando resultado do contrato ${result.contractId} | TradeId: ${tradeId} | Win: ${result.win} | Profit: ${result.profit}`);

    // ✅ Atualizar trade no banco com resultado
    if (tradeId) {
      try {
        await this.updateTradeRecord(tradeId, {
          status: result.win ? 'WON' : 'LOST',
          exitPrice: result.exitPrice || 0,
          profitLoss: result.profit,
          closedAt: new Date(),
        });
        this.logger.log(`[Falcon][${userId}] ✅ Trade ${tradeId} atualizado no banco de dados`);
      } catch (error) {
        this.logger.error(`[Falcon][${userId}] ❌ Erro ao atualizar trade ${tradeId} no banco:`, error);
      }
    } else {
      this.logger.warn(`[Falcon][${userId}] ⚠️ onContractFinish chamado mas tradeId é null/undefined`);
    }

    // Atualizar estado
    state.opsCount++;
    state.lastProfit = result.profit;
    state.lucroAtual += result.profit;

    // Atualizar modo (PRECISO ou ALTA_PRECISAO)
    this.updateMode(userId, result.win);

    // ✅ Atualizar banco de dados PRIMEIRO (antes dos logs)
    await this.updateUserStateInDb(userId, state);

    // ✅ Logs detalhados do resultado (formato igual à Orion)
    const status = result.win ? 'WON' : 'LOST';
    const contractType = state.lastContractType || 'CALL'; // Usar último tipo de contrato executado
    const pnl = result.profit >= 0 ? `+$${result.profit.toFixed(2)}` : `-$${Math.abs(result.profit).toFixed(2)}`;

    // ✅ Log de resultado no padrão Orion
    this.logTradeResultV2(userId, {
      status: result.win ? 'WIN' : 'LOSS',
      profit: result.profit,
      stake: result.stake,
      balance: config.initialBalance + state.lucroAtual // Approximation of current balance? state.lucroAtual is profit relative to start.
      // initialBalance + lucroAtual should be current balance.
    });

    // Verificar se atingiu meta ou stop
    if (state.lucroAtual >= config.dailyProfitTarget) {
      await this.handleStopCondition(userId, 'TAKE_PROFIT');
    } else if (state.lucroAtual <= -config.dailyLossLimit) {
      await this.handleStopCondition(userId, 'STOP_LOSS');
    }
  }

  /**
   * Trata condições de parada
   */
  private async handleStopCondition(userId: string, reason: string): Promise<void> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return;
    }

    let status = 'active';
    let message = '';

    switch (reason) {
      case 'TAKE_PROFIT':
        status = 'stopped_profit';
        message = `META DE LUCRO ATINGIDA! daily_profit=${state.lucroAtual.toFixed(2)}, target=${config.dailyProfitTarget.toFixed(2)}. Encerrando operações.`;
        break;
      case 'STOP_LOSS':
        status = 'stopped_loss';
        message = `STOP LOSS ATINGIDO! daily_loss=${Math.abs(Math.min(0, state.lucroAtual)).toFixed(2)}, limite=${config.dailyLossLimit.toFixed(2)}. Encerrando operações.`;
        break;
      case 'BLINDADO':
        status = 'stopped_blindado';
        message = `STOP LOSS BLINDADO ATINGIDO! Saldo caiu para $${(config.initialBalance + state.lucroAtual).toFixed(2)}. Encerrando operações do dia.`;
        break;
    }

    await this.saveLog(userId, 'WARN', 'RISK', message);

    // Desativar agente (apenas em memória para parar hoje)
    // ✅ MANTER NO BANCO COMO ATIVO (is_active = TRUE) para que o scheduler reinicie amanhã
    state.isActive = false;
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = ?, is_active = TRUE WHERE user_id = ?`,
      [status, userId],
    );

    this.logger.log(`[Falcon][${userId}] ${message}`);
  }

  /**
   * Cria registro de trade no banco
   */
  private async createTradeRecord(
    userId: string,
    trade: {
      contractType: string;
      stakeAmount: number;
      duration: number;
      marketAnalysis: MarketAnalysis;
      payout: number;
      entryPrice: number;
    },
  ): Promise<number> {
    const config = this.userConfigs.get(userId);
    const state = this.userStates.get(userId);

    if (!config || !state) {
      return 0;
    }

    const analysisData = {
      strategy: 'falcon',
      mode: state.mode,
      probability: trade.marketAnalysis.probability,
      signal: trade.marketAnalysis.signal,
      volatility: trade.marketAnalysis.details?.volatility,
      trend: trade.marketAnalysis.details?.trend,
      digitPattern: trade.marketAnalysis.details?.digitPattern,
      timestamp: new Date().toISOString(),
    };

    const analysisReasoning = `Análise FALCON: Probabilidade ${trade.marketAnalysis.probability.toFixed(1)}%, ` +
      `Direção ${trade.marketAnalysis.signal}, ` +
      `Modo ${state.mode}, ` +
      `Volatilidade=${trade.marketAnalysis.details?.volatility?.toFixed(4) || 'N/A'}`;

    try {
      const result = await this.dataSource.query(
        `INSERT INTO autonomous_agent_trades (
          user_id, analysis_data, confidence_score, analysis_reasoning,
          contract_type, contract_duration, entry_price, stake_amount,
          martingale_level, payout, symbol, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())`,
        [
          userId,
          JSON.stringify(analysisData),
          trade.marketAnalysis.probability,
          analysisReasoning,
          trade.contractType,
          trade.duration,
          trade.entryPrice,
          trade.stakeAmount,
          state.mode !== 'PRECISO' ? `M${state.martingaleLevel}` : 'M0',
          trade.payout * 100, // Converter para percentual
          config.symbol,
        ],
      );

      const insertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
      return insertId || 0;
    } catch (error) {
      this.logger.error(`[Falcon][${userId}] Erro ao criar registro de trade:`, error);
      return 0;
    }
  }

  /**
   * Atualiza registro de trade no banco
   */
  private async updateTradeRecord(
    tradeId: number,
    updates: {
      contractId?: string;
      entryPrice?: number;
      exitPrice?: number;
      status?: string;
      profitLoss?: number;
      errorMessage?: string;
      closedAt?: Date;
    },
  ): Promise<void> {
    if (!tradeId || tradeId === 0) {
      return;
    }

    const updateFields: string[] = [];
    const updateValues: any[] = [];

    if (updates.contractId !== undefined) {
      updateFields.push('contract_id = ?');
      updateValues.push(updates.contractId);
    }

    if (updates.entryPrice !== undefined) {
      updateFields.push('entry_price = ?');
      updateValues.push(updates.entryPrice);
    }

    if (updates.exitPrice !== undefined) {
      updateFields.push('exit_price = ?');
      updateValues.push(updates.exitPrice);
    }

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      updateValues.push(updates.status);

      if (updates.status === 'ACTIVE') {
        updateFields.push('started_at = NOW()');
      }
    }

    if (updates.profitLoss !== undefined) {
      updateFields.push('profit_loss = ?');
      updateValues.push(updates.profitLoss);
    }

    if (updates.errorMessage !== undefined) {
      updateFields.push('error_message = ?');
      updateValues.push(updates.errorMessage);
    }

    if (updates.closedAt !== undefined) {
      updateFields.push('closed_at = ?');
      updateValues.push(updates.closedAt);
    }

    if (updateFields.length === 0) {
      this.logger.warn(`[Falcon] ⚠️ Tentativa de atualizar trade ${tradeId} sem campos para atualizar`);
      return;
    }

    updateValues.push(tradeId);

    try {
      this.logger.debug(`[Falcon] 📝 Atualizando trade ${tradeId}: ${updateFields.join(', ')}`);
      await this.dataSource.query(
        `UPDATE autonomous_agent_trades SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues,
      );
      this.logger.debug(`[Falcon] ✅ Trade ${tradeId} atualizado com sucesso`);
    } catch (error) {
      this.logger.error(`[Falcon] ❌ Erro ao atualizar trade ${tradeId}:`, error);
      throw error; // ✅ Re-throw para que o erro seja visível
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
             daily_loss = ?,
             total_trades = ?,
             updated_at = NOW()
         WHERE user_id = ? AND agent_type = 'falcon'`,
        [
          Math.max(0, state.lucroAtual),
          Math.abs(Math.min(0, state.lucroAtual)),
          state.opsCount,
          userId,
        ],
      );
    } catch (error) {
      this.logger.error(`[Falcon] Erro ao atualizar estado no DB:`, error);
    }
  }

  /**
   * Salva log no sistema (via LogQueueService que salva no banco)
   * ✅ Evita duplicação: salva apenas uma vez via LogQueueService
   */
  private async saveLog(userId: string, level: string, module: string, message: string): Promise<void> {
    // ✅ Formatar mensagem sem duplicar prefixo do módulo
    let formattedMessage = message;
    // Remover prefixos duplicados se existirem (ex: [CORE] - mensagem)
    formattedMessage = formattedMessage.replace(/^\[.*?\]\s*-\s*/g, '');

    // ✅ Salvar APENAS via LogQueueService (evita duplicação)
    // O LogQueueService já salva no banco de dados automaticamente
    if (this.logQueueService) {
      // Normalizar módulo para tipo válido
      const validModules: ('CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER')[] =
        ['CORE', 'API', 'ANALYZER', 'DECISION', 'TRADER', 'RISK', 'HUMANIZER'];
      const normalizedModule = validModules.includes(module.toUpperCase() as any)
        ? (module.toUpperCase() as 'CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER')
        : 'CORE';

      this.logQueueService.saveLogAsync({
        userId,
        level: level.toUpperCase() as 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
        module: normalizedModule,
        message: formattedMessage, // Usar mensagem formatada sem duplicar prefixo
        icon: this.getLogIcon(level),
        details: { symbol: this.userConfigs.get(userId)?.symbol || 'R_100' },
        tableName: 'autonomous_agent_logs',
      });
    }

    this.logger.log(`[Falcon][${module}][${userId}] ${formattedMessage}`);
  }

  private getLogIcon(level: string): string {
    switch (level.toUpperCase()) {
      case 'ERROR':
        return '🚫';
      case 'WARN':
        return '⚠️';
      case 'INFO':
        return 'ℹ️';
      case 'DEBUG':
        return '🔍';
      default:
        return 'ℹ️';
    }
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
      state.lastSignals = [];
      state.consecutiveLossesSinceModeChange = 0;
    }
  }

  // ============================================
  // MÉTODOS DE GERENCIAMENTO DE WEBSOCKET (Pool Interno)
  // Copiados da Orion Strategy
  // ============================================

  /**
   * ✅ Obtém ou cria conexão WebSocket reutilizável por token
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    // ✅ Verificar se já existe conexão para este token
    const existing = this.wsConnections.get(token);
    if (existing) {
      const readyState = existing.ws.readyState;
      const readyStateText = readyState === WebSocket.OPEN ? 'OPEN' :
        readyState === WebSocket.CONNECTING ? 'CONNECTING' :
          readyState === WebSocket.CLOSING ? 'CLOSING' :
            readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN';

      this.logger.debug(`[FALCON] 🔍 [${userId || 'SYSTEM'}] Conexão encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);

      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        this.logger.debug(`[FALCON] ♻️ [${userId || 'SYSTEM'}] ✅ Reutilizando conexão WebSocket existente`);

        return {
          ws: existing.ws,
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
            this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      } else {
        this.logger.warn(`[FALCON] ⚠️ [${userId || 'SYSTEM'}] Conexão existente não está pronta (readyState=${readyStateText}, authorized=${existing.authorized}). Fechando e recriando.`);
        if (existing.keepAliveInterval) {
          clearInterval(existing.keepAliveInterval);
        }
        existing.ws.close();
        this.wsConnections.delete(token);
      }
    } else {
      this.logger.debug(`[FALCON] 🔍 [${userId || 'SYSTEM'}] Nenhuma conexão existente encontrada para token ${token.substring(0, 8)}`);
    }

    // ✅ Criar nova conexão
    this.logger.debug(`[FALCON] 🔌 [${userId || 'SYSTEM'}] Criando nova conexão WebSocket para token`);
    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      let authResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          this.logger.error(`[FALCON] ❌ [${userId || 'SYSTEM'}] Timeout na autorização após 20s. Estado: readyState=${socket.readyState}`);
          socket.close();
          this.wsConnections.delete(token);
          reject(new Error('Timeout ao conectar e autorizar WebSocket (20s)'));
        }
      }, 20000);

      // ✅ Listener de mensagens para capturar autorização e outras respostas
      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          // ✅ Ignorar ping/pong
          if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
            return;
          }

          const conn = this.wsConnections.get(token);
          if (!conn) {
            this.logger.warn(`[FALCON] ⚠️ [${userId || 'SYSTEM'}] Mensagem recebida mas conexão não encontrada no pool para token ${token.substring(0, 8)}`);
            return;
          }

          // ✅ Processar autorização (apenas durante inicialização)
          if (msg.msg_type === 'authorize' && !authResolved) {
            this.logger.debug(`[FALCON] 🔐 [${userId || 'SYSTEM'}] Processando resposta de autorização...`);
            authResolved = true;
            clearTimeout(connectionTimeout);

            if (msg.error || (msg.authorize && msg.authorize.error)) {
              const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autorização';
              this.logger.error(`[FALCON] ❌ [${userId || 'SYSTEM'}] Erro na autorização: ${errorMsg}`);
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(`Erro na autorização: ${errorMsg}`));
              return;
            }

            conn.authorized = true;
            this.logger.log(`[FALCON] ✅ [${userId || 'SYSTEM'}] Autorizado com sucesso | LoginID: ${msg.authorize?.loginid || 'N/A'}`);

            // ✅ Iniciar keep-alive
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send(JSON.stringify({ ping: 1 }));
                  this.logger.debug(`[FALCON][KeepAlive][${token.substring(0, 8)}] Ping enviado`);
                } catch (error) {
                  // Ignorar erros
                }
              }
            }, 90000);

            resolve(socket);
            return;
          }

          // ✅ Processar mensagens de subscription (proposal_open_contract) - PRIORIDADE 1
          if (msg.proposal_open_contract) {
            const contractId = msg.proposal_open_contract.contract_id;
            if (contractId && conn.subscriptions.has(contractId)) {
              const callback = conn.subscriptions.get(contractId)!;
              callback(msg);
              return;
            }
          }

          // ✅ Processar respostas de requisições (proposal, buy, etc.) - PRIORIDADE 2
          if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
            // Processar primeira requisição pendente (FIFO)
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
          }
        } catch (error) {
          // Continuar processando
        }
      });

      socket.on('open', () => {
        this.logger.log(`[FALCON] ✅ [${userId || 'SYSTEM'}] WebSocket conectado, enviando autorização...`);

        // ✅ Criar entrada no pool
        const conn = {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        };
        this.wsConnections.set(token, conn);

        // ✅ Enviar autorização
        const authPayload = { authorize: token };
        this.logger.debug(`[FALCON] 📤 [${userId || 'SYSTEM'}] Enviando autorização: ${JSON.stringify({ authorize: token.substring(0, 8) + '...' })}`);
        socket.send(JSON.stringify(authPayload));
      });

      socket.on('error', (error) => {
        if (!authResolved) {
          clearTimeout(connectionTimeout);
          authResolved = true;
          this.wsConnections.delete(token);
          reject(error);
        }
      });

      socket.on('close', () => {
        this.logger.debug(`[FALCON] 🔌 [${userId || 'SYSTEM'}] WebSocket fechado`);
        const conn = this.wsConnections.get(token);
        if (conn) {
          if (conn.keepAliveInterval) {
            clearInterval(conn.keepAliveInterval);
          }
          // Rejeitar todas as requisições pendentes
          conn.pendingRequests.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.reject(new Error('WebSocket fechado'));
          });
          conn.subscriptions.clear();
        }
        this.wsConnections.delete(token);

        if (!authResolved) {
          clearTimeout(connectionTimeout);
          authResolved = true;
          reject(new Error('WebSocket fechado antes da autorização'));
        }
      });
    });

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
   * ✅ Envia requisição via conexão existente
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
   * ✅ Inscreve-se para atualizações via conexão existente
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

    // ✅ Aguardar primeira resposta para confirmar subscription
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.subscriptions.delete(subId);
        reject(new Error(`Timeout ao inscrever ${subId}`));
      }, timeoutMs);

      // ✅ Callback wrapper que confirma subscription na primeira mensagem
      const wrappedCallback = (msg: any) => {
        // ✅ Primeira mensagem confirma subscription
        if (msg.proposal_open_contract || msg.error) {
          clearTimeout(timeout);
          if (msg.error) {
            conn.subscriptions.delete(subId);
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
          // ✅ Subscription confirmada, substituir por callback original
          conn.subscriptions.set(subId, callback);
          resolve();
          // ✅ Chamar callback original com primeira mensagem
          callback(msg);
          return;
        }
        // ✅ Se não for primeira mensagem, já deve estar usando callback original
        callback(msg);
      };

      conn.subscriptions.set(subId, wrappedCallback);
      conn.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * ✅ Remove subscription da conexão
   */
  private removeSubscriptionFromConnection(token: string, subId: string): void {
    const conn = this.wsConnections.get(token);
    if (conn) {
      conn.subscriptions.delete(subId);
    }
  }
  // ============================================
  // LOGS PADRONIZADOS ZENIX v2.0 (Portado de Orion)
  // ============================================

  // --- CATEGORIA 1: CONFIGURAÇÃO E MONITORAMENTO ---

  private logInitialConfigV2(userId: string, config: {
    agentName: string;
    operationMode: string;
    riskProfile: string;
    profitTarget: number;
    stopLoss: number;
    stopBlindadoEnabled: boolean;
  }) {
    const message = `⚙️ CONFIGURAÇÃO INICIAL\n` +
      `• Agente: ${config.agentName}\n` +
      `• Modo: ${config.operationMode}\n` +
      `• Perfil: ${config.riskProfile}\n` +
      `• Meta Lucro: $${config.profitTarget.toFixed(2)}\n` +
      `• Stop Loss: $${config.stopLoss.toFixed(2)}\n` +
      `• Stop Blindado: ${config.stopBlindadoEnabled ? 'ATIVO 🛡️' : 'INATIVO ❌'}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'CORE', message);
  }

  private logSessionStart(userId: string, session: {
    date: Date;
    initialBalance: number;
    profitTarget: number;
    stopLoss: number;
    mode: string;
    agentName: string;
  }) {
    const message = `🚀 INICIANDO SESSÃO DE OPERAÇÕES\n` +
      `• Banca Inicial: $${session.initialBalance.toFixed(2)}\n` +
      `• Meta do Dia: +$${session.profitTarget.toFixed(2)}\n` +
      `• Stop Loss: -$${session.stopLoss.toFixed(2)}\n` +
      `• Modo: ${session.mode}\n` +
      `• Agente: ${session.agentName}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'CORE', message);
  }

  // --- CATEGORIA 2: COLETA E ANÁLISE ---

  private logDataCollection(userId: string, data: {
    targetCount: number;
    currentCount: number;
    mode?: string;
  }) {
    const modeStr = data.mode ? ` (${data.mode})` : '';
    const message = `📡 COLETANDO DADOS...\n` +
      `• META DE COLETA: ${data.targetCount} TICKS${modeStr}\n` +
      `• CONTAGEM: ${data.currentCount}/${data.targetCount}`;

    this.saveLog(userId, 'INFO', 'ANALYZER', message);
  }

  private logAnalysisStarted(userId: string, mode: string, tickCount?: number) {
    const countStr = tickCount ? ` (Ticks: ${tickCount})` : '';
    const message = `🧠 ANÁLISE DO MERCADO\n` +
      `• MODO: ${mode}\n` +
      `• STATUS: Monitorando padrões${countStr}\n` +
      `• AÇÃO: Aguardando oportunidade...`;

    this.saveLog(userId, 'INFO', 'ANALYZER', message);
  }

  private logBlockedEntry(userId: string, blocked: {
    reason: string;
    details?: string;
  }) {
    // ⏸️ ENTRADA BLOQUEADA
    const message = `⏸️ ENTRADA BLOQUEADA\n` +
      `• Motivo: ${blocked.reason}\n` +
      (blocked.details ? `• Detalhes: ${blocked.details}` : '');

    // Log debug only
    // this.logger.debug(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    // Throttled log logic handled by caller usually, but here we just save
    this.saveLog(userId, 'INFO', 'ANALYZER', message);
  }

  private logSignalGenerated(userId: string, signal: {
    mode: string;
    isRecovery: boolean;
    filters: string[];
    trigger: string;
    probability: number;
    contractType: string;
    direction?: 'CALL' | 'PUT' | 'DIGIT';
  }) {
    let message = `🔍 ANÁLISE: MODO ${signal.mode}${signal.isRecovery ? ' (RECUPERAÇÃO)' : ''}\n`;
    signal.filters.forEach((filter, index) => {
      message += `✅ FILTRO ${index + 1}: ${filter}\n`;
    });
    message += `✅ GATILHO: ${signal.trigger}\n`;
    message += `💪 FORÇA DO SINAL: ${signal.probability}%\n`;

    if (signal.direction) {
      message += `📊 ENTRADA: ${signal.contractType} ${signal.direction}`;
    } else {
      message += `📊 ENTRADA: ${signal.contractType}`;
    }

    this.logger.log(`[Falcon][${userId}] SINAL: ${signal.trigger} | ${signal.direction}`);
    this.saveLog(userId, 'INFO', 'DECISION', message);
  }

  // --- CATEGORIA 3: EXECUÇÃO E RESULTADO ---

  private logTradeResultV2(userId: string, result: {
    status: 'WIN' | 'LOSS';
    profit: number;
    stake: number;
    balance: number;
  }) {
    const profitStr = result.status === 'WIN' ? `+$${result.profit.toFixed(2)}` : `-$${result.stake.toFixed(2)}`;
    const message = `🎯 RESULTADO DA ENTRADA\n` +
      `• Status: ${result.status}\n` +
      `• Lucro/Prejuízo: ${profitStr}\n` +
      `• Saldo Atual: $${result.balance.toFixed(2)}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'EXECUTION', message);
  }

  private logSorosActivation(userId: string, soros: {
    previousProfit: number;
    stakeBase: number;
    level?: number;
  }) {
    const newStake = soros.stakeBase + soros.previousProfit;
    const level = soros.level || 1;
    const message = `🚀 APLICANDO SOROS NÍVEL ${level}\n` +
      `• Lucro Anterior: $${soros.previousProfit.toFixed(2)}\n` +
      `• Nova Stake: $${newStake.toFixed(2)}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'RISK', message);
  }

  private logWinStreak(userId: string, streak: {
    consecutiveWins: number;
    accumulatedProfit: number;
    currentStake: number;
  }) {
    const message = `🔥 SEQUÊNCIA DE VITÓRIAS!\n` +
      `• Vitórias Consecutivas: ${streak.consecutiveWins}\n` +
      `• Lucro Acumulado: $${streak.accumulatedProfit.toFixed(2)}\n` +
      `• Stake Atual: $${streak.currentStake.toFixed(2)}\n` +
      `• Próxima Vitória: Reset para Stake Base`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'RISK', message);
  }

  // --- CATEGORIA 4: RECUPERAÇÃO E RISCO ---

  private logMartingaleLevelV2(userId: string, martingale: {
    level: number;
    lossNumber: number;
    accumulatedLoss: number;
    calculatedStake: number;
    profitPercentage: number;
    maxLevel: number; // ✅ Adicionado em 2.1
    contractType: string;
  }) {
    const message = `📊 NÍVEL DE RECUPERAÇÃO\n` +
      `• Nível Atual: M${martingale.level} (${martingale.lossNumber}ª perda)\n` +
      `• Perdas Acumuladas: $${martingale.accumulatedLoss.toFixed(2)}\n` +
      `• Stake Calculada: $${martingale.calculatedStake.toFixed(2)}\n` +
      `• Objetivo: Recuperar + ${martingale.profitPercentage}%\n` +
      `• Limite Máximo: M${martingale.maxLevel}\n` +
      `• Contrato: ${martingale.contractType}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'WARN', 'RISK', message);
  }

  private logSuccessfulRecoveryV2(userId: string, recovery: {
    recoveredLoss: number;
    additionalProfit: number;
    profitPercentage: number;
    stakeBase: number;
  }) {
    const message = `✅ RECUPERAÇÃO BEM-SUCEDIDA!\n` +
      `• Perdas Recuperadas: $${recovery.recoveredLoss.toFixed(2)}\n` +
      `• Lucro Adicional: $${recovery.additionalProfit.toFixed(2)} (${recovery.profitPercentage}%)\n` +
      `• Ação: Resetando sistema e voltando à entrada principal\n` +
      `• Próxima Operação: Entrada Normal (Stake Base: $${recovery.stakeBase.toFixed(2)})`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'INFO', 'RISK', message);
  }

  private logStopLossAdjustmentV2(userId: string, adjustment: {
    calculatedStake: number;
    remainingUntilStop: number;
    adjustedStake: number;
  }) {
    const message = `⚠️ AJUSTE DE RISCO (STOP LOSS)\n` +
      `• Stake Calculada: $${adjustment.calculatedStake.toFixed(2)}\n` +
      `• Saldo Restante até Stop: $${adjustment.remainingUntilStop.toFixed(2)}\n` +
      `• Ação: Reduzindo para $${adjustment.adjustedStake.toFixed(2)}`;

    this.logger.log(`[Falcon][${userId}] ${message.replace(/\n/g, ' | ')}`);
    this.saveLog(userId, 'WARN', 'RISK', message);
  }

}

/**
 * Configuração do usuário para FALCON
 */
interface FalconUserConfig {
  userId: string;
  initialStake: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  derivToken: string;
  currency: string;
  symbol: 'R_100';
  initialBalance: number;
  stopLossType?: 'normal' | 'blindado';
  riskProfile?: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
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
  mode: 'PRECISO' | 'ULTRA' | 'HIPER';
  stopBlindadoAtivo: boolean;
  pisoBlindado: number;
  lastProfit: number;
  currentContractId: string | null;
  currentTradeId: number | null;
  isWaitingContract: boolean;
  lastContractType?: string; // ✅ Tipo do último contrato executado (para logs)
  // ✅ Campos adicionados para compatibilidade com Sentinel/Estrutura Padrão
  martingaleLevel: number;
  sorosLevel: number;
  totalLosses: number;
  recoveryAttempts: number;
  totalLossAccumulated: number; // ✅ Novo: Acumulado para recuperação
  ticksSinceLastAnalysis: number; // ✅ Novo: Avanço de Ticks
  // ✅ Campos para throttling de logs de compra negada
  lastDeniedLogTime?: number;
  lastDeniedLogData?: { probability: number; signal: string | null };
  // ✅ Novos campos para Análise FALCON 2.2
  lastSignals: Array<{ direction: string; timestamp: number }>; // Para confirmação dupla
  consecutiveLossesSinceModeChange: number; // Para ajuste de rigor por histórico
}
