import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import WebSocket from 'ws';
import { AutonomousAgentLogsStreamService } from './autonomous-agent-logs-stream.service';
import { SettingsService } from '../settings/settings.service';
import { DerivService } from '../broker/deriv.service';
import { LogQueueService } from '../utils/log-queue.service';

// ============================================
// INTERFACES E TIPOS
// ============================================

export type ContractType = 'RISE' | 'FALL' | 'HIGHER' | 'LOWER' | 'ONETOUCH' | 'NOTOUCH';
export type MartingaleLevel = 'M0' | 'M1' | 'M2';
export type TradingMode = 'veloz' | 'normal' | 'lento';
export type ManagementMode = 'conservative' | 'balanced' | 'aggressive';
export type StopLossType = 'normal' | 'blindado';

export interface PriceTick {
  value: number;
  epoch: number;
  timestamp: string;
}

interface AutonomousAgentState {
  userId: string;
  derivToken: string;
  currency: string;
  symbol: string;
  initialStake: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  initialBalance: number; // Para Stop Loss Blindado
  isOperationActive: boolean;
  martingaleLevel: MartingaleLevel;
  martingaleCount: number; // Contador para limite M5 no Conservador
  lastLossAmount: number;
  sorosLevel: number; // 0 = inativo, 1, 2
  sorosStake: number;
  sorosProfit: number; // Profit da última operação ganha no Soros (para cálculo de net_loss)
  operationsSincePause: number;
  lastTradeAt: Date | null;
  nextTradeAt: Date | null;
  dailyProfit: number;
  dailyLoss: number;
  profitPeak: number; // Pico de lucro (para Stop Loss Blindado)
  sessionDate: Date;
  tradingMode: TradingMode;
  managementMode: ManagementMode;
  stopLossType: StopLossType;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
}

interface TechnicalAnalysis {
  ema10: number;
  ema25: number;
  ema50: number;
  rsi: number;
  momentum: number;
  confidenceScore: number;
  direction: ContractType | null;
  reasoning: string;
}

interface TradeResult {
  profitLoss: number;
  status: 'WON' | 'LOST';
  exitPrice: number;
  contractId: string;
}

// ============================================
// CONFIGURAÇÕES
// ============================================

const SENTINEL_CONFIG = {
  symbol: 'R_75', // Índice de Volatilidade 75
  minIntervalSeconds: 15, // Intervalo mínimo entre operações
  maxIntervalSeconds: 90, // Intervalo máximo entre operações
  pauseAfterOperations: 75, // Pausa após N operações
  pauseMinMinutes: 5, // Pausa mínima em minutos
  pauseMaxMinutes: 15, // Pausa máxima em minutos
  contractDurationMin: 5, // Duração mínima em ticks
  contractDurationMax: 10, // Duração máxima em ticks
  // Trading Mode configurations
  tradingModes: {
    veloz: { ticksRequired: 20, minConfidenceScore: 60 },
    normal: { ticksRequired: 50, minConfidenceScore: 50 },
    lento: { ticksRequired: 100, minConfidenceScore: 80 },
  },
  // Management Mode multipliers
  managementMultipliers: {
    conservative: 1.0, // Recupera 100% (break-even)
    balanced: 1.25, // Recupera 100% + 25%
    aggressive: 1.50, // Recupera 100% + 50%
  },
  // Martingale limits
  martingaleLimits: {
    conservative: 5, // Máximo M5
    balanced: Infinity, // Ilimitado
    aggressive: Infinity, // Ilimitado
  },
};

// ============================================
// SERVICE PRINCIPAL
// ============================================

@Injectable()
export class AutonomousAgentService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousAgentService.name);
  private readonly agentStates = new Map<string, AutonomousAgentState>();
  private readonly priceHistory = new Map<string, PriceTick[]>();
  private readonly maxHistorySize = 100;
  
  // ✅ REFATORADO: Conexão WebSocket compartilhada (como a IA)
  private sharedWebSocket: WebSocket | null = null;
  private isWebSocketConnected = false;
  private sharedSubscriptionId: string | null = null;
  private sharedKeepAliveInterval: NodeJS.Timeout | null = null;
  private readonly sharedSymbol = 'R_75'; // Símbolo padrão (pode ser configurável no futuro)
  
  // ✅ OTIMIZAÇÃO 1: Pool de conexões WebSocket por token (para operações: buy, proposal)
  private wsConnectionsPool = new Map<string, {
    ws: WebSocket;
    isAuthorized: boolean;
    isReady: boolean;
    lastUsed: number;
    keepAliveInterval: NodeJS.Timeout | null;
    pendingRequests: Map<string, {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }>;
    subscriptions: Map<string, (msg: any) => void>; // ✅ Adicionar subscriptions
  }>();
  private readonly WS_POOL_MAX_IDLE_TIME = 300000; // 5 minutos de inatividade antes de fechar
  private readonly WS_POOL_KEEP_ALIVE_INTERVAL = 90000; // 90 segundos
  
  // ✅ REMOVIDO: Conexões individuais por usuário (causavam 100% CPU)
  // private wsConnections = new Map<string, WebSocket>();
  // private keepAliveIntervals = new Map<string, NodeJS.Timeout>();
  // private wsReconnectAttempts = new Map<string, { count: number; lastAttempt: number }>();
  // private wsConnecting = new Set<string>();
  
  private readonly appId = process.env.DERIV_APP_ID || '1089';
  
  // ✅ OTIMIZAÇÃO: Cache de configurações para evitar queries N+1
  private configCache = new Map<string, {
    config: any;
    timestamp: number;
  }>();
  private readonly CONFIG_CACHE_TTL = 5000; // 5 segundos (mais curto que IAs porque precisa ser mais atualizado)
  // ✅ OTIMIZAÇÃO: Flag para desabilitar logs DEBUG em produção (reduz uso de CPU)
  private readonly ENABLE_DEBUG_LOGS = process.env.NODE_ENV === 'development' || process.env.ENABLE_DEBUG_LOGS === 'true';
  
  // ✅ OTIMIZAÇÃO 3: Cache de análise técnica (por hash dos preços)
  private analysisCache = new Map<string, {
    analysis: TechnicalAnalysis;
    priceHash: string;
    timestamp: number;
  }>();
  private readonly ANALYSIS_CACHE_TTL = 1000; // 1 segundo (análise muda com cada tick)
  
  // ✅ OTIMIZAÇÃO 5: Buffer de dígitos para validação estatística (por usuário)
  private digitBuffers = new Map<string, number[]>();
  private readonly DIGIT_BUFFER_SIZE = 20;

  // ✅ OTIMIZAÇÃO 8: Cache de indicadores técnicos para cálculos incrementais
  private technicalIndicatorsCache = new Map<string, {
    ema10: number;
    ema25: number;
    ema50: number;
    rsi: number;
    rsiGains: number[];
    rsiLosses: number[];
    momentum: number;
    lastPrice: PriceTick;
    timestamp: number;
  }>();
  
  // ✅ OTIMIZAÇÃO 4: Fila de processamento de resultados de trades
  private tradeResultQueue: Array<{
    state: AutonomousAgentState;
    tradeId: number;
    result: TradeResult;
    stakeAmount: number;
  }> = [];
  private isProcessingTradeResults = false;

  // ✅ REFATORAÇÃO: Cache compartilhado de MarketAnalysis (calculado uma vez por símbolo)
  private sharedMarketAnalysisCache = new Map<string, {
    marketAnalysis: {
      probability: number;
      signal: 'CALL' | 'PUT' | 'DIGIT' | null;
      payout: number;
      confidence: number;
      details?: any;
    };
    timestamp: number;
  }>();
  private readonly MARKET_ANALYSIS_CACHE_TTL = 2000; // 2 segundos

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @Inject(AutonomousAgentLogsStreamService) private readonly logsStreamService?: AutonomousAgentLogsStreamService,
    @Optional() @Inject(SettingsService) private readonly settingsService?: SettingsService,
    @Optional() @Inject(DerivService) private readonly derivService?: DerivService,
    @Optional() private readonly logQueueService?: LogQueueService, // ✅ Serviço centralizado de logs
  ) { }

  async onModuleInit() {
    // ✅ DESATIVADO: Agente autônomo completamente desabilitado
    // Para reativar, altere IS_PAUSED para false no autonomous-agent.scheduler.ts
    this.logger.warn('⚠️ Agente Autônomo IA SENTINEL DESATIVADO - Nenhuma inicialização será executada');
    this.logger.warn('⚠️ Para reativar, altere IS_PAUSED para false no autonomous-agent.scheduler.ts');
    return; // ✅ DESATIVADO: Não inicializar nada
    
    // Código abaixo não será executado enquanto o agente estiver desativado
    this.logger.log('🚀 Agente Autônomo IA SENTINEL inicializado');
    await this.syncActiveAgentsFromDb();
    
    // ✅ REFATORADO: Inicializar conexão WebSocket compartilhada (como a IA)
    this.logger.log('🔌 Inicializando conexão WebSocket compartilhada com Deriv API...');
    try {
      await this.initializeSharedWebSocket();
      this.logger.log('✅ Conexão WebSocket compartilhada estabelecida com sucesso');
    } catch (error) {
      this.logger.error('❌ Erro ao inicializar WebSocket compartilhado:', error);
    }
  }

  // ============================================
  // HELPER: Obter token correto baseado na conta configurada
  // ============================================

  /**
   * Obtém o token correto baseado na conta configurada pelo usuário (demo/real)
   * Segue a mesma lógica da IA e do broker controller
   */
  private async getCorrectTokenForUser(userId: string, providedToken?: string): Promise<string> {
    try {
      // Se não temos os serviços necessários, usar o token fornecido
      if (!this.settingsService || !this.derivService) {
        this.logger.warn(`[GetCorrectToken] Serviços não disponíveis, usando token fornecido`);
        if (!providedToken) {
          throw new Error('Token não fornecido e serviços não disponíveis');
        }
        return providedToken;
      }

      // Obter configurações do usuário (tradeCurrency: USD, BTC, ou DEMO)
      const settings = await this.settingsService.getSettings(userId);
      const tradeCurrency = settings.tradeCurrency || 'USD';

      // Obter informações da Deriv (contas e tokens)
      const derivInfo: any = await this.derivService.connectAndGetAccount(providedToken || '', parseInt(this.appId), tradeCurrency === 'DEMO' ? 'USD' : tradeCurrency);

      if (!derivInfo) {
        this.logger.warn(`[GetCorrectToken] DerivInfo não disponível, usando token fornecido`);
        if (!providedToken) {
          throw new Error('Token não fornecido e DerivInfo não disponível');
        }
        return providedToken;
      }

      // Acessar raw se disponível (pode não estar no tipo, mas existe em runtime)
      const raw = derivInfo.raw || {};
      const tokensByLoginId = raw.tokensByLoginId || {};
      let targetLoginid: string | undefined;

      // Se for DEMO, buscar conta demo
      if (tradeCurrency === 'DEMO') {
        type AccountEntry = { value: number; loginid: string; isDemo?: boolean };
        const accountsByCurrency = raw.accountsByCurrency || derivInfo.accountsByCurrency || {};
        const allAccounts: AccountEntry[] = Object.values(accountsByCurrency).flat() as AccountEntry[];
        const usdDemoAccounts: AccountEntry[] = ((accountsByCurrency['USD'] || []) as AccountEntry[]).filter((acc) => acc.isDemo === true);

        if (usdDemoAccounts.length > 0) {
          targetLoginid = usdDemoAccounts[0].loginid;
          this.logger.log(`[GetCorrectToken] ✅ Usando conta demo USD: ${targetLoginid}`);
        } else {
          // Buscar qualquer conta demo
          const demoAccounts: AccountEntry[] = allAccounts.filter((acc) => acc.isDemo === true);
          if (demoAccounts.length > 0) {
            targetLoginid = demoAccounts[0].loginid;
            this.logger.log(`[GetCorrectToken] ✅ Usando conta demo (qualquer moeda): ${targetLoginid}`);
          } else {
            this.logger.warn(`[GetCorrectToken] ⚠️ Nenhuma conta demo encontrada, usando loginid padrão`);
            targetLoginid = derivInfo.loginid || undefined;
          }
        }
      } else {
        // Para moedas reais, usar o loginid da conta selecionada
        targetLoginid = derivInfo.loginid || undefined;
        this.logger.log(`[GetCorrectToken] Usando conta real: ${targetLoginid}`);
      }

      // Buscar token do loginid específico
      let token = (targetLoginid && tokensByLoginId[targetLoginid]) || null;

      if (!token) {
        // Fallback: usar o primeiro token disponível ou o token fornecido
        const loginIds = Object.keys(tokensByLoginId);
        if (loginIds.length > 0) {
          token = tokensByLoginId[loginIds[0]];
          this.logger.warn(`[GetCorrectToken] Token não encontrado para loginid ${targetLoginid}, usando primeiro disponível: ${loginIds[0]}`);
        } else if (providedToken) {
          token = providedToken;
          this.logger.warn(`[GetCorrectToken] Nenhum token em tokensByLoginId, usando token fornecido`);
        } else {
          throw new Error(`Token não encontrado para loginid ${targetLoginid} e nenhum token fornecido`);
        }
      }

      this.logger.log(`[GetCorrectToken] Token encontrado para loginid ${targetLoginid}: ${token ? 'SIM' : 'NÃO'}`);
      return token;
    } catch (error) {
      this.logger.error(`[GetCorrectToken] Erro ao obter token correto:`, error);
      // Fallback: usar token fornecido se disponível
      if (providedToken) {
        this.logger.warn(`[GetCorrectToken] Usando token fornecido como fallback`);
        return providedToken;
      }
      throw error;
    }
  }

  // ============================================
  // SINCRONIZAÇÃO COM BANCO
  // ============================================

  async syncActiveAgentsFromDb(): Promise<void> {
    try {
      const activeAgents = await this.dataSource.query(
        `SELECT 
          user_id,
          initial_stake,
          daily_profit_target,
          daily_loss_limit,
          initial_balance,
          deriv_token,
          currency,
          symbol,
          strategy,
          risk_level,
          trading_mode,
          stop_loss_type,
          martingale_level,
          martingale_count,
          last_loss_amount,
          soros_level,
          soros_stake,
          soros_profit,
          operations_since_pause,
          last_trade_at,
          next_trade_at,
          daily_profit,
          daily_loss,
          profit_peak,
          session_date
         FROM autonomous_agent_config
         WHERE is_active = TRUE`,
      );

      this.logger.log(`[SyncAgents] Sincronizando ${activeAgents.length} agentes ativos`);

      for (const agent of activeAgents) {
        this.upsertAgentState({
          userId: agent.user_id.toString(),
          initialStake: parseFloat(agent.initial_stake),
          dailyProfitTarget: parseFloat(agent.daily_profit_target),
          dailyLossLimit: parseFloat(agent.daily_loss_limit),
          initialBalance: parseFloat(agent.initial_balance) || 0,
          derivToken: agent.deriv_token,
          currency: agent.currency,
          symbol: agent.symbol || SENTINEL_CONFIG.symbol,
          tradingMode: (agent.trading_mode || 'normal') as TradingMode,
          managementMode: (agent.risk_level || 'balanced') as ManagementMode,
          stopLossType: (agent.stop_loss_type || 'normal') as StopLossType,
          martingaleLevel: (agent.martingale_level || 'M0') as MartingaleLevel,
          martingaleCount: agent.martingale_count || 0,
          lastLossAmount: parseFloat(agent.last_loss_amount) || 0,
          sorosLevel: agent.soros_level || 0,
          sorosStake: parseFloat(agent.soros_stake) || 0,
          sorosProfit: parseFloat(agent.soros_profit) || 0,
          operationsSincePause: agent.operations_since_pause || 0,
          lastTradeAt: agent.last_trade_at ? new Date(agent.last_trade_at) : null,
          nextTradeAt: agent.next_trade_at ? new Date(agent.next_trade_at) : null,
          dailyProfit: parseFloat(agent.daily_profit) || 0,
          dailyLoss: parseFloat(agent.daily_loss) || 0,
          profitPeak: parseFloat(agent.profit_peak) || 0,
          sessionDate: agent.session_date ? new Date(agent.session_date) : new Date(),
        });

        // ✅ OTIMIZAÇÃO CRÍTICA: Desabilitar conexões WebSocket individuais por usuário
        // Isso causa 100% de CPU com múltiplos usuários
        // Usar apenas processamento via scheduler (como a IA faz)
        // await this.ensureWebSocketConnection(agent.user_id.toString()); // DESABILITADO
      }
    } catch (error) {
      this.logger.error('[SyncAgents] Erro ao sincronizar agentes:', error);
    }
  }

  private upsertAgentState(config: {
    userId: string;
    initialStake: number;
    dailyProfitTarget: number;
    dailyLossLimit: number;
    initialBalance: number;
    derivToken: string;
    currency: string;
    symbol: string;
    tradingMode: TradingMode;
    managementMode: ManagementMode;
    stopLossType: StopLossType;
    martingaleLevel: MartingaleLevel;
    martingaleCount: number;
    lastLossAmount: number;
    sorosLevel: number;
    sorosStake: number;
    sorosProfit: number;
    operationsSincePause: number;
    lastTradeAt: Date | null;
    nextTradeAt: Date | null;
    dailyProfit: number;
    dailyLoss: number;
    profitPeak: number;
    sessionDate: Date;
  }): void {
    const existing = this.agentStates.get(config.userId);

    if (existing) {
      // Atualizar existente
      Object.assign(existing, config);
    } else {
      // Criar novo
      this.agentStates.set(config.userId, {
        userId: config.userId,
        derivToken: config.derivToken,
        currency: config.currency,
        symbol: config.symbol,
        initialStake: config.initialStake,
        dailyProfitTarget: config.dailyProfitTarget,
        dailyLossLimit: config.dailyLossLimit,
        initialBalance: config.initialBalance,
        isOperationActive: false,
        tradingMode: config.tradingMode,
        managementMode: config.managementMode,
        stopLossType: config.stopLossType,
        martingaleLevel: config.martingaleLevel,
        martingaleCount: config.martingaleCount,
        lastLossAmount: config.lastLossAmount,
        sorosLevel: config.sorosLevel,
        sorosStake: config.sorosStake,
        sorosProfit: config.sorosProfit,
        operationsSincePause: config.operationsSincePause,
        lastTradeAt: config.lastTradeAt,
        nextTradeAt: config.nextTradeAt,
        dailyProfit: config.dailyProfit,
        dailyLoss: config.dailyLoss,
        profitPeak: config.profitPeak,
        sessionDate: config.sessionDate,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
      });
    }
  }

  // ============================================
  // ATIVAÇÃO/DESATIVAÇÃO
  // ============================================

  async activateAgent(
    userId: string,
    config: {
      initialStake: number;
      dailyProfitTarget: number;
      dailyLossLimit: number;
      derivToken: string;
      currency?: string;
      symbol?: string;
      strategy?: string;
      riskLevel?: string;
      tradingMode?: string;
      stopLossType?: string;
      initialBalance?: number;
      agentType?: string; // ✅ Novo: Tipo de agente (sentinel ou falcon)
    },
  ): Promise<void> {
    try {
      // Obter token correto baseado na conta configurada pelo usuário (demo/real)
      // Isso garante que usamos a conta correta (demo ou real) conforme configurado
      const correctToken = await this.getCorrectTokenForUser(userId, config.derivToken);

      this.logger.log(`[ActivateAgent] Token obtido: ${correctToken ? 'SIM' : 'NÃO'} (original: ${config.derivToken ? 'SIM' : 'NÃO'})`);

      // Verificar se já existe configuração
      const existing = await this.dataSource.query(
        `SELECT id FROM autonomous_agent_config WHERE user_id = ?`,
        [userId],
      );

      // Usar horário atual (NOW()) para session_date quando ativar o agente
      // Isso permite calcular o tempo ativo corretamente
      const now = new Date();

      const symbol = config.symbol || SENTINEL_CONFIG.symbol;
      const strategy = config.strategy || 'arion';
      const riskLevel = config.riskLevel || 'balanced';
      const tradingMode = config.tradingMode || 'normal';
      const stopLossType = config.stopLossType || 'normal';
      const initialBalance = config.initialBalance || 0;
      const agentType = config.agentType || 'sentinel'; // ✅ Padrão: sentinel

      if (existing && existing.length > 0) {
        // Atualizar existente
        // Verificar se a coluna soros_profit existe antes de usá-la
        let updateQuery = `UPDATE autonomous_agent_config SET
            is_active = TRUE,
            initial_stake = ?,
            daily_profit_target = ?,
            daily_loss_limit = ?,
            initial_balance = ?,
            deriv_token = ?,
            currency = ?,
            symbol = ?,
            agent_type = ?,
            strategy = ?,
            risk_level = ?,
            trading_mode = ?,
            stop_loss_type = ?,
            session_date = NOW(),
            daily_profit = 0,
            daily_loss = 0,
            profit_peak = 0,
            operations_since_pause = 0,
            martingale_level = 'M0',
            martingale_count = 0,
            soros_level = 0,
            soros_stake = 0,
            session_status = 'active',
            next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
            updated_at = NOW()`;

        const updateParams = [
          config.initialStake,
          config.dailyProfitTarget,
          config.dailyLossLimit,
          initialBalance,
          correctToken, // Usar token correto baseado na conta configurada
          config.currency || 'USD',
          symbol,
          agentType, // ✅ Novo: Tipo de agente
          strategy,
          riskLevel,
          tradingMode,
          stopLossType,
          this.getRandomInterval(),
        ];

        // Tentar adicionar soros_profit se a coluna existir
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          updateQuery = updateQuery.replace(
            'soros_stake = 0,',
            'soros_stake = 0,\n            soros_profit = 0,'
          );
        } else {
          this.logger.warn(`[ActivateAgent] Coluna soros_profit não existe. Execute a migration: backend/db/add_soros_profit_to_autonomous_agent.sql`);
        }

        updateQuery += '\n           WHERE user_id = ?';
        updateParams.push(userId);

        await this.dataSource.query(updateQuery, updateParams);
      } else {
        // Criar novo
        await this.dataSource.query(
          `INSERT INTO autonomous_agent_config (
            user_id, is_active, initial_stake, daily_profit_target, daily_loss_limit, initial_balance,
            deriv_token, currency, symbol, agent_type, strategy, risk_level, trading_mode, stop_loss_type,
            session_date, session_status, next_trade_at, created_at, updated_at
          ) VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'active', DATE_ADD(NOW(), INTERVAL ? SECOND), NOW(), NOW())`,
          [
            userId,
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            initialBalance,
            correctToken, // Usar token correto baseado na conta configurada
            config.currency || 'USD',
            symbol,
            agentType, // ✅ Novo: Tipo de agente
            strategy,
            riskLevel,
            tradingMode,
            stopLossType,
            this.getRandomInterval(),
          ],
        );
      }

      // Sincronizar estado em memória
      await this.syncActiveAgentsFromDb();

      // ✅ OTIMIZAÇÃO CRÍTICA: Desabilitar conexões WebSocket individuais por usuário
      // Isso causa 100% de CPU com múltiplos usuários
      // Usar apenas processamento via scheduler (como a IA faz)
      // await this.ensureWebSocketConnection(userId); // DESABILITADO

      // Logs de validação de modos (formato da documentação)
      const tradingModeName = tradingMode === 'veloz' ? 'Veloz' : tradingMode === 'lento' ? 'Lento' : 'Normal';
      const managementModeName = riskLevel === 'conservative' ? 'Conservador' : riskLevel === 'aggressive' ? 'Agressivo' : 'Moderado';
      const stopLossName = stopLossType === 'blindado' ? 'Blindado' : 'Normal';

      this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Modo de Negociação: ${tradingModeName}`,
      );

      this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Modo de Gestão: ${managementModeName}`,
      );

      this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Tipo de Stop Loss: ${stopLossName}`,
      );

      this.saveLog(
        userId,
        'INFO',
        'CORE',
        `Agente IA SENTINEL iniciando. versão=2.0, estratégia=${strategy}, mercado=${symbol}, entrada=${config.initialStake}, meta_lucro=${config.dailyProfitTarget}, limite_perda=${config.dailyLossLimit}`,
        {
          initialStake: config.initialStake,
          dailyProfitTarget: config.dailyProfitTarget,
          dailyLossLimit: config.dailyLossLimit,
          currency: config.currency || 'USD',
          symbol,
          strategy,
          riskLevel,
        },
      );

      this.logger.log(`[ActivateAgent] ✅ Agente ativado para usuário ${userId}`);
    } catch (error) {
      this.saveLog(userId, 'ERROR', 'CORE', `Falha ao ativar agente. erro=${error.message}`);
      this.logger.error(`[ActivateAgent] ❌ Erro ao ativar agente:`, error);
      throw error;
    }
  }

  async deactivateAgent(userId: string): Promise<void> {
    try {
      if (!userId) {
        throw new Error('User ID é obrigatório para desativar agente');
      }

      this.logger.log(`[DeactivateAgent] Iniciando desativação para usuário ${userId}`);

      // ✅ 1. Atualizar banco de dados primeiro (is_active = FALSE e session_status)
      // ✅ CORREÇÃO: Usar 'stopped' ao invés de 'stopped_manual' para evitar erro de truncamento
      const updateResult = await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET is_active = FALSE, 
             session_status = 'stopped', 
             updated_at = NOW() 
         WHERE user_id = ?`,
        [userId],
      );

      this.logger.debug(`[DeactivateAgent] Query de atualização executada. Resultado:`, updateResult);

      // ✅ 2. Remover estado da memória (para parar processamento imediato)
      const state = this.agentStates.get(userId);
      if (state) {
        // Marcar como não ativo para parar qualquer processamento em andamento
        state.isOperationActive = false;
        this.agentStates.delete(userId);
        this.logger.debug(`[DeactivateAgent] Estado removido da memória para ${userId}`);
      } else {
        this.logger.debug(`[DeactivateAgent] Nenhum estado encontrado na memória para ${userId}`);
      }

      // ✅ 3. Limpar histórico de preços
      this.priceHistory.delete(userId);

      // ✅ 4. Limpar cache de análise técnica
      this.technicalIndicatorsCache.delete(userId);
      this.analysisCache.delete(userId);

      // ✅ REFATORADO: Não precisa fechar conexão individual (usando conexão compartilhada)
      // A conexão WebSocket compartilhada continua ativa para outros agentes

      // ✅ 5. Log detalhado (não bloquear se houver erro)
      try {
        this.saveLog(userId, 'INFO', 'CORE', 'Agente parado manualmente pelo usuário.');
      } catch (logError) {
        this.logger.warn(`[DeactivateAgent] Erro ao salvar log (não crítico):`, logError);
      }

      this.logger.log(`[DeactivateAgent] ✅ Agente desativado completamente para usuário ${userId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[DeactivateAgent] ❌ Erro ao desativar agente para ${userId}:`, error);
      
      // Tentar salvar log de erro (não bloquear se falhar)
      try {
        this.saveLog(userId || 'unknown', 'ERROR', 'CORE', `Falha ao desativar agente. erro=${errorMessage}`);
      } catch (logError) {
        this.logger.warn(`[DeactivateAgent] Erro ao salvar log de erro (não crítico):`, logError);
      }
      
      throw error;
    }
  }

  // ============================================
  // PROCESSAMENTO EM BACKGROUND
  // ============================================

  /**
   * ✅ OTIMIZAÇÃO 10: Processa apenas agentes que estão prontos (nextTradeAt <= now)
   */
  async processActiveAgents(): Promise<void> {
    if (this.agentStates.size === 0) {
      return;
    }

    // ✅ OTIMIZAÇÃO: Limitar número máximo de agentes processados por ciclo para evitar sobrecarga
    const MAX_AGENTS_PER_CYCLE = 20; // Processar no máximo 20 agentes por ciclo
    const BATCH_SIZE = 3; // Reduzido de 5 para 3 para reduzir carga simultânea

    const now = new Date();
    const nowTime = now.getTime();
    const activeUsers = Array.from(this.agentStates.entries());
    
    // ✅ OTIMIZAÇÃO 10: Filtrar apenas agentes prontos para processar
    const readyUsers = activeUsers.filter(([userId, state]) => {
      // Verificar se nextTradeAt já passou ou é null
      if (!state.nextTradeAt) return true;
      const nextTradeTime = new Date(state.nextTradeAt).getTime();
      return nextTradeTime <= nowTime;
    });

    if (readyUsers.length === 0) {
      this.logger.debug(`[ProcessActiveAgents] Nenhum agente pronto para processar (${activeUsers.length} ativos)`);
      return;
    }
    
    // Limitar número de agentes processados
    const usersToProcess = readyUsers.slice(0, MAX_AGENTS_PER_CYCLE);
    
    if (activeUsers.length > MAX_AGENTS_PER_CYCLE) {
      this.logger.debug(`[ProcessActiveAgents] Limitando processamento: ${activeUsers.length} agentes ativos, processando ${MAX_AGENTS_PER_CYCLE} por ciclo`);
    } else {
      this.logger.debug(`[ProcessActiveAgents] Processando ${usersToProcess.length} agente(s) ativo(s)`);
    }

    // ✅ OTIMIZAÇÃO: Buscar todas as configurações de uma vez (batch query)
    const userIds = usersToProcess.map(([userId]) => userId);
    const allConfigs = await this.getBatchConfigs(userIds);

    // ✅ OTIMIZAÇÃO: Processar usuários em batches paralelos (reduzido para 3 simultâneos) para reduzir carga de CPU
    for (let i = 0; i < usersToProcess.length; i += BATCH_SIZE) {
      const batch = usersToProcess.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(([userId, state]) =>
          this.processAgentUser(state, now, allConfigs.get(userId)).catch(error => {
            this.logger.error(`[ProcessAgent][${userId}] Erro:`, error);
          })
        )
      );
      
      // ✅ OTIMIZAÇÃO: Pequeno delay entre batches para evitar sobrecarga de CPU
      if (i + BATCH_SIZE < usersToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms entre batches
      }
    }
  }

  /**
   * ✅ OTIMIZAÇÃO 2: Busca configurações de múltiplos usuários de uma vez (batch query)
   */
  private async getBatchConfigs(userIds: string[]): Promise<Map<string, any>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const now = Date.now();
    const result = new Map<string, any>();
    const userIdsToFetch: string[] = [];

    // Verificar cache primeiro
    for (const userId of userIds) {
      const cached = this.configCache.get(userId);
      if (cached && (now - cached.timestamp) < this.CONFIG_CACHE_TTL) {
        result.set(userId, cached.config);
      } else {
        userIdsToFetch.push(userId);
      }
    }

    // Buscar apenas os que não estão em cache ou expiraram
    if (userIdsToFetch.length > 0) {
      const placeholders = userIdsToFetch.map(() => '?').join(',');
      const configs = await this.dataSource.query(
        `SELECT 
          user_id,
          last_pause_at,
          next_trade_at,
          operations_since_pause,
          session_status,
          daily_profit,
          daily_loss,
          daily_profit_target,
          daily_loss_limit,
          stop_loss_type,
          initial_balance,
          profit_peak
         FROM autonomous_agent_config 
         WHERE user_id IN (${placeholders}) AND is_active = TRUE`,
        userIdsToFetch,
      );

      // Armazenar no cache e no resultado
      for (const config of configs) {
        const userId = config.user_id.toString();
        this.configCache.set(userId, {
          config,
          timestamp: now,
        });
        result.set(userId, config);
      }
    }

    return result;
  }

  /**
   * ✅ OTIMIZADO: Processa um usuário individualmente (para processamento paralelo em batches)
   */
  private async processAgentUser(state: AutonomousAgentState, now: Date, config: any): Promise<void> {
    // Verificar se pode processar (usando config do cache)
    if (!(await this.canProcessAgent(state, config))) {
      return;
    }

    // Verificar intervalo
    if (state.nextTradeAt && state.nextTradeAt > now) {
      return;
    }

    // Verificar se está saindo de uma pausa aleatória
    if (config && config.last_pause_at && state.nextTradeAt && state.nextTradeAt <= now) {
      // Pausa acabou, logar retomada
      this.saveLog(
        state.userId,
        'INFO',
        'HUMANIZER',
        'Pausa aleatória finalizada. Retomando operações.',
        { pauseEndedAt: now.toISOString() },
      );
    }

    // Verificar pausa aleatória
    if (state.operationsSincePause >= SENTINEL_CONFIG.pauseAfterOperations) {
      await this.handleRandomPause(state);
      return;
    }

    // Processar agente
    await this.processAgent(state);
  }

  /**
   * ✅ OTIMIZADO: Verifica se pode processar agente usando config do cache
   */
  private async canProcessAgent(state: AutonomousAgentState, cachedConfig?: any): Promise<boolean> {
    if (state.isOperationActive) {
      return false;
    }

    // ✅ OTIMIZAÇÃO: Usar config do cache se disponível, senão buscar
    let cfg: any;
    if (cachedConfig) {
      cfg = cachedConfig;
    } else {
      // Fallback: buscar do banco se não veio do cache
      const config = await this.dataSource.query(
        `SELECT session_status, daily_profit, daily_loss, daily_profit_target, daily_loss_limit,
                stop_loss_type, initial_balance, profit_peak
         FROM autonomous_agent_config WHERE user_id = ? AND is_active = TRUE`,
        [state.userId],
      );

      if (!config || config.length === 0) {
        return false;
      }

      cfg = config[0];
      
      // Armazenar no cache
      this.configCache.set(state.userId, {
        config: cfg,
        timestamp: Date.now(),
      });
    }

    // Verificar stop win
    if (parseFloat(cfg.daily_profit) >= parseFloat(cfg.daily_profit_target)) {
      await this.handleStopWin(state.userId);
      return false;
    }

    // Verificar stop loss (Normal ou Blindado)
    if (cfg.stop_loss_type === 'blindado') {
      // Stop Loss Blindado Dinâmico
      // Ativa apenas se o lucro atual atingir 25% da meta
      const profitTarget = parseFloat(cfg.daily_profit_target) || 0;
      const profitPeak = parseFloat(cfg.profit_peak) || 0;

      // Só ativa a proteção se já tiver atingido 25% da meta em algum momento (pico)
      if (profitPeak >= profitTarget * 0.25) {
        const protectedProfit = profitPeak * 0.50; // Protege 50% do pico
        const initialBalance = parseFloat(cfg.initial_balance) || 0;
        const blindBalance = initialBalance + protectedProfit;
        const currentBalance = initialBalance + parseFloat(cfg.daily_profit) - parseFloat(cfg.daily_loss);

        if (currentBalance <= blindBalance) {
          this.saveLog(
            state.userId,
            'WARN',
            'RISK',
            `STOP LOSS BLINDADO ATINGIDO! Saldo atual (${currentBalance.toFixed(2)}) abaixo do saldo blindado (${blindBalance.toFixed(2)}). Pico=${profitPeak.toFixed(2)}, Protegido=${protectedProfit.toFixed(2)}.`,
          );
          // ✅ CORREÇÃO: Usar 'loss' ao invés de 'stopped_loss' para evitar erro de truncamento
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET session_status = 'loss' WHERE user_id = ?`,
            [state.userId],
          );
          return false;
        }
      }
    } else {
      // Stop Loss Normal: Verificar limite de perda
      if (parseFloat(cfg.daily_loss) >= parseFloat(cfg.daily_loss_limit)) {
        await this.handleStopLoss(state.userId);
        return false;
      }

      // Verificar se próxima entrada (com Martingale) ultrapassaria o limite
      if (state.martingaleLevel !== 'M0') {
        // Se estiver em Martingale, verificar se o próximo stake ultrapassaria o limite
        // (Isso será verificado quando calcular o stake de Martingale)
        // Por enquanto, apenas verificar o limite atual
      }
    }

    // Verificar status da sessão
    if (cfg.session_status !== 'active') {
      return false;
    }

    return true;
  }

  // ============================================
  // ANÁLISE TÉCNICA
  // ============================================

  private async processAgent(state: AutonomousAgentState): Promise<void> {
    try {
      // Obter configuração do Trading Mode
      const tradingConfig = SENTINEL_CONFIG.tradingModes[state.tradingMode];
      const ticksRequired = tradingConfig.ticksRequired;
      const minConfidenceScore = tradingConfig.minConfidenceScore;

      // ✅ REFATORAÇÃO: Obter MarketAnalysis compartilhado (calculado uma vez por símbolo)
      const marketAnalysis = await this.getSharedMarketAnalysis(state.symbol);
      
      if (!marketAnalysis) {
        this.logger.debug(`[ProcessAgent][${state.userId}] MarketAnalysis não disponível. Aguardando...`);
        const interval = Math.min(30, this.getRandomInterval());
        this.updateNextTradeAt(state.userId, interval);
        return;
      }

      // Verificar se há histórico suficiente (para validação estatística)
      const prices = await this.getPriceHistory(state.userId, state.symbol);
      if (prices.length < ticksRequired) {
        this.logger.debug(`[ProcessAgent][${state.userId}] Histórico insuficiente (${prices.length}/${ticksRequired}). Aguardando mais ticks...`);
        this.saveLog(
          state.userId,
          'DEBUG',
          'ANALYZER',
          `Histórico de preços insuficiente. atual=${prices.length}, necessário=${ticksRequired}`,
          { currentTicks: prices.length, requiredTicks: ticksRequired, tradingMode: state.tradingMode },
        );
        // Atualizar próximo trade com intervalo menor para verificar novamente
        const interval = Math.min(30, this.getRandomInterval());
        this.updateNextTradeAt(state.userId, interval); // ✅ OTIMIZADO: Não aguardar (não-bloqueante)
        return;
      }

      // Converter MarketAnalysis de volta para TechnicalAnalysis (para compatibilidade)
      const analysis: TechnicalAnalysis = {
        ema10: marketAnalysis.details?.ema10 || 0,
        ema25: marketAnalysis.details?.ema25 || 0,
        ema50: marketAnalysis.details?.ema50 || 0,
        rsi: marketAnalysis.details?.rsi || 50,
        momentum: marketAnalysis.details?.momentum || 0,
        confidenceScore: marketAnalysis.confidence,
        direction: marketAnalysis.signal === 'CALL' ? 'RISE' : 
                   marketAnalysis.signal === 'PUT' ? 'FALL' : null,
        reasoning: marketAnalysis.details?.reasoning || '',
      };

      // Log detalhado da análise
      this.logger.debug(
        `[ProcessAgent][${state.userId}] Análise: direction=${analysis.direction}, confidence=${analysis.confidenceScore.toFixed(1)}%, ema10=${analysis.ema10.toFixed(2)}, ema25=${analysis.ema25.toFixed(2)}, ema50=${analysis.ema50.toFixed(2)}, rsi=${analysis.rsi.toFixed(1)}, momentum=${analysis.momentum.toFixed(4)}`,
      );

      // Verificar score de confiança (usando mínimo do Trading Mode)
      if (marketAnalysis.confidence < minConfidenceScore) {
        this.saveLog(
          state.userId,
          'DEBUG',
          'DECISION',
          `Sinal invalidado. motivo="Pontuação de confiança muito baixa", confiança=${marketAnalysis.confidence.toFixed(1)}%, mínimo_requerido=${minConfidenceScore}%`,
          { confidence: marketAnalysis.confidence, minRequired: minConfidenceScore, tradingMode: state.tradingMode },
        );
        // Atualizar próximo trade com intervalo aleatório
        const interval = this.getRandomInterval();
        this.updateNextTradeAt(state.userId, interval); // ✅ OTIMIZADO: Não aguardar (não-bloqueante)
        // ✅ OTIMIZADO: Log DEBUG removido (reduz uso de CPU)
        return;
      }

      // Verificar confirmação estatística (dígitos) - mais flexível
      if (!(await this.validateStatisticalConfirmation(prices, analysis.direction, state.userId))) {
        this.saveLog(
          state.userId,
          'DEBUG',
          'DECISION',
          `Sinal invalidado. motivo="Confirmação estatística falhou"`,
        );
        const interval = this.getRandomInterval();
        await this.updateNextTradeAt(state.userId, interval);
        this.saveLog(
          state.userId,
          'DEBUG',
          'HUMANIZER',
          `Novo intervalo aleatório definido. duração_segundos=${interval}`,
        );
        return;
      }

      // Log de sinal encontrado (formato da documentação)
      this.saveLog(
        state.userId,
        'INFO',
        'ANALYZER',
        `Sinal encontrado. direção=${analysis.direction}, confiança=${marketAnalysis.confidence.toFixed(1)}%`,
        {
          direction: analysis.direction,
          confidence: marketAnalysis.confidence,
          ema10: analysis.ema10,
          ema25: analysis.ema25,
          ema50: analysis.ema50,
          rsi: analysis.rsi,
          momentum: analysis.momentum,
        },
      );

      this.logger.log(`[ProcessAgent][${state.userId}] ✅ Sinal válido encontrado! Executando trade...`);
      if (this.logsStreamService) {
        this.logsStreamService.addLogForUser(state.userId, 'log', 'AutonomousAgentService', `[ProcessAgent] ✅ Sinal válido encontrado! Executando trade...`);
      }

      // Executar operação
      await this.executeTrade(state, analysis);
    } catch (error) {
      this.logger.error(`[ProcessAgent][${state.userId}] Erro:`, error);
      this.saveLog(
        state.userId,
        'ERROR',
        'CORE',
        `Erro ao processar agente. erro=${error.message}`,
        { error: error.message, stack: error.stack },
      );
    }
  }

  /**
   * ✅ OTIMIZAÇÃO 3: Gera hash dos preços para cache
   */
  private generatePriceHash(prices: PriceTick[]): string {
    if (prices.length === 0) return '';
    // Usar últimos 50 preços para hash
    const recent = prices.slice(-50);
    const values = recent.map(p => p.value.toFixed(4)).join(',');
    // Hash simples (pode usar crypto se necessário)
    return `${recent.length}_${values.substring(0, 100)}`;
  }

  /**
   * ✅ REFATORAÇÃO: Converte TechnicalAnalysis para MarketAnalysis
   * Usado para compatibilidade com interface IAutonomousAgentStrategy
   */
  private convertToMarketAnalysis(
    technicalAnalysis: TechnicalAnalysis,
    payout?: number
  ): {
    probability: number;
    signal: 'CALL' | 'PUT' | 'DIGIT' | null;
    payout: number;
    confidence: number;
    details?: any;
  } {
    return {
      probability: technicalAnalysis.confidenceScore,
      signal: technicalAnalysis.direction === 'RISE' ? 'CALL' : 
              technicalAnalysis.direction === 'FALL' ? 'PUT' : null,
      payout: payout || 0, // Será obtido quando necessário
      confidence: technicalAnalysis.confidenceScore,
      details: {
        ema10: technicalAnalysis.ema10,
        ema25: technicalAnalysis.ema25,
        ema50: technicalAnalysis.ema50,
        rsi: technicalAnalysis.rsi,
        momentum: technicalAnalysis.momentum,
        direction: technicalAnalysis.direction,
        reasoning: technicalAnalysis.reasoning,
      },
    };
  }

  /**
   * ✅ REFATORAÇÃO: Obtém MarketAnalysis compartilhado para um símbolo
   * Calcula uma vez e compartilha entre todos os agentes do mesmo símbolo
   */
  private async getSharedMarketAnalysis(symbol: string): Promise<{
    probability: number;
    signal: 'CALL' | 'PUT' | 'DIGIT' | null;
    payout: number;
    confidence: number;
    details?: any;
  } | null> {
    const cacheKey = symbol;
    const cached = this.sharedMarketAnalysisCache.get(cacheKey);
    
    // Verificar se cache é válido
    if (cached && (Date.now() - cached.timestamp) < this.MARKET_ANALYSIS_CACHE_TTL) {
      return cached.marketAnalysis;
    }

    // Buscar histórico de preços (usar primeiro agente ativo do símbolo como referência)
    const activeAgentForSymbol = Array.from(this.agentStates.values())
      .find(state => state.symbol === symbol);
    
    if (!activeAgentForSymbol) {
      return null;
    }

    const prices = await this.getPriceHistory(activeAgentForSymbol.userId, symbol);
    
    if (prices.length < 20) {
      return null; // Histórico insuficiente
    }

    // Calcular análise técnica (uma vez por símbolo)
    const recentPrices = prices.slice(-50); // Usar últimos 50 ticks
    const technicalAnalysis = this.performTechnicalAnalysis(recentPrices, 'shared');

    // Converter para MarketAnalysis
    const marketAnalysis = this.convertToMarketAnalysis(technicalAnalysis);

    // Armazenar no cache compartilhado
    this.sharedMarketAnalysisCache.set(cacheKey, {
      marketAnalysis,
      timestamp: Date.now(),
    });

    return marketAnalysis;
  }

  private performTechnicalAnalysis(prices: PriceTick[], userId: string): TechnicalAnalysis {
    // ✅ OTIMIZAÇÃO 3: Verificar cache de análise técnica
    const priceHash = this.generatePriceHash(prices);
    const cached = this.analysisCache.get(userId);
    if (cached && cached.priceHash === priceHash && (Date.now() - cached.timestamp) < this.ANALYSIS_CACHE_TTL) {
      this.logger.debug(`[AnalysisCache][${userId}] Reutilizando análise técnica do cache`);
      return cached.analysis;
    }

    const values = prices.map(p => p.value);
    const recent = values.slice(-50);

    // ✅ OTIMIZAÇÃO 8: Calcular EMAs incrementalmente se possível
    const useIncremental = recent.length > 50 && this.technicalIndicatorsCache.has(userId);
    const ema10 = this.calculateEMA(recent, 10, userId, useIncremental);
    const ema25 = this.calculateEMA(recent, 25, userId, useIncremental);
    const ema50 = this.calculateEMA(recent, 50, userId, useIncremental);

    // ✅ OTIMIZAÇÃO 8: Calcular RSI incrementalmente se possível
    const rsi = this.calculateRSI(recent, 14, userId, useIncremental);

    // ✅ OTIMIZAÇÃO 8: Calcular Momentum incrementalmente
    const momentum = this.calculateMomentum(recent, 10, userId, useIncremental);

    // ✅ OTIMIZAÇÃO 8: Atualizar cache de indicadores
    if (prices.length > 0) {
      const lastPrice = prices[prices.length - 1];
      this.technicalIndicatorsCache.set(userId, {
        ema10,
        ema25,
        ema50,
        rsi,
        rsiGains: [], // Será calculado no calculateRSI se necessário
        rsiLosses: [], // Será calculado no calculateRSI se necessário
        momentum,
        lastPrice,
        timestamp: Date.now(),
      });
    }

    // Determinar direção
    let direction: ContractType | null = null;
    let confidenceScore = 0;
    let reasoning = '';

    // Calcular pontuação para cada direção (mesmo sem alinhamento perfeito)
    const riseScore = this.calculateDirectionScore(ema10, ema25, ema50, rsi, momentum, 'RISE');
    const fallScore = this.calculateDirectionScore(ema10, ema25, ema50, rsi, momentum, 'FALL');

    // Definir direção baseado na maior pontuação (se atender mínimo)
    const minScoreForDirection = 30; // Mínimo de 30% para considerar uma direção

    if (riseScore >= minScoreForDirection && riseScore > fallScore) {
      direction = 'RISE';
      confidenceScore = riseScore;
      reasoning = `Tendência de alta detectada (EMA10: ${ema10.toFixed(4)}, EMA25: ${ema25.toFixed(4)}, EMA50: ${ema50.toFixed(4)}), RSI: ${rsi.toFixed(2)}, Momentum: ${momentum.toFixed(4)}`;
    } else if (fallScore >= minScoreForDirection && fallScore > riseScore) {
      direction = 'FALL';
      confidenceScore = fallScore;
      reasoning = `Tendência de baixa detectada (EMA10: ${ema10.toFixed(4)}, EMA25: ${ema25.toFixed(4)}, EMA50: ${ema50.toFixed(4)}), RSI: ${rsi.toFixed(2)}, Momentum: ${momentum.toFixed(4)}`;
    }

    // Log de análise técnica (formato da documentação) - mostrar todas as EMAs
    this.saveLog(
      userId,
      'DEBUG',
      'ANALYZER',
      `EMA(10)=${ema10.toFixed(4)}, EMA(25)=${ema25.toFixed(4)}, EMA(50)=${ema50.toFixed(4)}, RSI(14)=${rsi.toFixed(1)}, Momentum=${momentum.toFixed(4)}`,
      { ema10, ema25, ema50, rsi, momentum },
    );

    // Log adicional quando não há direção definida para debug
    if (!direction) {
      this.saveLog(
        userId,
        'DEBUG',
        'ANALYZER',
        `Nenhuma direção definida. Pontuações: RISE=${riseScore.toFixed(1)}%, FALL=${fallScore.toFixed(1)}% (mínimo=${minScoreForDirection}%)`,
        {
          ema10, ema25, ema50, rsi, momentum,
          riseScore,
          fallScore,
          minScoreForDirection,
        },
      );
    } else {
      // Log quando direção é definida
      this.saveLog(
        userId,
        'DEBUG',
        'ANALYZER',
        `Direção ${direction} definida com confiança ${confidenceScore.toFixed(1)}%. Pontuações: RISE=${riseScore.toFixed(1)}%, FALL=${fallScore.toFixed(1)}%`,
        {
          direction,
          confidenceScore,
          riseScore,
          fallScore,
        },
      );
    }

    const analysis: TechnicalAnalysis = {
      ema10,
      ema25,
      ema50,
      rsi,
      momentum,
      confidenceScore,
      direction,
      reasoning,
    };

    // ✅ OTIMIZAÇÃO 3: Atualizar cache de análise técnica
    this.analysisCache.set(userId, {
      analysis,
      priceHash,
      timestamp: Date.now(),
    });

    return analysis;
  }

  /**
   * ✅ OTIMIZAÇÃO 8: Calcula EMA incrementalmente usando cache
   */
  private calculateEMA(values: number[], period: number, userId?: string, useCache: boolean = false): number {
    if (values.length < period) {
      return values[values.length - 1];
    }

    // ✅ OTIMIZAÇÃO 8: Usar cálculo incremental se cache disponível
    if (useCache && userId && this.technicalIndicatorsCache.has(userId)) {
      const cached = this.technicalIndicatorsCache.get(userId)!;
      const newPrice = values[values.length - 1];
      const multiplier = 2 / (period + 1);
      
      // Usar EMA anterior do cache
      let cachedEMA: number | null = null;
      if (period === 10) cachedEMA = cached.ema10;
      else if (period === 25) cachedEMA = cached.ema25;
      else if (period === 50) cachedEMA = cached.ema50;
      
      if (cachedEMA !== null && cachedEMA !== undefined) {
        // Cálculo incremental: EMA_new = (Price_new * Multiplier) + (EMA_old * (1 - Multiplier))
        const newEMA = (newPrice * multiplier) + (cachedEMA * (1 - multiplier));
        return newEMA;
      }
    }

    // Fallback: cálculo tradicional
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * ✅ OTIMIZAÇÃO 8: Calcula RSI incrementalmente usando cache
   */
  private calculateRSI(values: number[], period: number, userId?: string, useCache: boolean = false): number {
    if (values.length < period + 1) {
      return 50; // Neutro
    }

    // ✅ OTIMIZAÇÃO 8: Usar cálculo incremental se cache disponível
    if (useCache && userId && this.technicalIndicatorsCache.has(userId) && values.length > 1) {
      const cached = this.technicalIndicatorsCache.get(userId)!;
      const newPrice = values[values.length - 1];
      const oldPrice = cached.lastPrice.value;
      const change = newPrice - oldPrice;
      
      // Manter gains/losses médios anteriores (simplificado)
      // Em produção, manter array de gains/losses seria mais preciso
      const avgGain = change > 0 ? change : 0;
      const avgLoss = change < 0 ? Math.abs(change) : 0;
      
      if (avgLoss === 0 && avgGain > 0) {
        return 100;
      }
      if (avgLoss === 0) {
        return 50; // Neutro
      }
      
      const rs = avgGain / avgLoss;
      return 100 - 100 / (1 + rs);
    }

    // Fallback: cálculo tradicional
    const changes: number[] = [];
    for (let i = 1; i < values.length; i++) {
      changes.push(values[i] - values[i - 1]);
    }

    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * ✅ OTIMIZAÇÃO 8: Calcula Momentum incrementalmente usando cache
   */
  private calculateMomentum(values: number[], period: number = 10, userId?: string, useCache: boolean = false): number {
    if (values.length < period) {
      return 0;
    }

    // ✅ OTIMIZAÇÃO 8: Usar cálculo incremental se cache disponível
    if (useCache && userId && this.technicalIndicatorsCache.has(userId)) {
      const cached = this.technicalIndicatorsCache.get(userId)!;
      const newPrice = values[values.length - 1];
      // Momentum = preço atual - preço de N períodos atrás
      // Se temos cache, podemos usar o preço anterior do cache
      // Simplificado: usar diferença do último preço
      return newPrice - cached.lastPrice.value;
    }

    // Fallback: cálculo tradicional
    const current = values[values.length - 1];
    const past = values[values.length - period];
    return current - past;
  }

  // Método novo: calcula pontuação para uma direção sem exigir condições perfeitas
  private calculateDirectionScore(
    ema10: number,
    ema25: number,
    ema50: number,
    rsi: number,
    momentum: number,
    direction: ContractType,
  ): number {
    let score = 0;

    // 1. Pontuação das EMAs (40% do total)
    let emaScore = 0;
    if (direction === 'RISE') {
      // Para RISE: ema10 > ema25 > ema50 é ideal
      // Mas damos pontuação parcial mesmo se não estiver perfeito
      const ema10vs25 = ema10 > ema25 ? Math.min(20, ((ema10 - ema25) / ema25) * 1000) : 0;
      const ema25vs50 = ema25 > ema50 ? Math.min(20, ((ema25 - ema50) / ema50) * 1000) : 0;
      // Se ema10 > ema25, já temos tendência de alta (mesmo que ema25 = ema50)
      if (ema10 > ema25) {
        emaScore = ema10vs25 + (ema25vs50 > 0 ? ema25vs50 : ema10vs25 * 0.5); // Bônus se ema25 > ema50
      } else if (ema10 > ema50) {
        // ema10 está acima de ema50 mas não de ema25 - tendência fraca
        emaScore = Math.min(15, ((ema10 - ema50) / ema50) * 500);
      }
    } else {
      // Para FALL: ema10 < ema25 < ema50 é ideal
      const ema25vs10 = ema25 > ema10 ? Math.min(20, ((ema25 - ema10) / ema10) * 1000) : 0;
      const ema50vs25 = ema50 > ema25 ? Math.min(20, ((ema50 - ema25) / ema25) * 1000) : 0;
      // Se ema10 < ema25, já temos tendência de baixa
      if (ema10 < ema25) {
        emaScore = ema25vs10 + (ema50vs25 > 0 ? ema50vs25 : ema25vs10 * 0.5);
      } else if (ema10 < ema50) {
        // ema10 está abaixo de ema50 mas não de ema25 - tendência fraca
        emaScore = Math.min(15, ((ema50 - ema10) / ema10) * 500);
      }
    }
    score += Math.min(40, Math.max(0, emaScore));

    // 2. Pontuação do RSI (30% do total)
    let rsiScore = 0;
    if (direction === 'RISE') {
      // Para RISE: RSI < 70 é bom, ideal entre 30-50
      if (rsi < 30) {
        rsiScore = 0; // RSI muito baixo pode indicar sobrevenda extrema
      } else if (rsi <= 50) {
        rsiScore = 30; // Ideal para alta
      } else if (rsi < 70) {
        rsiScore = 30 * (1 - (rsi - 50) / 20); // Decai de 30 para 0 conforme RSI sobe
      } else {
        rsiScore = 0; // RSI >= 70 não é favorável para alta
      }
    } else {
      // Para FALL: RSI > 30 é bom, ideal entre 50-70
      if (rsi > 70) {
        rsiScore = 0; // RSI muito alto pode indicar sobrecompra extrema
      } else if (rsi >= 50) {
        rsiScore = 30; // Ideal para baixa
      } else if (rsi > 30) {
        rsiScore = 30 * ((rsi - 30) / 20); // Cresce de 0 para 30 conforme RSI sobe
      } else {
        rsiScore = 0; // RSI <= 30 não é favorável para baixa
      }
    }
    score += Math.min(30, Math.max(0, rsiScore));

    // 3. Pontuação do Momentum (30% do total)
    let momentumScore = 0;
    if (direction === 'RISE') {
      // Para RISE: momentum positivo é bom
      if (momentum > 0) {
        momentumScore = Math.min(30, momentum * 2); // Cada unidade de momentum = 2% de score
      } else {
        // Momentum negativo reduz a pontuação, mas não zera completamente
        momentumScore = Math.max(0, 30 + momentum * 1); // Penalidade menor
      }
    } else {
      // Para FALL: momentum negativo é bom
      if (momentum < 0) {
        momentumScore = Math.min(30, Math.abs(momentum) * 2);
      } else {
        // Momentum positivo reduz a pontuação
        momentumScore = Math.max(0, 30 - momentum * 1);
      }
    }
    score += Math.min(30, Math.max(0, momentumScore));

    return Math.min(100, Math.max(0, score));
  }

  // Método original mantido para compatibilidade (usado quando já temos direção confirmada)
  private calculateConfidenceScore(
    ema10: number,
    ema25: number,
    ema50: number,
    rsi: number,
    momentum: number,
    direction: ContractType,
  ): number {
    let score = 0;

    // Peso das EMAs (40%)
    const emaAlignment = direction === 'RISE'
      ? (ema10 - ema25) / ema25 * 100 + (ema25 - ema50) / ema50 * 100
      : (ema25 - ema10) / ema10 * 100 + (ema50 - ema25) / ema25 * 100;
    score += Math.min(40, Math.max(0, emaAlignment * 2));

    // Peso do RSI (30%)
    const rsiScore = direction === 'RISE'
      ? Math.max(0, (70 - rsi) / 70 * 30)
      : Math.max(0, (rsi - 30) / 70 * 30);
    score += rsiScore;

    // Peso do Momentum (30%)
    const momentumScore = direction === 'RISE'
      ? Math.min(30, Math.max(0, momentum * 10))
      : Math.min(30, Math.max(0, -momentum * 10));
    score += momentumScore;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * ✅ OTIMIZAÇÃO 5: Atualiza buffer de dígitos incrementalmente
   */
  private updateDigitBuffer(userId: string, price: PriceTick): void {
    if (!this.digitBuffers.has(userId)) {
      this.digitBuffers.set(userId, []);
    }
    
    const buffer = this.digitBuffers.get(userId)!;
    const str = Math.abs(price.value).toString().replace('.', '');
    const digit = parseInt(str.charAt(str.length - 1), 10);
    
    buffer.push(digit);
    if (buffer.length > this.DIGIT_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  private async validateStatisticalConfirmation(prices: PriceTick[], direction: ContractType | null, userId: string): Promise<boolean> {
    if (!direction) {
      return false;
    }

    // ✅ OTIMIZAÇÃO 5: Atualizar buffer de dígitos com último preço
    if (prices.length > 0) {
      this.updateDigitBuffer(userId, prices[prices.length - 1]);
    }

    // ✅ OTIMIZAÇÃO 5: Usar buffer ao invés de recalcular
    const buffer = this.digitBuffers.get(userId) || [];
    if (buffer.length < 20) {
      // Se buffer ainda não tem 20 dígitos, usar cálculo tradicional
      const last20 = prices.slice(-20);
      const digits = last20.map(p => {
        const str = Math.abs(p.value).toString().replace('.', '');
        return parseInt(str.charAt(str.length - 1), 10);
      });
      // Atualizar buffer com os dígitos calculados
      this.digitBuffers.set(userId, digits);
      return this.validateWithDigits(digits, direction, userId);
    }

    // Usar buffer otimizado
    return this.validateWithDigits(buffer, direction, userId);
  }

  /**
   * ✅ OTIMIZAÇÃO 5: Validação estatística usando dígitos (extraído para reutilização)
   */
  private validateWithDigits(digits: number[], direction: ContractType, userId: string): boolean {

    let imbalance = '';
    let sequenceOk = false;

    // Para RISE: verificar se >60% dos dígitos são altos (5-9)
    if (direction === 'RISE') {
      const highDigits = digits.filter(d => d >= 5).length;
      const highPercent = highDigits / digits.length;
      imbalance = `${(highPercent * 100).toFixed(0)}%_UP`;

      if (highPercent <= 0.6) {
        // Log de análise estatística (falhou)
        if (this.ENABLE_DEBUG_LOGS) {
          this.saveLog(
            userId,
            'DEBUG',
            'ANALYZER',
            `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
            { imbalance: highPercent, direction: 'RISE', highDigits, totalDigits: digits.length },
          );
        }
        return false;
      }

      // ✅ OTIMIZAÇÃO 5: Verificar sequência contrária (otimizado)
      let consecutiveLow = 0;
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] < 5) {
          consecutiveLow++;
        } else {
          break;
        }
      }
      sequenceOk = consecutiveLow < 4;

      if (consecutiveLow >= 4) {
        // Log de análise estatística (falhou por sequência)
        if (this.ENABLE_DEBUG_LOGS) {
          this.saveLog(
            userId,
            'DEBUG',
            'ANALYZER',
            `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
            { imbalance: highPercent, direction: 'RISE', consecutiveLow, sequenceOk: false },
          );
        }
        return false;
      }
    }
    // Para FALL: verificar se >60% dos dígitos são baixos (0-4)
    else if (direction === 'FALL') {
      const lowDigits = digits.filter(d => d < 5).length;
      const lowPercent = lowDigits / digits.length;
      imbalance = `${(lowPercent * 100).toFixed(0)}%_DOWN`;

      if (lowPercent <= 0.6) {
        // Log de análise estatística (falhou)
        if (this.ENABLE_DEBUG_LOGS) {
          this.saveLog(
            userId,
            'DEBUG',
            'ANALYZER',
            `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
            { imbalance: lowPercent, direction: 'FALL', lowDigits, totalDigits: digits.length },
          );
        }
        return false;
      }

      // ✅ OTIMIZAÇÃO 5: Verificar sequência contrária (otimizado)
      let consecutiveHigh = 0;
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] >= 5) {
          consecutiveHigh++;
        } else {
          break;
        }
      }
      sequenceOk = consecutiveHigh < 4;

      if (consecutiveHigh >= 4) {
        // Log de análise estatística (falhou por sequência)
        if (this.ENABLE_DEBUG_LOGS) {
          this.saveLog(
            userId,
            'DEBUG',
            'ANALYZER',
            `Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=false`,
            { imbalance: lowPercent, direction: 'FALL', consecutiveHigh, sequenceOk: false },
          );
        }
        return false;
      }
    }

    // Log de análise estatística (sucesso)
    if (this.ENABLE_DEBUG_LOGS) {
      this.saveLog(
        userId,
        'DEBUG',
        'ANALYZER',
        `📊 Análise estatística completa. desequilíbrio=${imbalance}, sequência_ok=${sequenceOk}`,
        { imbalance, direction, sequenceOk },
      );
    }

    return true;
  }

  // ============================================
  // EXECUÇÃO DE TRADES
  // ============================================

  private async executeTrade(state: AutonomousAgentState, analysis: TechnicalAnalysis): Promise<void> {
    if (!analysis.direction) {
      return;
    }

    state.isOperationActive = true;

    try {
      // Determinar tipo de contrato baseado no nível de Martingale/Soros
      let contractType: string;
      let stakeAmount: number;

      // Verificar se está em modo Soros
      if (state.sorosLevel > 0) {
        // Soros: usar stake calculado do Soros
        contractType = analysis.direction; // Rise/Fall para Soros
        stakeAmount = state.sorosStake;

        // Log de Soros ativo (formato da documentação)
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros active. level=${state.sorosLevel}, stake=${stakeAmount.toFixed(2)}, initial_stake=${state.initialStake.toFixed(2)}`,
          {
            sorosLevel: state.sorosLevel,
            sorosStake: stakeAmount,
            initialStake: state.initialStake,
          },
        );
      } else if (state.martingaleLevel === 'M0') {
        // Operação normal: Rise/Fall
        contractType = analysis.direction;
        stakeAmount = state.initialStake;

        // Log de operação normal
        this.saveLog(
          state.userId,
          'DEBUG',
          'RISK',
          `Normal operation (M0). initial_stake=${stakeAmount.toFixed(2)}, contract_type=${contractType}`,
          {
            martingaleLevel: 'M0',
            stake: stakeAmount,
            contractType,
          },
        );
      } else if (state.martingaleLevel === 'M1' || state.martingaleLevel === 'M2') {
        // Recuperação M1 ou M2: Precisa consultar payout primeiro para calcular stake
        if (state.martingaleLevel === 'M1') {
          contractType = analysis.direction === 'RISE' ? 'HIGHER' : 'LOWER';
        } else {
          contractType = analysis.direction === 'RISE' ? 'ONETOUCH' : 'NOTOUCH';
        }

        // Log antes de calcular stake de Martingale
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Calculating Martingale stake. level=${state.martingaleLevel}, contract_type=${contractType}`,
          {
            martingaleLevel: state.martingaleLevel,
            contractType,
          },
        );

        // Consultar payout e calcular stake de recuperação
        stakeAmount = await this.calculateMartingaleStake(state, contractType);

        if (stakeAmount <= 0 || !isFinite(stakeAmount)) {
          this.saveLog(
            state.userId,
            'ERROR',
            'RISK',
            `Erro ao calcular stake de Martingale. calculated_stake=${stakeAmount}, abortando operação.`,
            {
              calculatedStake: stakeAmount,
              martingaleLevel: state.martingaleLevel,
            },
          );
          state.isOperationActive = false;
          return;
        }

        // Log após calcular stake de Martingale
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Martingale stake calculated. level=${state.martingaleLevel}, calculated_stake=${stakeAmount.toFixed(2)}`,
          {
            martingaleLevel: state.martingaleLevel,
            calculatedStake: stakeAmount,
          },
        );

        // Verificar Stop Loss Normal DEPOIS de calcular stake (conforme documentação)
        const stopLossCheck = await this.checkStopLossAfterStake(state, stakeAmount);
        if (!stopLossCheck.canProceed) {
          this.saveLog(
            state.userId,
            'WARN',
            'RISK',
            `STOP LOSS NORMAL: Próxima aposta ultrapassaria limite. ${stopLossCheck.message}`,
            {
              calculatedStake: stakeAmount,
              message: stopLossCheck.message,
            },
          );
          // Ajustar stake para não ultrapassar o limite
          const config = await this.dataSource.query(
            `SELECT daily_loss_limit, daily_loss FROM autonomous_agent_config WHERE user_id = ?`,
            [state.userId],
          );

          if (config && config.length > 0) {
            const currentLoss = parseFloat(config[0].daily_loss) || 0;
            const lossLimit = parseFloat(config[0].daily_loss_limit) || 0;
            const maxAllowedStake = lossLimit - currentLoss;

            if (maxAllowedStake > 0 && maxAllowedStake < stakeAmount) {
              stakeAmount = maxAllowedStake;
              this.saveLog(
                state.userId,
                'WARN',
                'RISK',
                `Stake ajustado para não ultrapassar limite. novo_stake=${stakeAmount.toFixed(2)}`,
              );
            } else {
              // Não há espaço para operar
              state.isOperationActive = false;
              return;
            }
          } else {
            state.isOperationActive = false;
            return;
          }
        }
      } else {
        // Fallback
        contractType = analysis.direction;
        stakeAmount = state.initialStake;
      }

      // Duração dinâmica (5-10 ticks)
      const duration = Math.floor(
        Math.random() * (SENTINEL_CONFIG.contractDurationMax - SENTINEL_CONFIG.contractDurationMin + 1) +
        SENTINEL_CONFIG.contractDurationMin,
      );

      // Log de proposta enviada (formato da documentação)
      this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Proposal sent. contract_type=${contractType}, stake=${stakeAmount.toFixed(2)}`,
        {
          direction: contractType,
          stake: stakeAmount,
          duration,
          martingaleLevel: state.martingaleLevel,
        },
      );

      // Criar registro no banco (payout será atualizado após consulta via API)
      const tradeId = await this.createTradeRecord(state, {
        contractType: contractType as ContractType,
        stakeAmount,
        duration,
        analysis,
        payout: 0, // Será atualizado após consulta via API
      });

      // Executar na Deriv
      const result = await this.executeTradeOnDeriv({
        tradeId,
        state,
        contractType: contractType as ContractType,
        stakeAmount,
        duration,
      });

      // Log de compra executada (formato da documentação)
      if (result.contractId) {
        this.saveLog(
          state.userId,
          'INFO',
          'TRADER',
          `Buy order executed. contract_id=${result.contractId}`,
          { contractId: result.contractId },
        );
      }

      // Log antes de processar resultado
      this.saveLog(
        state.userId,
        'DEBUG',
        'RISK',
        `Processing trade result. trade_id=${tradeId}, profit_loss=${result.profitLoss.toFixed(2)}, status=${result.status}, stake=${stakeAmount.toFixed(2)}`,
        {
          tradeId,
          profitLoss: result.profitLoss,
          status: result.status,
          stake: stakeAmount,
          martingaleLevel: state.martingaleLevel,
          sorosLevel: state.sorosLevel,
        },
      );

      // ✅ OTIMIZAÇÃO 4: Adicionar à fila de processamento assíncrono
      this.tradeResultQueue.push({ state, tradeId, result, stakeAmount });
      this.processTradeResultQueue(); // Processar em background (não aguardar)

      // Verificar se precisa de pausa aleatória
      if (state.operationsSincePause >= SENTINEL_CONFIG.pauseAfterOperations) {
        await this.handleRandomPause(state);
        // Log de fim da pausa será feito quando o agente retomar
        return;
      }

      // Atualizar próximo trade com intervalo aleatório
      const interval = this.getRandomInterval();
      this.updateNextTradeAt(state.userId, interval); // ✅ OTIMIZADO: Não aguardar (não-bloqueante)
      // ✅ OTIMIZADO: Log DEBUG removido (reduz uso de CPU)
      state.operationsSincePause++;
    } catch (error) {
      this.logger.error(`[ExecuteTrade][${state.userId}] Erro:`, error);
      state.isOperationActive = false;
    }
  }


  private async createTradeRecord(
    state: AutonomousAgentState,
    trade: {
      contractType: ContractType;
      stakeAmount: number;
      duration: number;
      analysis: TechnicalAnalysis;
      payout: number;
    },
  ): Promise<number> {
    const analysisData = {
      ema10: trade.analysis.ema10,
      ema25: trade.analysis.ema25,
      ema50: trade.analysis.ema50,
      rsi: trade.analysis.rsi,
      momentum: trade.analysis.momentum,
      reasoning: trade.analysis.reasoning,
    };

    const result = await this.dataSource.query(
      `INSERT INTO autonomous_agent_trades (
        user_id, analysis_data, confidence_score, analysis_reasoning,
        contract_type, contract_duration, entry_price, stake_amount,
        martingale_level, payout, symbol, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())`,
      [
        state.userId,
        JSON.stringify(analysisData),
        trade.analysis.confidenceScore,
        trade.analysis.reasoning,
        trade.contractType,
        trade.duration,
        0, // Será atualizado após proposta
        trade.stakeAmount,
        state.martingaleLevel,
        trade.payout,
        state.symbol,
      ],
    );

    return result.insertId;
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Executa trade usando pool de conexões WebSocket
   */
  private async executeTradeOnDeriv(params: {
    tradeId: number;
    state: AutonomousAgentState;
    contractType: ContractType;
    stakeAmount: number;
    duration: number;
  }): Promise<TradeResult> {
    const { tradeId, state, contractType, stakeAmount, duration } = params;

    // Verificar se o token existe
    if (!state.derivToken) {
      return Promise.reject(new Error('Token Deriv não configurado'));
    }

    try {
      // ✅ OTIMIZAÇÃO 1: Usar pool de conexões ao invés de criar nova
      const token = state.derivToken;

      // Mapear RISE/FALL para CALL/PUT (Deriv API espera CALL/PUT para R_75)
      let derivContractType: string;
      if (contractType === 'RISE') {
        derivContractType = 'CALL';
      } else if (contractType === 'FALL') {
        derivContractType = 'PUT';
      } else {
        derivContractType = contractType;
      }

      this.logger.log(`[ExecuteTrade][Pool] Iniciando trade ${tradeId} via pool`);
      this.saveLog(state.userId, 'INFO', 'API', 'Conexão WebSocket estabelecida via pool.');

      // ✅ PASSO 1: Solicitar proposal
      const proposalPayload = {
        proposal: 1,
        amount: stakeAmount,
        basis: 'stake',
        contract_type: derivContractType,
        currency: state.currency || 'USD',
        duration: duration,
        duration_unit: 't',
        symbol: state.symbol,
      };

      this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Querying payout for contract_type=${contractType} (Deriv: ${derivContractType})`,
        {
          contractType,
          derivContractType,
          martingaleLevel: state.martingaleLevel,
          sorosLevel: state.sorosLevel,
        },
      );

      const proposalResponse: any = await this.sendRequestViaPool(token, proposalPayload, 60000);

      // Verificar erros na proposta
      if (proposalResponse.error) {
        const errorMessage = proposalResponse.error.message || proposalResponse.error.code || JSON.stringify(proposalResponse.error);
        this.logger.error(`[ExecuteTrade][Pool] Erro na proposta. trade_id=${tradeId}, error=`, proposalResponse.error);
        this.saveLog(
          state.userId,
          'ERROR',
          'API',
          `Erro da Deriv API. erro=${errorMessage}`,
          {
            error: proposalResponse.error,
            tradeId,
            contractType,
            derivContractType,
            stakeAmount,
            duration,
            symbol: state.symbol,
            currency: state.currency,
          },
        );
        await this.dataSource.query(
          'UPDATE autonomous_agent_trades SET status = ?, error_message = ? WHERE id = ?',
          ['ERROR', errorMessage, tradeId],
        );
        throw new Error(errorMessage);
      }

      const proposal = proposalResponse.proposal;
      if (!proposal || !proposal.id) {
        const errorMsg = 'Proposta inválida';
        this.saveLog(state.userId, 'ERROR', 'TRADER', `Proposta inválida. trade_id=${tradeId}`, { tradeId, proposal });
        await this.dataSource.query(
          'UPDATE autonomous_agent_trades SET status = ?, error_message = ? WHERE id = ?',
          ['ERROR', errorMsg, tradeId],
        );
        throw new Error(errorMsg);
      }

      const proposalId = proposal.id;
      const proposalPrice = Number(proposal.ask_price || stakeAmount);
      const payoutAbsolute = Number(proposal.payout || 0);

      // Atualizar payout no banco
      if (payoutAbsolute > 0) {
        const payoutLiquido = payoutAbsolute - stakeAmount;
        await this.dataSource.query(
          'UPDATE autonomous_agent_trades SET payout = ? WHERE id = ?',
          [payoutLiquido, tradeId],
        );

        const payoutPercentual = proposalPrice > 0 ? ((payoutAbsolute / proposalPrice - 1) * 100) : 0;
        const payoutCliente = payoutPercentual - 3;

        this.saveLog(
          state.userId,
          'DEBUG',
          'TRADER',
          `Payout from Deriv: ${payoutPercentual.toFixed(2)}%`,
          { payoutPercentual, payoutAbsolute, proposalPrice },
        );

        this.saveLog(
          state.userId,
          'DEBUG',
          'TRADER',
          `Payout ZENIX (after 3% markup): ${payoutCliente.toFixed(2)}%`,
          { payoutCliente, payoutPercentual, markup: 3 },
        );
      }

      // ✅ PASSO 2: Comprar contrato
      const buyPayload = {
        buy: proposalId,
        price: proposalPrice,
      };

      this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Proposal received. Sending buy order. trade_id=${tradeId}, proposal_id=${proposalId}, price=${proposalPrice.toFixed(2)}`,
        { tradeId, proposalId, proposalPrice },
      );

      const buyResponse: any = await this.sendRequestViaPool(token, buyPayload, 60000);

      // Verificar erros na compra
      if (buyResponse.error) {
        const errorMessage = buyResponse.error.message || buyResponse.error.code || JSON.stringify(buyResponse.error);
        this.logger.error(`[ExecuteTrade][Pool] Erro na compra. trade_id=${tradeId}, error=`, buyResponse.error);
        this.saveLog(
          state.userId,
          'ERROR',
          'TRADER',
          `Compra não confirmada. trade_id=${tradeId}`,
          { tradeId, buy: buyResponse },
        );
        await this.dataSource.query(
          'UPDATE autonomous_agent_trades SET status = ?, error_message = ? WHERE id = ?',
          ['ERROR', errorMessage, tradeId],
        );
        throw new Error(errorMessage);
      }

      const buy = buyResponse.buy;
      if (!buy || !buy.contract_id) {
        const errorMsg = 'Compra não confirmada';
        this.saveLog(state.userId, 'ERROR', 'TRADER', `Compra não confirmada. trade_id=${tradeId}`, { tradeId, buy });
        await this.dataSource.query(
          'UPDATE autonomous_agent_trades SET status = ?, error_message = ? WHERE id = ?',
          ['ERROR', errorMsg, tradeId],
        );
        throw new Error(errorMsg);
      }

      const contractId = buy.contract_id;
      const buyPrice = Number(buy.buy_price || stakeAmount);
      const entrySpot = Number(
        buy.entry_spot ||
        buy.spot ||
        buy.current_spot ||
        buy.entry_tick ||
        0
      );

      // Extrair payout da resposta do buy (se disponível)
      const payoutAbsoluteFromBuy = Number(buy.payout || 0);
      if (payoutAbsoluteFromBuy > 0) {
        const payoutLiquido = payoutAbsoluteFromBuy - stakeAmount;
        await this.dataSource.query(
          'UPDATE autonomous_agent_trades SET payout = ? WHERE id = ?',
          [payoutLiquido, tradeId],
        );
      }

      // Atualizar contrato no banco
      await this.dataSource.query(
        `UPDATE autonomous_agent_trades 
         SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
         WHERE id = ?`,
        [contractId, entrySpot, tradeId],
      );

      this.logger.log(`[ExecuteTrade][Pool] ✅ entry_price atualizado no banco | tradeId=${tradeId} | entryPrice=${entrySpot}`);
      this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Buy order executed. contract_id=${contractId}, trade_id=${tradeId}, entry_price=${entrySpot.toFixed(2)}`,
        { tradeId, contractId, entryPrice: entrySpot, buyPrice },
      );

      // ✅ PASSO 3: Monitorar contrato usando subscription no pool
      return new Promise<TradeResult>((resolve, reject) => {
        let hasResolved = false;
        const contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[ExecuteTrade][Pool] ⏱️ Timeout ao monitorar contrato (90s) | ContractId: ${contractId}`);
            this.removeSubscriptionFromPool(token, contractId);
            reject(new Error('Timeout ao monitorar contrato'));
          }
        }, 90000);

        // Inscrever para atualizações do contrato
        this.subscribeViaPool(
          token,
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          async (msg: any) => {
            try {
              // Verificar erros
              if (msg.error) {
                this.logger.error(`[ExecuteTrade][Pool] ❌ Erro na subscription do contrato ${contractId}: ${JSON.stringify(msg.error)}`);
                if (!hasResolved) {
                  hasResolved = true;
                  clearTimeout(contractMonitorTimeout);
                  this.removeSubscriptionFromPool(token, contractId);
                  reject(new Error(msg.error.message || 'Erro na subscription'));
                }
                return;
              }

              const contract = msg.proposal_open_contract;
              if (!contract) {
                return;
              }

              // Se contrato ainda não foi vendido, apenas atualizar entry_price se necessário
              if (contract.is_sold !== 1) {
                const contractEntrySpot = Number(
                  contract.entry_spot ||
                  contract.entry_tick ||
                  contract.spot ||
                  0
                );

                if (contractEntrySpot > 0) {
                  const currentTrade = await this.dataSource.query(
                    'SELECT entry_price FROM autonomous_agent_trades WHERE id = ?',
                    [tradeId],
                  );

                  if (currentTrade && currentTrade.length > 0 &&
                    (currentTrade[0].entry_price === 0 || currentTrade[0].entry_price === null)) {
                    await this.dataSource.query(
                      `UPDATE autonomous_agent_trades 
                       SET entry_price = ? 
                       WHERE id = ? AND (entry_price = 0 OR entry_price IS NULL)`,
                      [contractEntrySpot, tradeId],
                    );
                  }
                }

                // Obter payout via proposal_open_contract se não foi obtido
                if (contract.payout && contract.buy_price) {
                  const payoutAbs = Number(contract.payout || 0);
                  const buyP = Number(contract.buy_price || stakeAmount);
                  if (payoutAbs > 0) {
                    const payoutLiq = payoutAbs - stakeAmount;
                    await this.dataSource.query(
                      'UPDATE autonomous_agent_trades SET payout = ? WHERE id = ?',
                      [payoutLiq, tradeId],
                    );
                  }
                }

                return; // Ainda não foi vendido, continuar monitorando
              }

              // Contrato foi vendido - processar resultado
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(contractMonitorTimeout);
                this.removeSubscriptionFromPool(token, contractId);

                const profit = Number(contract.profit || 0);
                const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
                const status = profit >= 0 ? 'WON' : 'LOST';

                this.logger.log(
                  `[ExecuteTrade][Pool] Atualizando exit_price | tradeId=${tradeId} | exitPrice=${exitPrice} | profit=${profit} | status=${status}`,
                );

                await this.dataSource.query(
                  `UPDATE autonomous_agent_trades
                   SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
                   WHERE id = ?`,
                  [exitPrice, profit, status, tradeId],
                );

                if (status === 'WON') {
                  this.saveLog(
                    state.userId,
                    'INFO',
                    'RISK',
                    `Trade WIN. profit=${profit.toFixed(2)}`,
                    { result: status, profit, contractId, exitPrice },
                  );
                } else {
                  this.saveLog(
                    state.userId,
                    'ERROR',
                    'RISK',
                    `Trade LOSS. loss=${Math.abs(profit).toFixed(2)}`,
                    { result: status, profit, contractId, exitPrice },
                  );
                }

                resolve({
                  profitLoss: profit,
                  status,
                  exitPrice,
                  contractId,
                });
              }
            } catch (error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(contractMonitorTimeout);
                this.removeSubscriptionFromPool(token, contractId);
                reject(error);
              }
            }
          },
          contractId, // Usar contractId como subId
          90000
        ).catch((error) => {
          if (!hasResolved) {
            hasResolved = true;
            clearTimeout(contractMonitorTimeout);
            reject(error);
          }
        });
      });
    } catch (error) {
      this.logger.error(`[ExecuteTrade][Pool] Erro ao executar trade ${tradeId}:`, error);
      throw error;
    }
  }


  /**
   * Verifica se a coluna soros_profit existe no banco de dados
   * Retorna true se existir, false caso contrário
   */
  private async hasSorosProfitColumn(): Promise<boolean> {
    try {
      const result = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'autonomous_agent_config' 
         AND COLUMN_NAME = 'soros_profit'`
      );
      return result && result.length > 0 && result[0].count > 0;
    } catch (error) {
      this.logger.warn(`[HasSorosProfitColumn] Erro ao verificar coluna: ${error.message}`);
      return false;
    }
  }

  // Verificar Stop Loss Normal DEPOIS de calcular stake (conforme documentação)
  private async checkStopLossAfterStake(
    state: AutonomousAgentState,
    calculatedStake: number,
  ): Promise<{ canProceed: boolean; message?: string }> {
    try {
      // Obter configuração do Stop Loss
      const config = await this.dataSource.query(
        `SELECT stop_loss_type, daily_loss_limit, daily_loss, daily_profit_target, profit_peak, initial_balance, daily_profit FROM autonomous_agent_config WHERE user_id = ?`,
        [state.userId],
      );

      if (config && config.length > 0) {
        const cfg = config[0];

        // Se for Stop Loss Blindado
        if (cfg.stop_loss_type === 'blindado') {
          // Calcular limite blindado
          const profitTarget = parseFloat(cfg.daily_profit_target) || 0;
          const profitPeak = parseFloat(cfg.profit_peak) || 0;

          // Só verificar se já tiver ativado (atingido 25% da meta)
          if (profitPeak >= profitTarget * 0.25) {
            const protectedProfit = profitPeak * 0.50; // Protege 50% do pico
            const initialBalance = parseFloat(cfg.initial_balance) || 0;
            const blindBalance = initialBalance + protectedProfit;
            const currentBalance = initialBalance + parseFloat(cfg.daily_profit) - parseFloat(cfg.daily_loss);

            // Quanto ainda podemos perder até bater no blindBalance?
            const allowedLoss = currentBalance - blindBalance;

            if (calculatedStake > allowedLoss) {
              // Stake ultrapassa o permitido pelo stop blindado
              // Retornar falso e informar qual é o máximo permitido
              // Nota: se allowedLoss for negativo ou zero, o canProcessAgent já deve ter bloqueado, mas verificamos aqui também
              if (allowedLoss <= 0) {
                return {
                  canProceed: false,
                  message: `Stop Loss Blindado atingido. Saldo protegido: ${blindBalance.toFixed(2)}`,
                };
              }

              return {
                canProceed: false,
                message: `Stake (${calculatedStake.toFixed(2)}) ultrapassa limite do Stop Blindado. Máximo permitido: ${allowedLoss.toFixed(2)}`,
              };
            }
          }

          // Se não ativou ainda ou se o stake cabe no limite, prosseguir
          return { canProceed: true };
        }

        // Para Stop Loss Normal: verificar se o stake calculado ultrapassaria o limite
        const currentLoss = parseFloat(cfg.daily_loss) || 0;
        const lossLimit = parseFloat(cfg.daily_loss_limit) || 0;

        if (currentLoss >= lossLimit) {
          return {
            canProceed: false,
            message: `Limite de perda diária atingido (${currentLoss.toFixed(2)} >= ${lossLimit.toFixed(2)})`,
          };
        }

        // Verificar se a próxima perda potencial (stake calculado) ultrapassaria o limite
        const potentialLoss = currentLoss + calculatedStake;
        if (potentialLoss > lossLimit) {
          return {
            canProceed: false,
            message: `Stake calculado (${calculatedStake.toFixed(2)}) ultrapassaria limite. perda_atual=${currentLoss.toFixed(2)}, limite=${lossLimit.toFixed(2)}, potencial=${potentialLoss.toFixed(2)}`,
          };
        }
      }

      return { canProceed: true };
    } catch (error) {
      this.logger.error(`[CheckStopLossAfterStake][${state.userId}] Erro:`, error);
      return { canProceed: true }; // Em caso de erro, permitir prosseguir
    }
  }

  // Método auxiliar para consultar payout e calcular stake de Martingale
  private async calculateMartingaleStake(state: AutonomousAgentState, contractType: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      // ✅ Adicionar header Origin para melhor compatibilidade
      const ws = new WebSocket(endpoint, {
        headers: { Origin: 'https://app.deriv.com' },
      });
      let isCompleted = false;

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          ws.close();
          reject(new Error('Timeout ao consultar payout'));
        }
      }, 10000);

      const finalize = (error?: Error, stake?: number) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (e) { }
        if (error) {
          reject(error);
        } else {
          resolve(stake || 0);
        }
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            finalize(new Error(msg.error.message || 'Erro ao consultar payout'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            // Mapear RISE/FALL para CALL/PUT (Deriv API espera CALL/PUT para R_75)
            let derivContractType: string;
            if (contractType === 'RISE') {
              derivContractType = 'CALL';
            } else if (contractType === 'FALL') {
              derivContractType = 'PUT';
            } else {
              // Para outros tipos (HIGHER, LOWER, ONETOUCH, NOTOUCH), usar como está
              derivContractType = contractType;
            }

            // Log de consulta de payout (formato da documentação)
            this.saveLog(
              state.userId,
              'INFO',
              'TRADER',
              `Querying payout for contract_type=${contractType} (Deriv: ${derivContractType})`,
            );

            // Enviar proposal para consultar payout (usar stake mínimo para consulta)
            ws.send(JSON.stringify({
              proposal: 1,
              amount: 1, // Stake mínimo para consulta
              basis: 'stake',
              contract_type: derivContractType, // Usar o tipo mapeado
              currency: state.currency || 'USD', // Garantir que currency existe
              duration: 7,
              duration_unit: 't',
              symbol: state.symbol,
            }));
            return;
          }

          if (msg.msg_type === 'proposal') {
            const proposal = msg.proposal;
            if (!proposal) {
              finalize(new Error('Proposta inválida'));
              return;
            }

            const askPrice = Number(proposal.ask_price || 1);
            const payoutAbsolute = Number(proposal.payout || 0);

            // Calcular payout percentual: (payout / ask_price - 1) × 100
            const payoutPercentual = askPrice > 0
              ? ((payoutAbsolute / askPrice - 1) * 100)
              : 0;

            // Calcular payout_cliente = payout_original - 3%
            const payoutCliente = payoutPercentual - 3;

            // Logs de payout (formato da documentação)
            this.saveLog(
              state.userId,
              'DEBUG',
              'TRADER',
              `Payout from Deriv: ${payoutPercentual.toFixed(2)}%`,
            );

            this.saveLog(
              state.userId,
              'DEBUG',
              'TRADER',
              `Payout ZENIX (after 3% markup): ${payoutCliente.toFixed(2)}%`,
            );

            if (payoutCliente <= 0) {
              finalize(new Error('Payout cliente inválido'));
              return;
            }

            // Obter perdas acumuladas
            const config = await this.dataSource.query(
              `SELECT daily_loss, risk_level FROM autonomous_agent_config WHERE user_id = ?`,
              [state.userId],
            );

            const totalLosses = config && config.length > 0
              ? parseFloat(config[0].daily_loss) || 0
              : 0;

            const mode = config && config.length > 0
              ? config[0].risk_level || 'balanced'
              : 'balanced';

            // Obter multiplicador do modo
            const multiplier = SENTINEL_CONFIG.managementMultipliers[mode as ManagementMode] || 1.25;

            // Calcular meta de lucro
            const targetProfit = totalLosses * multiplier;

            // Calcular stake: (meta × 100) / payout_cliente
            const recoveryStake = (targetProfit * 100) / payoutCliente;

            // Log do cálculo (formato da documentação)
            const modeName = mode === 'conservative' ? 'Conservador' : mode === 'aggressive' ? 'Agressivo' : 'Moderado';
            this.saveLog(
              state.userId,
              'INFO',
              'RISK',
              `Calculating recovery stake. total_losses=${totalLosses.toFixed(2)}, mode=${modeName}, multiplier=${multiplier.toFixed(2)}`,
              {
                totalLosses,
                mode: modeName,
                multiplier,
              },
            );

            this.saveLog(
              state.userId,
              'DEBUG',
              'RISK',
              `Target profit: ${targetProfit.toFixed(2)}, payout: ${payoutCliente.toFixed(2)}%, stake: ${recoveryStake.toFixed(2)}`,
              {
                targetProfit,
                payoutCliente,
                recoveryStake,
                calculation: `(targetProfit * 100) / payoutCliente = (${targetProfit.toFixed(2)} * 100) / ${payoutCliente.toFixed(2)} = ${recoveryStake.toFixed(2)}`,
              },
            );

            finalize(undefined, recoveryStake);
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (error) => finalize(error));
      ws.on('close', () => {
        if (!isCompleted) {
          finalize(new Error('WebSocket fechado inesperadamente'));
        }
      });
    });
  }

  private async handleTradeResult(
    state: AutonomousAgentState,
    tradeId: number,
    result: TradeResult,
    stakeAmount: number,
  ): Promise<void> {
    // Log de entrada no handleTradeResult
    this.logger.log(`[HandleTradeResult][${state.userId}] Iniciando processamento. trade_id=${tradeId}, status=${result.status}, profit_loss=${result.profitLoss.toFixed(2)}`);

    this.saveLog(
      state.userId,
      'DEBUG',
      'RISK',
      `handleTradeResult called. trade_id=${tradeId}, status=${result.status}, profit_loss=${result.profitLoss.toFixed(2)}, stake=${stakeAmount.toFixed(2)}, martingale=${state.martingaleLevel}, soros=${state.sorosLevel}`,
      {
        tradeId,
        result: result.status,
        profitLoss: result.profitLoss,
        stake: stakeAmount,
        martingaleLevelBefore: state.martingaleLevel,
        sorosLevelBefore: state.sorosLevel,
      },
    );

    const won = result.status === 'WON';

    // ✅ OTIMIZAÇÃO 9: Atualizar estado em memória primeiro
    state.dailyProfit += won ? result.profitLoss : 0;
    state.dailyLoss += won ? 0 : Math.abs(result.profitLoss);
    state.totalTrades = (state.totalTrades || 0) + 1;
    if (won) {
      state.totalWins = (state.totalWins || 0) + 1;
    } else {
      state.totalLosses = (state.totalLosses || 0) + 1;
    }

    // ✅ OTIMIZAÇÃO 9: Persistir no banco (query já otimizada - uma única query)
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET
        total_trades = total_trades + 1,
        ${won ? 'total_wins = total_wins + 1' : 'total_losses = total_losses + 1'},
        daily_profit = daily_profit + ?,
        daily_loss = daily_loss + ?,
        last_trade_at = NOW(),
        operations_since_pause = operations_since_pause + 1,
        updated_at = NOW()
       WHERE user_id = ?`,
      [won ? result.profitLoss : 0, won ? 0 : Math.abs(result.profitLoss), state.userId],
    );

    if (won) {
      // Vitória: Processar Soros ou resetar Martingale
      // Seguindo a ordem exata da documentação:
      // 1. Verificar Soros primeiro
      // 2. Se não estiver em Soros, verificar Martingale
      // 3. Se estiver em Martingale, resetar E ativar Soros
      // 4. Se não estiver em Martingale, ativar Soros
      state.dailyProfit += result.profitLoss;

      // Atualizar profit_peak para Stop Loss Blindado
      if (state.dailyProfit > state.profitPeak) {
        state.profitPeak = state.dailyProfit;
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET profit_peak = ? WHERE user_id = ?`,
          [state.profitPeak, state.userId],
        );
      }

      // 1. Verificar Soros primeiro (conforme documentação)
      if (state.sorosLevel === 1) {
        // Vitória no Soros 1 -> Vai para o Nível 2
        // Armazenar profit da última operação (conforme documentação)
        const nextStake = stakeAmount + result.profitLoss;
        state.sorosLevel = 2;
        state.sorosStake = nextStake;
        state.sorosProfit = result.profitLoss; // Profit da última operação ganha

        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 2, soros_stake = ?, soros_profit = ? WHERE user_id = ?`,
            [nextStake, result.profitLoss, state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 2, soros_stake = ? WHERE user_id = ?`,
            [nextStake, state.userId],
          );
        }
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros active. level=2, stake=${nextStake.toFixed(2)}, previous_stake=${stakeAmount.toFixed(2)}, profit=${result.profitLoss.toFixed(2)}`,
          {
            sorosLevelBefore: 1,
            sorosLevelAfter: 2,
            sorosStakeBefore: stakeAmount,
            sorosStakeAfter: nextStake,
            profit: result.profitLoss,
          },
        );
      } else if (state.sorosLevel === 2) {
        // Vitória no Soros 2 -> Ciclo completo!
        state.sorosLevel = 0;
        state.sorosStake = 0;
        state.sorosProfit = 0.0; // Resetar profit (conforme documentação)

        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0, soros_profit = 0 WHERE user_id = ?`,
            [state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0 WHERE user_id = ?`,
            [state.userId],
          );
        }
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros complete. Cycle finished. Returning to initial stake. profit=${result.profitLoss.toFixed(2)}, initial_stake=${state.initialStake.toFixed(2)}`,
          {
            sorosLevelBefore: 2,
            sorosLevelAfter: 0,
            profit: result.profitLoss,
            initialStake: state.initialStake,
          },
        );
      } else if (state.martingaleLevel !== 'M0') {
        // 2. Se não estiver em Soros, verificar Martingale
        // 3. Vitória na recuperação -> Reseta tudo e ativa Soros 1
        const martingaleLevelBefore = state.martingaleLevel;
        state.martingaleLevel = 'M0';
        state.martingaleCount = 0;
        state.lastLossAmount = 0;

        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET
            martingale_level = 'M0',
            martingale_count = 0,
            last_loss_amount = 0
           WHERE user_id = ?`,
          [state.userId],
        );

        // Log de reset do Martingale
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Martingale resetado. motivo=OperaçãoGanhou, lucro=${result.profitLoss.toFixed(2)}, level_anterior=${martingaleLevelBefore}`,
          {
            martingaleLevelBefore,
            martingaleLevelAfter: 'M0',
            profit: result.profitLoss,
            reason: 'OperaçãoGanhou',
          },
        );

        // Ativar Soros Nível 1 após resetar Martingale
        const sorosStake = state.initialStake + result.profitLoss;
        state.sorosLevel = 1;
        state.sorosStake = sorosStake;
        state.sorosProfit = result.profitLoss; // Armazenar profit da última operação

        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ?, soros_profit = ? WHERE user_id = ?`,
            [sorosStake, result.profitLoss, state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ? WHERE user_id = ?`,
            [sorosStake, state.userId],
          );
        }
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros activated (level 1). initial_stake=${state.initialStake.toFixed(2)}, profit=${result.profitLoss.toFixed(2)}, soros_stake=${sorosStake.toFixed(2)}`,
          {
            sorosLevel: 1,
            initialStake: state.initialStake,
            profit: result.profitLoss,
            sorosStake,
          },
        );
      } else {
        // 4. Vitória normal (M0 e não em Soros) -> Ativa Soros 1
        const sorosStake = state.initialStake + result.profitLoss;
        state.sorosLevel = 1;
        state.sorosStake = sorosStake;
        state.sorosProfit = result.profitLoss; // Armazenar profit da última operação

        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ?, soros_profit = ? WHERE user_id = ?`,
            [sorosStake, result.profitLoss, state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 1, soros_stake = ? WHERE user_id = ?`,
            [sorosStake, state.userId],
          );
        }
        this.saveLog(
          state.userId,
          'INFO',
          'RISK',
          `Soros activated (level 1). initial_stake=${state.initialStake.toFixed(2)}, profit=${result.profitLoss.toFixed(2)}, soros_stake=${sorosStake.toFixed(2)}`,
          {
            sorosLevel: 1,
            initialStake: state.initialStake,
            profit: result.profitLoss,
            sorosStake,
          },
        );
      }

      state.isOperationActive = false;

      this.saveLog(
        state.userId,
        'INFO',
        'TRADER',
        `Operação finalizada. resultado=VITÓRIA, lucro=${result.profitLoss.toFixed(2)}`,
      );

      this.logger.log(
        `[HandleTradeResult][${state.userId}] ✅ VITÓRIA! Lucro: $${result.profitLoss.toFixed(2)}`,
      );
    } else {
      // Perda: Se estava em Soros, entrar em recuperação. Senão, ativar Martingale
      state.dailyLoss += Math.abs(result.profitLoss);
      state.isOperationActive = false;

      // Log de perda detectada
      this.saveLog(
        state.userId,
        'ERROR',
        'RISK',
        `Trade LOSS detected. loss=${Math.abs(result.profitLoss).toFixed(2)}, stake=${stakeAmount.toFixed(2)}, current_martingale=${state.martingaleLevel}, current_soros=${state.sorosLevel}`,
        {
          loss: Math.abs(result.profitLoss),
          stake: stakeAmount,
          martingaleLevel: state.martingaleLevel,
          sorosLevel: state.sorosLevel,
        },
      );

      // Se estava em Soros, entrar em recuperação imediatamente
      if (state.sorosLevel > 0) {
        // Salvar estado antes de resetar
        const sorosLevelBefore = state.sorosLevel;
        const sorosStakeBefore = state.sorosStake;
        const sorosProfitBefore = state.sorosProfit;

        // Calcular perda líquida: stake atual - profit da última operação ganha (conforme documentação)
        // net_loss = stake - soros_profit
        const netLoss = stakeAmount - state.sorosProfit;

        this.saveLog(
          state.userId,
          'DEBUG',
          'RISK',
          `Soros loss calculation. soros_stake=${sorosStakeBefore.toFixed(2)}, soros_profit=${sorosProfitBefore.toFixed(2)}, stake_lost=${stakeAmount.toFixed(2)}, net_loss=${netLoss.toFixed(2)}`,
        );

        // Resetar Soros
        state.sorosLevel = 0;
        state.sorosStake = 0;
        state.sorosProfit = 0;

        // Verificar se a coluna soros_profit existe antes de usar
        const hasSorosProfit = await this.hasSorosProfitColumn();
        if (hasSorosProfit) {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0, soros_profit = 0 WHERE user_id = ?`,
            [state.userId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET soros_level = 0, soros_stake = 0 WHERE user_id = ?`,
            [state.userId],
          );
        }

        this.saveLog(
          state.userId,
          'WARN',
          'RISK',
          `Soros failed! Entering recovery. martingale_level=M1, martingale_losses=${netLoss.toFixed(2)}`,
          {
            sorosLevelBefore,
            sorosStakeBefore,
            netLoss,
            nextMartingaleLevel: 'M1',
          },
        );

        // Atualizar lastLossAmount para o cálculo de Martingale
        state.lastLossAmount = netLoss;
      }

      // Obter configuração do modo
      const config = await this.dataSource.query(
        `SELECT daily_loss, risk_level, martingale_count FROM autonomous_agent_config WHERE user_id = ?`,
        [state.userId],
      );

      const totalLosses = config && config.length > 0
        ? parseFloat(config[0].daily_loss) || 0
        : 0;

      const mode = config && config.length > 0
        ? config[0].risk_level || 'balanced'
        : 'balanced';

      const currentMartingaleCount = config && config.length > 0
        ? (config[0].martingale_count || 0)
        : 0;

      // Verificar limite M5 para Conservador
      const martingaleLimit = SENTINEL_CONFIG.martingaleLimits[mode as ManagementMode] || Infinity;

      if (mode === 'conservative' && currentMartingaleCount >= martingaleLimit) {
        // Limite M5 atingido: aceitar perda e resetar
        state.martingaleLevel = 'M0';
        state.martingaleCount = 0;
        state.lastLossAmount = 0;
        await this.dataSource.query(
          `UPDATE autonomous_agent_config SET
            martingale_level = 'M0',
            martingale_count = 0,
            last_loss_amount = 0
           WHERE user_id = ?`,
          [state.userId],
        );

        this.saveLog(
          state.userId,
          'WARN',
          'RISK',
          `Limite M5 atingido no modo Conservador. Aceitando perda e resetando para M0.`,
        );

        // Pausa de 15-30 segundos
        const pauseSeconds = 15 + Math.floor(Math.random() * 16); // 15-30 segundos
        this.updateNextTradeAt(state.userId, pauseSeconds); // ✅ OTIMIZADO: Não aguardar (não-bloqueante)
        this.saveLog(
          state.userId,
          'INFO',
          'HUMANIZER',
          `Pausa após M5. duração_segundos=${pauseSeconds}`,
        );

        this.logger.log(
          `[HandleTradeResult][${state.userId}] ❌ PERDA. Limite M5 atingido, resetando para M0`,
        );
        return;
      }

      // Verificar se análise técnica é favorável para Martingale
      const prices = await this.getPriceHistory(state.userId, state.symbol);
      const tradingConfig = SENTINEL_CONFIG.tradingModes[state.tradingMode];
      const minTicks = tradingConfig.ticksRequired;

      if (prices.length >= minTicks) {
        const recentPrices = prices.slice(-minTicks);
        const analysis = this.performTechnicalAnalysis(recentPrices, state.userId);

        // Para Martingale, exigir confiança maior (80% mínimo)
        if (analysis.confidenceScore >= 80) {
          // Determinar próximo nível de Martingale
          let nextLevel: MartingaleLevel;
          if (state.martingaleLevel === 'M0') {
            nextLevel = 'M1';
          } else if (state.martingaleLevel === 'M1') {
            nextLevel = 'M2';
          } else {
            // Já está em M2, manter
            nextLevel = 'M2';
          }

          const newCount = currentMartingaleCount + 1;
          state.martingaleLevel = nextLevel;
          state.martingaleCount = newCount;
          state.lastLossAmount = stakeAmount;

          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET
              martingale_level = ?,
              martingale_count = ?,
              last_loss_amount = ?
             WHERE user_id = ?`,
            [nextLevel, newCount, stakeAmount, state.userId],
          );

          const modeName = mode === 'conservative' ? 'Conservador' : mode === 'aggressive' ? 'Agressivo' : 'Moderado';

          this.saveLog(
            state.userId,
            'WARN',
            'RISK',
            `Martingale activated. level=${nextLevel}, losses=${totalLosses.toFixed(2)}, count=${newCount}`,
            {
              martingaleLevelBefore: state.martingaleLevel,
              martingaleLevelAfter: nextLevel,
              martingaleCount: newCount,
              totalLosses,
              mode: modeName,
              lastLossAmount: stakeAmount,
            },
          );

          this.logger.log(
            `[HandleTradeResult][${state.userId}] ❌ PERDA. Ativando ${nextLevel} para recuperação`,
          );
        } else {
          // Análise insuficiente: resetar para M0
          state.martingaleLevel = 'M0';
          state.martingaleCount = 0;
          state.lastLossAmount = 0;
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET
              martingale_level = 'M0',
              martingale_count = 0,
              last_loss_amount = 0
             WHERE user_id = ?`,
            [state.userId],
          );

          this.saveLog(
            state.userId,
            'DEBUG',
            'RISK',
            `Análise insuficiente para Martingale (confiança=${analysis.confidenceScore.toFixed(1)}%). Resetando para M0.`,
          );

          this.logger.log(
            `[HandleTradeResult][${state.userId}] ❌ PERDA. Análise insuficiente, resetando para M0`,
          );
        }
      }

      this.saveLog(
        state.userId,
        'ERROR',
        'TRADER',
        `Operação finalizada. resultado=PERDA, perda=${Math.abs(result.profitLoss).toFixed(2)}`,
      );
    }

    // Verificar limites diários
    await this.checkDailyLimits(state);
  }

  // ============================================
  // UTILITÁRIOS
  // ============================================

  private getRandomInterval(): number {
    return Math.floor(
      Math.random() * (SENTINEL_CONFIG.maxIntervalSeconds - SENTINEL_CONFIG.minIntervalSeconds + 1) +
      SENTINEL_CONFIG.minIntervalSeconds,
    );
  }

  // ✅ OTIMIZADO: Atualizar memória primeiro e persistir de forma não-bloqueante
  private async updateNextTradeAt(userId: string, intervalSeconds: number): Promise<void> {
    // Atualizar memória primeiro (síncrono e rápido)
    const state = this.agentStates.get(userId);
    if (state) {
      state.nextTradeAt = new Date(Date.now() + intervalSeconds * 1000);
    }

    // Persistir no banco de forma não-bloqueante (não aguardar)
    this.dataSource.query(
      `UPDATE autonomous_agent_config SET next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE user_id = ?`,
      [intervalSeconds, userId],
    ).catch(error => {
      this.logger.warn(`[UpdateNextTradeAt][${userId}] Erro ao atualizar next_trade_at (não crítico):`, error);
    });
  }

  private async handleRandomPause(state: AutonomousAgentState): Promise<void> {
    const pauseMinutes =
      Math.floor(
        Math.random() * (SENTINEL_CONFIG.pauseMaxMinutes - SENTINEL_CONFIG.pauseMinMinutes + 1) +
        SENTINEL_CONFIG.pauseMinMinutes,
      );

    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET
        last_pause_at = NOW(),
        operations_since_pause = 0,
        next_trade_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
       WHERE user_id = ?`,
      [pauseMinutes, state.userId],
    );

    state.operationsSincePause = 0;
    state.nextTradeAt = new Date(Date.now() + pauseMinutes * 60 * 1000);

    // Log de pausa aleatória
    this.saveLog(
      state.userId,
      'INFO',
      'HUMANIZER',
      `Pausa aleatória ativada. duração_minutos=${pauseMinutes}`,
      { durationMinutes: pauseMinutes },
    );

    this.logger.log(`[RandomPause][${state.userId}] ⏸️ Pausa aleatória de ${pauseMinutes} minutos`);
  }

  private async handleStopWin(userId: string): Promise<void> {
    const state = this.agentStates.get(userId);
    const dailyProfit = state?.dailyProfit || 0;
    const target = state?.dailyProfitTarget || 0;

    // ✅ CORREÇÃO: Usar 'profit' ao invés de 'stopped_profit' para evitar erro de truncamento
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = 'profit' WHERE user_id = ?`,
      [userId],
    );

    // Log de Stop Win
    this.saveLog(
      userId,
      'INFO',
      'RISK',
      `STOP WIN ATINGIDO. lucro_diário=${dailyProfit.toFixed(2)}, meta=${target.toFixed(2)}. Parando operações pelo resto do dia.`,
      { dailyProfit, target },
    );

    this.logger.log(`[StopWin][${userId}] 🎯 STOP WIN ATINGIDO! Parando agente até próximo dia`);
  }

  private async handleStopLoss(userId: string): Promise<void> {
    const state = this.agentStates.get(userId);
    const dailyLoss = state?.dailyLoss || 0;
    const limit = state?.dailyLossLimit || 0;

    // ✅ CORREÇÃO: Usar 'loss' ao invés de 'stopped_loss' para evitar erro de truncamento
    await this.dataSource.query(
      `UPDATE autonomous_agent_config SET session_status = 'loss' WHERE user_id = ?`,
      [userId],
    );

    // Log de Stop Loss
    this.saveLog(
      userId,
      'ERROR',
      'RISK',
      `STOP LOSS ATINGIDO. perda_diária=${(-dailyLoss).toFixed(2)}, limite=${(-limit).toFixed(2)}. Parando operações pelo resto do dia.`,
      { dailyLoss, limit },
    );

    this.logger.log(`[StopLoss][${userId}] 🛑 STOP LOSS ATINGIDO! Parando agente até próximo dia`);
  }

  private async checkDailyLimits(state: AutonomousAgentState): Promise<void> {
    const config = await this.dataSource.query(
      `SELECT daily_profit, daily_loss, daily_profit_target, daily_loss_limit
       FROM autonomous_agent_config WHERE user_id = ?`,
      [state.userId],
    );

    if (config && config.length > 0) {
      const cfg = config[0];
      if (parseFloat(cfg.daily_profit) >= parseFloat(cfg.daily_profit_target)) {
        await this.handleStopWin(state.userId);
      } else if (parseFloat(cfg.daily_loss) >= parseFloat(cfg.daily_loss_limit)) {
        await this.handleStopLoss(state.userId);
      }
    }
  }

  private async getPriceHistory(userId: string, symbol: string): Promise<PriceTick[]> {
    // Retornar histórico em memória se existir
    const cached = this.priceHistory.get(userId);
    if (cached && cached.length >= 50) {
      this.logger.debug(`[GetPriceHistory][${userId}] Usando cache: ${cached.length} ticks`);
      return cached;
    }

    // Se não houver cache suficiente, buscar do banco (últimas operações)
    // ou retornar array vazio (será preenchido quando houver ticks via WebSocket)
    try {
      const recentTrades = await this.dataSource.query(
        `SELECT entry_price, created_at 
         FROM autonomous_agent_trades 
         WHERE user_id = ? AND entry_price > 0 
         ORDER BY created_at DESC 
         LIMIT 50`,
        [userId],
      );

      if (recentTrades && recentTrades.length > 0) {
        const prices: PriceTick[] = recentTrades
          .reverse()
          .map((trade: any) => ({
            value: parseFloat(trade.entry_price),
            epoch: Math.floor(new Date(trade.created_at).getTime() / 1000),
            timestamp: new Date(trade.created_at).toISOString(),
          }));

        // Armazenar em cache
        this.priceHistory.set(userId, prices);
        this.logger.debug(`[GetPriceHistory][${userId}] Histórico do banco: ${prices.length} ticks`);
        return prices;
      }
    } catch (error) {
      this.logger.error(`[GetPriceHistory] Erro ao buscar histórico:`, error);
    }

    // Retornar histórico em memória mesmo que seja menor que 50
    if (cached && cached.length > 0) {
      this.logger.debug(`[GetPriceHistory][${userId}] Cache parcial: ${cached.length} ticks (aguardando mais ticks via WebSocket)`);
      return cached;
    }

    // Retornar array vazio se não houver dados
    this.logger.warn(`[GetPriceHistory][${userId}] ⚠️ Nenhum histórico disponível. Aguardando ticks via WebSocket...`);
    return [];
  }

  // Método para atualizar histórico de preços via WebSocket (chamado internamente)
  private async updatePriceHistory(userId: string, tick: PriceTick): Promise<void> {
    const cached = this.priceHistory.get(userId) || [];
    cached.push(tick);

    // Manter apenas os últimos N ticks
    if (cached.length > this.maxHistorySize) {
      cached.shift();
    }

    this.priceHistory.set(userId, cached);
  }

  // ============================================
  // CONEXÃO WEBSOCKET COMPARTILHADA (COMO A IA)
  // ============================================

  /**
   * ✅ REFATORADO: Inicializa conexão WebSocket compartilhada (exatamente como a IA)
   */
  private async initializeSharedWebSocket(): Promise<void> {
    if (this.isWebSocketConnected && this.sharedWebSocket && this.sharedWebSocket.readyState === WebSocket.OPEN) {
      this.logger.log('✅ Conexão WebSocket compartilhada já está conectada');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.logger.log(`🔌 Inicializando conexão WebSocket compartilhada (app_id: ${this.appId}, symbol: ${this.sharedSymbol})...`);

      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.sharedWebSocket = new WebSocket(endpoint);

      this.sharedWebSocket.on('open', () => {
        this.logger.log('✅ Conexão WebSocket compartilhada aberta com sucesso');
        this.isWebSocketConnected = true;
        this.subscribeToSharedTicks();
        this.startSharedKeepAlive();
        resolve();
      });

      this.sharedWebSocket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleSharedWebSocketMessage(msg);
        } catch (error) {
          this.logger.error('[SharedWebSocket] Erro ao processar mensagem:', error);
        }
      });

      this.sharedWebSocket.on('error', (error) => {
        this.logger.error('[SharedWebSocket] Erro no WebSocket:', error);
        this.isWebSocketConnected = false;
        reject(error);
      });

      this.sharedWebSocket.on('close', () => {
        this.logger.warn('[SharedWebSocket] Conexão WebSocket compartilhada fechada');
        this.isWebSocketConnected = false;
        this.stopSharedKeepAlive();
        this.sharedWebSocket = null;
        this.sharedSubscriptionId = null;
        
        // Tentar reconectar após 5 segundos
        setTimeout(() => {
          this.initializeSharedWebSocket().catch(error => {
            this.logger.error('[SharedWebSocket] Erro ao reconectar:', error);
          });
        }, 5000);
      });

      // Timeout de 10 segundos
      setTimeout(() => {
        if (!this.isWebSocketConnected) {
          reject(new Error('Timeout ao conectar WebSocket compartilhado'));
        }
      }, 10000);
    });
  }

  /**
   * ✅ REFATORADO: Subscreve aos ticks do símbolo compartilhado (como a IA)
   */
  private subscribeToSharedTicks(): void {
    if (!this.sharedWebSocket || this.sharedWebSocket.readyState !== WebSocket.OPEN) {
      this.logger.warn('[SharedWebSocket] WebSocket não está aberto, não é possível subscrever');
      return;
    }

    this.logger.log(`📡 Inscrevendo-se nos ticks de ${this.sharedSymbol}...`);
    const subscriptionPayload = {
      ticks_history: this.sharedSymbol,
      adjust_start_time: 1,
      count: 100,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    };
    
    this.sharedWebSocket.send(JSON.stringify(subscriptionPayload));
    this.logger.log(`✅ Requisição de inscrição enviada para ${this.sharedSymbol}`);
  }

  /**
   * ✅ REFATORADO: Processa mensagens do WebSocket compartilhado (como a IA)
   */
  private handleSharedWebSocketMessage(msg: any): void {
    if (msg.error) {
      const errorMsg = msg.error.message || JSON.stringify(msg.error);
      this.logger.error('[SharedWebSocket] ❌ Erro da API:', errorMsg);
      
      // Se erro genérico, recriar WebSocket
      if (errorMsg.includes('Sorry, an error occurred') || errorMsg.includes('error occurred while processing')) {
        this.logger.warn('[SharedWebSocket] ⚠️ Erro genérico detectado - Recriando WebSocket...');
        if (this.sharedSubscriptionId) {
          this.cancelSharedSubscription(this.sharedSubscriptionId);
        }
        this.initializeSharedWebSocket().catch(error => {
          this.logger.error('[SharedWebSocket] ❌ Erro ao recriar WebSocket:', error);
        });
      }
      return;
    }

    // Capturar subscription ID
    if (msg.subscription?.id) {
      if (this.sharedSubscriptionId !== msg.subscription.id) {
        this.sharedSubscriptionId = msg.subscription.id;
        this.logger.log(`[SharedWebSocket] 📋 Subscription ID capturado: ${this.sharedSubscriptionId}`);
      }
    }

    switch (msg.msg_type) {
      case 'history':
        this.logger.log(`[SharedWebSocket] 📊 Histórico recebido: ${msg.history?.prices?.length || 0} preços`);
        this.processSharedHistory(msg.history);
        break;

      case 'ticks_history':
        const subId = msg.subscription?.id || msg.subscription_id || msg.id;
        if (subId) {
          this.sharedSubscriptionId = subId;
          this.logger.log(`[SharedWebSocket] 📋 Subscription ID capturado: ${this.sharedSubscriptionId}`);
        }
        if (msg.history?.prices) {
          this.processSharedHistory(msg.history);
        }
        break;

      case 'tick':
        if (msg.subscription?.id && this.sharedSubscriptionId !== msg.subscription.id) {
          this.sharedSubscriptionId = msg.subscription.id;
        }
        this.processSharedTick(msg.tick);
        break;

      default:
        if (msg.msg_type) {
          this.logger.debug(`[SharedWebSocket] ⚠️ Mensagem desconhecida: msg_type=${msg.msg_type}`);
        }
        break;
    }
  }

  /**
   * ✅ REFATORADO: Processa histórico compartilhado e distribui para todos os agentes
   */
  private processSharedHistory(history: any): void {
    if (!history || !history.prices) {
      this.logger.warn('[SharedWebSocket] ⚠️ Histórico recebido sem dados de preços');
      return;
    }

    const ticks: PriceTick[] = history.prices.map((price: number, index: number) => ({
      value: parseFloat(price.toString()),
      epoch: history.times ? history.times[index] : Math.floor(Date.now() / 1000),
      timestamp: history.times
        ? new Date(history.times[index] * 1000).toISOString()
        : new Date().toISOString(),
    }));

    // Distribuir histórico para todos os agentes ativos
    for (const [userId, state] of this.agentStates.entries()) {
      if (state.symbol === this.sharedSymbol) {
        this.priceHistory.set(userId, [...ticks]);
      }
    }

    this.logger.log(`[SharedWebSocket] 📊 Histórico processado e distribuído: ${ticks.length} ticks para ${this.agentStates.size} agente(s)`);
  }

  /**
   * ✅ REFATORADO: Processa tick compartilhado e distribui para todos os agentes ativos
   * ✅ OTIMIZAÇÃO 5: Atualiza buffer de dígitos incrementalmente
   */
  private processSharedTick(tick: any): void {
    if (!tick || tick.quote === undefined) {
      return;
    }

    const priceTick: PriceTick = {
      value: parseFloat(tick.quote),
      epoch: tick.epoch || Math.floor(Date.now() / 1000),
      timestamp: tick.epoch
        ? new Date(tick.epoch * 1000).toISOString()
        : new Date().toISOString(),
    };

    // ✅ REFATORAÇÃO: Invalidar cache de MarketAnalysis compartilhado quando novo tick chegar
    this.sharedMarketAnalysisCache.delete(this.sharedSymbol);

    // Distribuir tick para todos os agentes ativos com o símbolo correto
    for (const [userId, state] of this.agentStates.entries()) {
      if (state.symbol === this.sharedSymbol) {
        this.updatePriceHistory(userId, priceTick);
        // ✅ OTIMIZAÇÃO 5: Atualizar buffer de dígitos incrementalmente
        this.updateDigitBuffer(userId, priceTick);
        // ✅ OTIMIZAÇÃO 3: Invalidar cache de análise técnica quando novo tick chega
        this.analysisCache.delete(userId);
      }
    }
  }

  /**
   * ✅ REFATORADO: Cancela subscription compartilhada
   */
  private cancelSharedSubscription(subscriptionId: string): void {
    if (!this.sharedWebSocket || this.sharedWebSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const forgetPayload = { forget: subscriptionId };
      this.sharedWebSocket.send(JSON.stringify(forgetPayload));
      this.logger.log(`[SharedWebSocket] ✅ Comando forget enviado para subscription ${subscriptionId}`);
    } catch (error) {
      this.logger.error(`[SharedWebSocket] ❌ Erro ao cancelar subscription:`, error);
    }
  }

  /**
   * ✅ REFATORADO: Keep-alive para conexão compartilhada (como a IA)
   */
  private startSharedKeepAlive(): void {
    this.stopSharedKeepAlive();

    this.sharedKeepAliveInterval = setInterval(() => {
      if (this.sharedWebSocket && this.sharedWebSocket.readyState === WebSocket.OPEN) {
        try {
          this.sharedWebSocket.send(JSON.stringify({ ping: 1 }));
          this.logger.debug('[SharedWebSocket][KeepAlive] Ping enviado');
        } catch (error) {
          this.logger.error('[SharedWebSocket][KeepAlive] Erro ao enviar ping:', error);
        }
      } else {
        this.logger.warn('[SharedWebSocket][KeepAlive] WebSocket não está aberto, parando keep-alive');
        this.stopSharedKeepAlive();
      }
    }, 90000); // 90 segundos (como a IA)

    this.logger.log('[SharedWebSocket] ✅ Keep-alive iniciado (ping a cada 90s)');
  }

  /**
   * ✅ REFATORADO: Para keep-alive compartilhado
   */
  private stopSharedKeepAlive(): void {
    if (this.sharedKeepAliveInterval) {
      clearInterval(this.sharedKeepAliveInterval);
      this.sharedKeepAliveInterval = null;
      this.logger.debug('[SharedWebSocket][KeepAlive] Keep-alive parado');
    }
  }

  // ============================================
  // OTIMIZAÇÃO 1: POOL DE CONEXÕES WEBSOCKET
  // ============================================

  /**
   * ✅ OTIMIZAÇÃO 1: Obtém ou cria conexão WebSocket do pool para um token
   */
  private async getOrCreatePoolConnection(token: string): Promise<WebSocket> {
    const poolEntry = this.wsConnectionsPool.get(token);
    
    // Se existe conexão válida e pronta, reutilizar
    if (poolEntry && poolEntry.ws && poolEntry.ws.readyState === WebSocket.OPEN && poolEntry.isReady) {
      poolEntry.lastUsed = Date.now();
      this.logger.debug(`[Pool] Reutilizando conexão WebSocket para token ${token.substring(0, 10)}...`);
      return poolEntry.ws;
    }

    // Se existe mas está fechada ou não autorizada, limpar
    if (poolEntry) {
      this.cleanupPoolConnection(token);
    }

    // Criar nova conexão
    return this.createPoolConnection(token);
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Cria nova conexão WebSocket no pool
   */
  private createPoolConnection(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      const poolEntry = {
        ws,
        isAuthorized: false,
        isReady: false,
        lastUsed: Date.now(),
        keepAliveInterval: null as NodeJS.Timeout | null,
        pendingRequests: new Map<string, {
          resolve: (value: any) => void;
          reject: (error: Error) => void;
          timeout: NodeJS.Timeout;
        }>(),
        subscriptions: new Map<string, (msg: any) => void>(), // ✅ Adicionar subscriptions
      };

      ws.on('open', () => {
        this.logger.log(`[Pool] Conexão WebSocket criada para token ${token.substring(0, 10)}...`);
        ws.send(JSON.stringify({ authorize: token }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // Processar autorização
          if (msg.msg_type === 'authorize') {
            poolEntry.isAuthorized = true;
            poolEntry.isReady = true;
            this.logger.log(`[Pool] Autorizado: ${msg.authorize?.loginid || 'N/A'}`);
            this.startPoolKeepAlive(token);
            resolve(ws);
            return;
          }

          // Processar erros
          if (msg.error) {
            const errorMsg = msg.error.message || JSON.stringify(msg.error);
            this.logger.error(`[Pool] Erro na conexão:`, errorMsg);
            if (!poolEntry.isReady) {
              reject(new Error(errorMsg));
            }
            return;
          }

          // Processar respostas de requests pendentes
          // Usar req_id ou echo_req.req_id para rotear
          const reqId = msg.req_id || msg.echo_req?.req_id;
          if (reqId && poolEntry.pendingRequests.has(reqId)) {
            const request = poolEntry.pendingRequests.get(reqId);
            if (request) {
              clearTimeout(request.timeout);
              request.resolve(msg);
              poolEntry.pendingRequests.delete(reqId);
            }
            return;
          }

          // ✅ Processar mensagens de subscription (proposal_open_contract)
          if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
            const contractId = msg.proposal_open_contract.contract_id;
            if (contractId && poolEntry.subscriptions.has(contractId)) {
              const callback = poolEntry.subscriptions.get(contractId);
              if (callback) {
                callback(msg);
              }
            }
          }
        } catch (error) {
          this.logger.error(`[Pool] Erro ao processar mensagem:`, error);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[Pool] Erro no WebSocket:`, error);
        if (!poolEntry.isReady) {
          reject(error);
        }
      });

      ws.on('close', () => {
        this.logger.warn(`[Pool] Conexão WebSocket fechada para token ${token.substring(0, 10)}...`);
        this.cleanupPoolConnection(token);
      });

      this.wsConnectionsPool.set(token, poolEntry);

      // Timeout de conexão
      setTimeout(() => {
        if (!poolEntry.isReady) {
          reject(new Error('Timeout ao criar conexão no pool'));
        }
      }, 10000);
    });
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Inicia keep-alive para conexão do pool
   */
  private startPoolKeepAlive(token: string): void {
    const poolEntry = this.wsConnectionsPool.get(token);
    if (!poolEntry) return;

    // Parar keep-alive anterior se existir
    if (poolEntry.keepAliveInterval) {
      clearInterval(poolEntry.keepAliveInterval);
    }

    poolEntry.keepAliveInterval = setInterval(() => {
      if (poolEntry.ws && poolEntry.ws.readyState === WebSocket.OPEN) {
        try {
          poolEntry.ws.send(JSON.stringify({ ping: 1 }));
          this.logger.debug(`[Pool] Ping enviado para token ${token.substring(0, 10)}...`);
        } catch (error) {
          this.logger.error(`[Pool] Erro ao enviar ping:`, error);
          this.cleanupPoolConnection(token);
        }
      } else {
        this.cleanupPoolConnection(token);
      }
    }, this.WS_POOL_KEEP_ALIVE_INTERVAL);
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Limpa conexão do pool
   */
  private cleanupPoolConnection(token: string): void {
    const poolEntry = this.wsConnectionsPool.get(token);
    if (!poolEntry) return;

    if (poolEntry.keepAliveInterval) {
      clearInterval(poolEntry.keepAliveInterval);
    }

    try {
      if (poolEntry.ws && poolEntry.ws.readyState === WebSocket.OPEN) {
        poolEntry.ws.close();
      }
    } catch (error) {
      this.logger.warn(`[Pool] Erro ao fechar conexão:`, error);
    }

    // Rejeitar todos os requests pendentes
    for (const [reqId, request] of poolEntry.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Conexão fechada'));
    }

    // Limpar todas as subscriptions
    poolEntry.subscriptions.clear();

    this.wsConnectionsPool.delete(token);
    this.logger.debug(`[Pool] Conexão removida do pool para token ${token.substring(0, 10)}...`);
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Limpa conexões inativas do pool
   */
  private cleanupIdlePoolConnections(): void {
    const now = Date.now();
    for (const [token, poolEntry] of this.wsConnectionsPool.entries()) {
      if (now - poolEntry.lastUsed > this.WS_POOL_MAX_IDLE_TIME) {
        this.logger.log(`[Pool] Limpando conexão inativa para token ${token.substring(0, 10)}...`);
        this.cleanupPoolConnection(token);
      }
    }
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Envia request através do pool e aguarda resposta
   */
  private async sendRequestViaPool(token: string, payload: any, timeoutMs: number = 60000): Promise<any> {
    // Garantir que temos conexão no pool
    await this.getOrCreatePoolConnection(token);
    const poolEntry = this.wsConnectionsPool.get(token);
    if (!poolEntry || !poolEntry.isReady) {
      throw new Error('Conexão do pool não está pronta');
    }

    // Gerar req_id único
    const reqId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    payload.req_id = reqId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        poolEntry.pendingRequests.delete(reqId);
        reject(new Error(`Timeout ao enviar request: ${JSON.stringify(payload)}`));
      }, timeoutMs);

      poolEntry.pendingRequests.set(reqId, { resolve, reject, timeout });
      poolEntry.lastUsed = Date.now();

      try {
        poolEntry.ws.send(JSON.stringify(payload));
        this.logger.debug(`[Pool] Request enviado: ${payload.proposal ? 'proposal' : payload.buy ? 'buy' : 'unknown'} (req_id: ${reqId})`);
      } catch (error) {
        poolEntry.pendingRequests.delete(reqId);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Inscreve em subscription e retorna callback para mensagens
   */
  private async subscribeViaPool(
    token: string,
    payload: any,
    callback: (msg: any) => void,
    subId: string,
    timeoutMs: number = 90000
  ): Promise<void> {
    const poolEntry = this.wsConnectionsPool.get(token);
    if (!poolEntry || !poolEntry.isReady) {
      throw new Error('Conexão do pool não está pronta');
    }

    // Registrar callback para este subscription
    poolEntry.subscriptions.set(subId, callback);
    poolEntry.lastUsed = Date.now();

    try {
      poolEntry.ws.send(JSON.stringify(payload));
      this.logger.debug(`[Pool] Subscription criada: ${subId}`);

      // Timeout para remover subscription automaticamente
      setTimeout(() => {
        poolEntry.subscriptions.delete(subId);
        this.logger.debug(`[Pool] Subscription ${subId} removida após timeout`);
      }, timeoutMs);
    } catch (error) {
      poolEntry.subscriptions.delete(subId);
      throw error;
    }
  }

  /**
   * ✅ OTIMIZAÇÃO 1: Remove subscription do pool
   */
  private removeSubscriptionFromPool(token: string, subId: string): void {
    const poolEntry = this.wsConnectionsPool.get(token);
    if (poolEntry) {
      poolEntry.subscriptions.delete(subId);
      this.logger.debug(`[Pool] Subscription ${subId} removida`);
    }
  }

  // ============================================
  // OTIMIZAÇÃO 4: PROCESSAMENTO ASSÍNCRONO DE TRADES
  // ============================================

  /**
   * ✅ OTIMIZAÇÃO 4: Processa fila de resultados de trades em background
   */
  private async processTradeResultQueue(): Promise<void> {
    if (this.isProcessingTradeResults || this.tradeResultQueue.length === 0) {
      return;
    }

    this.isProcessingTradeResults = true;

    try {
      while (this.tradeResultQueue.length > 0) {
        const item = this.tradeResultQueue.shift();
        if (!item) break;

        try {
          await this.handleTradeResult(item.state, item.tradeId, item.result, item.stakeAmount);
        } catch (error) {
          this.logger.error(`[TradeResultQueue][${item.state.userId}] Erro ao processar resultado:`, error);
        }
      }
    } finally {
      this.isProcessingTradeResults = false;
    }
  }

  // ============================================
  // RESET DE SESSÕES DIÁRIAS
  // ============================================

  async resetDailySessions(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Buscar agentes ativos antes do reset para obter saldo inicial
      const activeAgentsBefore = await this.dataSource.query(
        `SELECT user_id, daily_profit, daily_loss FROM autonomous_agent_config WHERE is_active = TRUE`,
      );

      // Resetar todas as sessões ativas
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET 
           daily_profit = 0,
           daily_loss = 0,
           operations_since_pause = 0,
           session_date = ?,
           session_status = 'active',
           next_trade_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
           updated_at = NOW()
         WHERE is_active = TRUE`,
        [today, this.getRandomInterval()],
      );

      // Re-sincronizar estados em memória
      await this.syncActiveAgentsFromDb();

      // Log de reset diário para cada agente (conforme documentação)
      for (const agent of activeAgentsBefore) {
        const balanceStartDay = (parseFloat(agent.daily_profit) || 0) - (parseFloat(agent.daily_loss) || 0);
        this.saveLog(
          agent.user_id.toString(),
          'INFO',
          'CORE',
          `Reset diário executado. saldo_início_dia=${balanceStartDay.toFixed(2)}, data=${today.toISOString().split('T')[0]}`,
          {
            balanceStartDay,
            date: today.toISOString().split('T')[0],
          },
        );
      }

      this.logger.log('[ResetDailySessions] ✅ Sessões diárias resetadas');
    } catch (error) {
      this.logger.error('[ResetDailySessions] ❌ Erro:', error);
      throw error;
    }
  }

  // ============================================
  // MÉTODOS PÚBLICOS PARA API
  // ============================================

  async getAgentConfig(userId: string): Promise<any> {
    const config = await this.dataSource.query(
      `SELECT 
        is_active,
        initial_stake,
        daily_profit_target,
        daily_loss_limit,
        symbol,
        strategy,
        risk_level,
        total_trades,
        total_wins,
        total_losses,
        daily_profit,
        daily_loss,
        session_status,
        session_date,
        last_trade_at,
        next_trade_at,
        created_at
       FROM autonomous_agent_config
       WHERE user_id = ?`,
      [userId],
    );

    if (!config || config.length === 0) {
      return null;
    }

    const cfg = config[0];

    // Garantir que session_date seja retornado como string ISO se existir
    let sessionDate: string | null = null;
    if (cfg.session_date) {
      try {
        if (cfg.session_date instanceof Date) {
          sessionDate = cfg.session_date.toISOString();
        } else if (typeof cfg.session_date === 'string') {
          // Se já for string, garantir formato ISO
          // Se for apenas data (YYYY-MM-DD), adicionar hora atual
          if (cfg.session_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
            // É apenas data, usar hora atual
            const dateOnly = new Date(cfg.session_date);
            const now = new Date();
            dateOnly.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
            sessionDate = dateOnly.toISOString();
          } else {
            sessionDate = new Date(cfg.session_date).toISOString();
          }
        } else {
          sessionDate = new Date(cfg.session_date).toISOString();
        }
      } catch (error) {
        this.logger.warn(`[GetAgentConfig] Erro ao processar session_date:`, error);
        sessionDate = null;
      }
    }

    let createdAt: string | null = null;
    if (cfg.created_at) {
      if (cfg.created_at instanceof Date) {
        createdAt = cfg.created_at.toISOString();
      } else if (typeof cfg.created_at === 'string') {
        createdAt = new Date(cfg.created_at).toISOString();
      } else {
        createdAt = String(cfg.created_at);
      }
    }

    return {
      isActive: cfg.is_active === 1 || cfg.is_active === true,
      initialStake: parseFloat(cfg.initial_stake),
      dailyProfitTarget: parseFloat(cfg.daily_profit_target),
      dailyLossLimit: parseFloat(cfg.daily_loss_limit),
      symbol: cfg.symbol,
      strategy: cfg.strategy || 'arion',
      riskLevel: cfg.risk_level || 'balanced',
      totalTrades: cfg.total_trades || 0,
      totalWins: cfg.total_wins || 0,
      totalLosses: cfg.total_losses || 0,
      dailyProfit: parseFloat(cfg.daily_profit) || 0,
      dailyLoss: parseFloat(cfg.daily_loss) || 0,
      sessionStatus: cfg.session_status,
      sessionDate: sessionDate, // Retornar como ISO string
      createdAt: createdAt, // Retornar como ISO string
      lastTradeAt: cfg.last_trade_at ? (cfg.last_trade_at instanceof Date ? cfg.last_trade_at.toISOString() : cfg.last_trade_at) : null,
      nextTradeAt: cfg.next_trade_at ? (cfg.next_trade_at instanceof Date ? cfg.next_trade_at.toISOString() : cfg.next_trade_at) : null,
    };
  }

  async getTradeHistory(userId: string, limit: number = 50): Promise<any[]> {
    const trades = await this.dataSource.query(
      `SELECT 
        id, contract_type, contract_duration, entry_price, exit_price,
        stake_amount, profit_loss, status, confidence_score, martingale_level,
        payout, contract_id, created_at, started_at, closed_at
       FROM autonomous_agent_trades
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit],
    );

    return trades.map((trade: any) => ({
      id: trade.id,
      contractType: trade.contract_type,
      duration: trade.contract_duration,
      entryPrice: parseFloat(trade.entry_price),
      exitPrice: trade.exit_price ? parseFloat(trade.exit_price) : null,
      stakeAmount: parseFloat(trade.stake_amount),
      profitLoss: trade.profit_loss ? parseFloat(trade.profit_loss) : null,
      status: trade.status,
      confidenceScore: parseFloat(trade.confidence_score),
      martingaleLevel: trade.martingale_level,
      payout: trade.payout ? parseFloat(trade.payout) : null,
      contractId: trade.contract_id,
      createdAt: trade.created_at,
      startedAt: trade.started_at,
      closedAt: trade.closed_at,
    }));
  }


  async getSessionStats(userId: string): Promise<any> {
    // Usar data de hoje no timezone local (Brasil)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

    // Buscar estatísticas do agente autônomo (apenas finalizados para wins/losses/profit)
    const stats = await this.dataSource.query(
      `SELECT 
        COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END) as total_trades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) as total_profit,
        SUM(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE 0 END) as total_loss
       FROM autonomous_agent_trades
       WHERE user_id = ? AND DATE(created_at) = ?
       AND status IN ('WON', 'LOST')`,
      [userId, todayStr],
    );

    // Buscar TODAS as operações do agente autônomo do dia (excluindo status ERROR)
    const allAutonomousTrades = await this.dataSource.query(
      `SELECT COUNT(*) as total_trades
       FROM autonomous_agent_trades
       WHERE user_id = ? AND DATE(created_at) = ? AND status != 'ERROR'`,
      [userId, todayStr],
    );

    // Buscar capital inicial e valores diários da configuração do agente
    const config = await this.dataSource.query(
      `SELECT initial_stake, initial_balance, daily_profit, daily_loss
       FROM autonomous_agent_config 
       WHERE user_id = ?`,
      [userId],
    );

    const initialBalance = config && config.length > 0 ? parseFloat(config[0].initial_balance) || 0 : 0;
    // ✅ Usar daily_profit e daily_loss da configuração (atualizados em tempo real)
    const dailyProfit = config && config.length > 0 ? parseFloat(config[0].daily_profit) || 0 : 0;
    const dailyLoss = config && config.length > 0 ? parseFloat(config[0].daily_loss) || 0 : 0;
    // Usar initialBalance como valor total da conta configurada (sempre usar este valor quando disponível)
    // Se initialBalance for 0, tentar buscar o saldo atual da conta Deriv como fallback
    let totalCapital = initialBalance > 0 ? initialBalance : 0;

    // Se initialBalance não estiver configurado, tentar buscar saldo atual da conta
    if (totalCapital === 0 && config && config.length > 0) {
      if (!this.derivService) {
        this.logger.warn(`[GetSessionStats][${userId}] DerivService não disponível, não é possível buscar saldo da conta`);
      } else {
        try {
          const derivToken = config[0].deriv_token;
          const currency = config[0].currency || 'USD';
          if (derivToken) {
            this.logger.log(`[GetSessionStats][${userId}] Tentando buscar saldo da conta Deriv (token disponível: ${!!derivToken})`);
            // Buscar saldo atual da conta Deriv
            const appId = parseInt(this.appId) || 1089;
            const accountInfo = await this.derivService.connectAndGetAccount(derivToken, appId, currency);
            if (accountInfo && accountInfo.balance) {
              // accountInfo.balance pode ser um objeto {value, currency} ou um número
              const balanceValue = typeof accountInfo.balance === 'object'
                ? accountInfo.balance.value
                : accountInfo.balance;

              if (balanceValue && balanceValue > 0) {
                totalCapital = typeof balanceValue === 'number' ? balanceValue : parseFloat(String(balanceValue)) || 0;
                this.logger.log(`[GetSessionStats][${userId}] ✅ initial_balance não configurado, usando saldo atual da conta: ${totalCapital}`);

                // Atualizar initial_balance no banco para próximas consultas
                try {
                  await this.dataSource.query(
                    `UPDATE autonomous_agent_config SET initial_balance = ? WHERE user_id = ?`,
                    [totalCapital, userId]
                  );
                  this.logger.log(`[GetSessionStats][${userId}] ✅ initial_balance atualizado no banco: ${totalCapital}`);
                } catch (updateError) {
                  this.logger.warn(`[GetSessionStats][${userId}] Erro ao atualizar initial_balance no banco: ${updateError.message}`);
                }
              } else {
                this.logger.warn(`[GetSessionStats][${userId}] Saldo retornado é inválido ou zero: ${balanceValue}`);
              }
            } else {
              this.logger.warn(`[GetSessionStats][${userId}] accountInfo ou balance não disponível: ${JSON.stringify(accountInfo)}`);
            }
          } else {
            this.logger.warn(`[GetSessionStats][${userId}] derivToken não disponível na configuração`);
          }
        } catch (error) {
          this.logger.error(`[GetSessionStats][${userId}] ❌ Erro ao buscar saldo da conta Deriv: ${error.message}`, error.stack);
        }
      }
    }

    this.logger.log(`[GetSessionStats][${userId}] 📊 totalCapital: ${totalCapital}, initialBalance: ${initialBalance}`);

    // Contar TODAS as operações do dia de autonomous_agent_trades (independente do status)
    const autonomousTradesAll = allAutonomousTrades && allAutonomousTrades.length > 0 ? parseInt(allAutonomousTrades[0].total_trades) || 0 : 0;
    const totalTradesToday = autonomousTradesAll;

    // Para estatísticas (wins/losses), usar apenas trades finalizados
    const autonomousTrades = stats && stats.length > 0 ? parseInt(stats[0].total_trades) || 0 : 0;

    // ✅ Mesmo sem trades finalizados, usar valores da configuração se disponíveis
    if (!stats || stats.length === 0) {
      return {
        totalTrades: totalTradesToday,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalProfit: dailyProfit, // ✅ Usar daily_profit da configuração
        totalLoss: dailyLoss, // ✅ Usar daily_loss da configuração
        netProfit: dailyProfit - dailyLoss, // ✅ Calcular netProfit usando valores da configuração
        totalCapital,
        operationsToday: totalTradesToday,
      };
    }

    const s = stats[0];
    const wins = parseInt(s.wins) || 0;
    const losses = parseInt(s.losses) || 0;
    
    // ✅ Priorizar daily_profit e daily_loss da configuração (mais confiável e atualizado em tempo real)
    // Se não estiverem disponíveis, usar valores calculados dos trades
    const totalProfit = dailyProfit > 0 ? dailyProfit : (parseFloat(s.total_profit) || 0);
    const totalLoss = dailyLoss > 0 ? dailyLoss : (parseFloat(s.total_loss) || 0);
    const netProfit = dailyProfit - dailyLoss; // ✅ Usar valores da configuração para cálculo mais preciso

    this.logger.log(
      `[GetSessionStats][${userId}] Operações hoje: autonomous=${autonomousTradesAll}, total=${totalTradesToday}, daily_profit=${dailyProfit}, daily_loss=${dailyLoss}, netProfit=${netProfit}`,
    );

    return {
      totalTrades: totalTradesToday, // ✅ Usar totalTradesToday (todos os trades) em vez de autonomousTrades (apenas finalizados)
      wins,
      losses,
      winRate: autonomousTrades > 0 ? (wins / autonomousTrades) * 100 : 0,
      totalProfit,
      totalLoss,
      netProfit,
      totalCapital,
      operationsToday: totalTradesToday,
    };
  }

  // ============================================
  // HISTÓRICO DE PREÇOS PARA GRÁFICOS
  // ============================================

  async getPriceHistoryForUser(userId: string, limit: number = 100): Promise<PriceTick[]> {
    try {
      const state = this.agentStates.get(userId);
      if (!state) {
        return [];
      }

      // Buscar histórico por userId (não por symbol)
      const prices = this.priceHistory.get(userId) || [];
      return prices.slice(-limit);
    } catch (error) {
      this.logger.error(`[GetPriceHistoryForUser][${userId}] Erro:`, error);
      return [];
    }
  }

  // ============================================
  // SISTEMA DE LOGS DETALHADOS
  // ============================================

  /**
   * ✅ OTIMIZAÇÃO 7: Salva log de forma assíncrona (não bloqueia execução)
   * Usa LogQueueService centralizado se disponível
   * Early return para evitar criação de objetos desnecessários
   */
  private saveLog(
    userId: string,
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
    module: 'CORE' | 'API' | 'ANALYZER' | 'DECISION' | 'TRADER' | 'RISK' | 'HUMANIZER',
    message: string,
    metadata?: any,
  ): void {
    // ✅ OTIMIZAÇÃO 7: Early return antes de criar objetos (reduz overhead)
    if (level === 'DEBUG' && !this.ENABLE_DEBUG_LOGS) {
      return;
    }

    // ✅ OTIMIZAÇÃO 7: Lazy evaluation - criar objetos apenas se necessário
    try {
      const now = new Date();
      const timestampISO = now.toISOString();

      // Formato da documentação: [TIMESTAMP] [LOG_LEVEL] [MÓDULO] - MENSAGEM
      const logMessage = `[${timestampISO}] [${level}] [${module}] - ${message}`;

      // Log no console também
      switch (level) {
        case 'ERROR':
          this.logger.error(logMessage);
          break;
        case 'WARN':
          this.logger.warn(logMessage);
          break;
        case 'DEBUG':
          if (this.ENABLE_DEBUG_LOGS) {
            this.logger.debug(logMessage);
          }
          break;
        default:
          this.logger.log(logMessage);
      }

      // ✅ OTIMIZAÇÃO: Usar LogQueueService centralizado (não bloqueia execução)
      if (this.logQueueService) {
        this.logQueueService.saveLogAsync({
          userId,
          level,
          module,
          message,
          metadata,
          tableName: 'autonomous_agent_logs',
        });
        return;
      }

      // Fallback: salvar diretamente (compatibilidade)
      const timestampMySQL = now
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
        .slice(0, 23);

      // Executar em background para não bloquear
      this.dataSource.query(
        `INSERT INTO autonomous_agent_logs (user_id, timestamp, log_level, module, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, timestampMySQL, level, module, message, metadata ? JSON.stringify(metadata) : null],
      ).catch(error => {
        this.logger.error(`[SaveLog][${userId}] Erro ao salvar log:`, error);
      });
    } catch (error) {
      // Não falhar se houver erro ao salvar log
      this.logger.error(`[SaveLog][${userId}] Erro ao salvar log:`, error);
    }
  }

  async getLogs(userId: string, limit?: number): Promise<any[]> {
    try {
      // Buscar logs (a tabela não tem created_at, apenas timestamp)
      const query = limit
        ? `SELECT id, timestamp, log_level, module, message, metadata
           FROM autonomous_agent_logs
           WHERE user_id = ?
           ORDER BY timestamp DESC
           LIMIT ?`
        : `SELECT id, timestamp, log_level, module, message, metadata
           FROM autonomous_agent_logs
           WHERE user_id = ?
           ORDER BY timestamp DESC`;

      const params = limit ? [userId, limit] : [userId];
      const logs = await this.dataSource.query(query, params);

      // Mapear log_level e module para type e icon (formato igual à IA)
      const levelToType: Record<string, string> = {
        'INFO': 'info',
        'DEBUG': 'analise',
        'WARN': 'alerta',
        'ERROR': 'erro',
        'LOG': 'info',
      };

      const moduleToIcon: Record<string, string> = {
        'CORE': '🚀',
        'ANALYZER': '🔍',
        'DECISION': '🎯',
        'TRADER': '💰',
        'API': '📡',
        'RISK': '⚠️',
        'HUMANIZER': '⏸️',
      };

      return logs.map(log => {
        let metadata = null;
        if (log.metadata) {
          try {
            if (typeof log.metadata === 'string') {
              metadata = JSON.parse(log.metadata);
            } else {
              metadata = log.metadata;
            }
          } catch (error) {
            this.logger.warn(`[GetLogs] Erro ao parsear metadata do log ${log.id}:`, error);
            metadata = null;
          }
        }

        // Mapear log_level para type
        const type = levelToType[log.log_level] || 'info';

        // Obter icon baseado no módulo ou type
        const icon = moduleToIcon[log.module] || (type === 'erro' ? '🚫' : type === 'alerta' ? '⚠️' : 'ℹ️');

        // Formatar timestamp como HH:mm:ss (horário de Brasília)
        let date: Date;
        if (typeof log.timestamp === 'string') {
          date = new Date(log.timestamp);
        } else if (log.timestamp instanceof Date) {
          date = log.timestamp;
        } else {
          date = new Date();
        }

        const formattedTime = date.toLocaleTimeString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });

        // Converter timestamp do banco para ISO string para o frontend poder parsear
        let timestampISO: string | null = null;
        if (log.timestamp) {
          try {
            if (typeof log.timestamp === 'string') {
              // Se for string MySQL (YYYY-MM-DD HH:MM:SS.mmm), converter para ISO
              const mysqlDate = new Date(log.timestamp.replace(' ', 'T') + 'Z');
              if (!isNaN(mysqlDate.getTime())) {
                timestampISO = mysqlDate.toISOString();
              }
            } else if (log.timestamp instanceof Date) {
              timestampISO = log.timestamp.toISOString();
            }
          } catch (error) {
            this.logger.warn(`[GetLogs] Erro ao converter timestamp do log ${log.id}:`, error);
          }
        }

        return {
          id: log.id,
          timestamp: timestampISO || formattedTime, // Retornar ISO string para o frontend parsear, ou formato formatado como fallback
          created_at: timestampISO || log.timestamp, // Usar timestamp ISO ou original
          type,
          icon,
          message: log.message,
          details: metadata,
          level: log.log_level, // Para exibição no formato [LEVEL]
          module: log.module,   // Para exibição no formato [MODULE]
          log_level: log.log_level, // Manter compatibilidade
        };
      });
    } catch (error) {
      this.logger.error(`[GetLogs][${userId}] Erro:`, error);
      return [];
    }
  }
}

