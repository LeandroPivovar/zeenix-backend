import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai/ai.service';
import { AutonomousAgentStrategyManagerService } from './strategies/autonomous-agent-strategy-manager.service';
import { LogQueueService } from '../utils/log-queue.service';

/**
 * ✅ Serviço Principal do Agente Autônomo
 * 
 * Similar ao AiService, mas específico para o agente autônomo.
 * Recebe ticks do WebSocket e distribui para o StrategyManager do agente autônomo.
 * 
 * Arquitetura:
 * - Uma conexão WebSocket compartilhada (similar à IA)
 * - Processamento REATIVO baseado em ticks
 * - Integração 100% com a IA Orion
 * - Lógica de parar no dia após stop loss/win/blindado
 */
@Injectable()
export class AutonomousAgentService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousAgentService.name);
  private ws: WebSocket | null = null;
  private ticks: Tick[] = [];
  private readonly maxTicks = 100;
  private readonly appId: string;
  private symbol = 'R_100'; // Default
  private activeSymbols = new Set<string>([
    'R_100', 'R_10', 'R_25', 'R_50', 'R_75',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
  ]); // ✅ Adicionado Markets V2 e V3 (Todos Volatility Indices)
  private subscriptions = new Map<string, string>(); // ✅ Mapeia símbolo -> subscriptionId
  private isConnected = false;
  private subscriptionId: string | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private lastTickReceivedTime: number = 0;
  private userSessionIds = new Map<string, number>(); // ✅ Mapeia userId -> current session ID (ai_sessions.id)

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => AutonomousAgentStrategyManagerService))
    private readonly strategyManager: AutonomousAgentStrategyManagerService,
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '1089';
  }

  async onModuleInit() {
    this.logger.log('🚀 Inicializando AutonomousAgentService...');
    try {
      // Criar índices para otimizar queries de estatísticas
      await this.createStatsIndexes();

      // Inicializar conexão WebSocket
      this.logger.log('🔌 Inicializando conexão WebSocket com Deriv API...');

      await this.initialize();
      this.logger.log('✅ Conexão WebSocket estabelecida com sucesso');

      // Sincronizar agentes ativos do banco
      await this.syncActiveAgentsFromDb();
    } catch (error) {
      this.logger.error('❌ Erro ao inicializar AutonomousAgentService:', error.message);
    }
  }

  /**
   * Cria índices e adiciona coluna strategy para otimizar queries de estatísticas
   */
  private async createStatsIndexes(): Promise<void> {
    try {
      this.logger.log('[CreateStatsIndexes] Verificando e atualizando esquema do banco de dados...');

      // 1. Tentar adicionar coluna strategy (capturando erro se já existir)
      // Evita uso de IF NOT EXISTS que pode não ser suportado em versões antigas do MySQL
      try {
        await this.dataSource.query(`
          ALTER TABLE ai_trades 
          ADD COLUMN strategy VARCHAR(50) DEFAULT NULL
        `);
        this.logger.log('[CreateStatsIndexes] ✅ Coluna strategy adicionada com sucesso');
      } catch (error) {
        // Ignorar erro de coluna duplicada (1060: Duplicate column name)
        if (error.errno === 1060 || error.code === 'ER_DUP_FIELDNAME') {
          // Coluna já existe, tudo bem.
        } else {
          this.logger.error('[CreateStatsIndexes] Erro ao adicionar coluna strategy:', error);
        }
      }

      // 2. Criar índices (um por um, ignorando erro de duplicidade)
      const createIndex = async (query: string, name: string) => {
        try {
          await this.dataSource.query(query);
          this.logger.log(`[CreateStatsIndexes] ✅ Índice ${name} criado`);
        } catch (error) {
          // 1061: Duplicate key name
          if (error.errno === 1061 || error.code === 'ER_DUP_KEYNAME' || error.message?.includes('already exists')) {
            // Índice já existe
          } else {
            this.logger.error(`[CreateStatsIndexes] Erro ao criar índice ${name}:`, error);
          }
        }
      };

      await createIndex(`CREATE INDEX idx_ai_trades_strategy ON ai_trades(strategy, status, created_at)`, 'idx_ai_trades_strategy');
      await createIndex(`CREATE INDEX idx_ai_user_config_strategy ON ai_user_config(strategy)`, 'idx_ai_user_config_strategy');
      await createIndex(`CREATE INDEX idx_ai_trades_stats_query ON ai_trades(user_id, status, created_at, profit_loss)`, 'idx_ai_trades_stats_query');
      await createIndex(`CREATE INDEX idx_ai_trades_created_status ON ai_trades(created_at, status)`, 'idx_ai_trades_created_status');

      // 3. Adicionar coluna strategy em autonomous_agent_trades
      try {
        await this.dataSource.query(`
          ALTER TABLE autonomous_agent_trades 
          ADD COLUMN strategy VARCHAR(50) DEFAULT NULL
        `);
        this.logger.log('[CreateStatsIndexes] ✅ Coluna strategy adicionada em autonomous_agent_trades');
      } catch (error) {
        if (error.errno === 1060 || error.code === 'ER_DUP_FIELDNAME') {
          // Coluna já existe
        } else {
          this.logger.error('[CreateStatsIndexes] Erro ao adicionar coluna strategy em autonomous_agent_trades:', error);
        }
      }

      // 4. Adicionar coluna stop_loss_type
      try {
        await this.dataSource.query(`
          ALTER TABLE autonomous_agent_config 
          ADD COLUMN stop_loss_type VARCHAR(20) DEFAULT 'normal'
        `);
        this.logger.log('[CreateStatsIndexes] ✅ Coluna stop_loss_type adicionada em autonomous_agent_config');
      } catch (error) {
        // Ignorar se já existe
      }

      this.logger.log('[CreateStatsIndexes] ✅ Verificação de esquema concluída');


    } catch (error) {
      this.logger.error('[CreateStatsIndexes] Erro fatal na verificação de esquema:', error);
      // Não lançar erro para não parar a inicialização
    }
  }

  /**
   * Inicializa conexão WebSocket com Deriv API
   */
  async initialize(): Promise<void> {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.log('✅ Já está conectado ao Deriv API');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.logger.log(`🔌 Inicializando conexão com Deriv API (app_id: ${this.appId})...`);

      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.ws = new WebSocket(endpoint);

      this.ws.on('open', async () => {
        this.logger.log('✅ [AutonomousAgent] Conexão WebSocket aberta com sucesso');
        this.isConnected = true;
        this.subscribeToTicks();
        this.startKeepAlive();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error('Erro no WebSocket:', error.message);
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.log('Conexão WebSocket fechada');
        this.isConnected = false;
        this.stopKeepAlive();
        this.ws = null;
        this.subscriptions.clear(); // ✅ FIX: Clear subscriptions to force resubscribe on reconnect
        this.subscriptionId = null;

        // Tentar reconectar após 5 segundos
        setTimeout(() => {
          this.initialize().catch((err) => {
            this.logger.error('Erro ao reconectar:', err);
          });
        }, 5000);
      });

      // Timeout de 10 segundos
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Timeout ao conectar com Deriv API'));
        }
      }, 10000);
    });
  }

  /**
   * Inscreve-se nos ticks do símbolo R_100
   * ✅ ATUALIZADO: Todos os agentes autônomos operam apenas em R_100
   */
  private async subscribeToTicks(): Promise<void> {
    for (const symbol of this.activeSymbols) {
      if (this.subscriptions.has(symbol)) continue; // Já inscrito

      this.logger.log(`📡 [AutonomousAgent] Inscrevendo-se nos ticks de ${symbol}...`);
      const subscriptionPayload = {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: this.maxTicks,
        end: 'latest',
        subscribe: 1,
        style: 'ticks',
      };
      this.send(subscriptionPayload);

      // Pequeno delay entre inscrições para não sobrecarregar a conexão
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    this.logger.log(`✅ [AutonomousAgent] Inscrições concluídas para: ${Array.from(this.activeSymbols).join(', ')}`);
  }

  /**
   * Envia mensagem via WebSocket
   */
  private send(payload: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.logger.warn('WebSocket não está aberto, não é possível enviar mensagem');
    }
  }

  /**
   * Keep-alive: Envia ping a cada 90 segundos
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ ping: 1 }));
          this.logger.debug('[KeepAlive] Ping enviado para manter conexão ativa');
        } catch (error) {
          this.logger.error('[KeepAlive] Erro ao enviar ping:', error);
        }
      } else {
        this.logger.warn('[KeepAlive] WebSocket não está aberto, parando keep-alive');
        this.stopKeepAlive();
      }
    }, 90000); // 90 segundos
    this.logger.log('✅ Keep-alive iniciado (ping a cada 90s)');
  }

  /**
   * Para o keep-alive
   */
  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /**
   * Processa mensagens recebidas do WebSocket
   */
  private handleMessage(msg: any): void {
    if (msg.error) {
      const errorMsg = msg.error.message || JSON.stringify(msg.error);
      const reqDetails = msg.echo_req ? JSON.stringify(msg.echo_req) : 'Sem detalhes';
      this.logger.error(`❌ Erro da API: ${errorMsg} | Req: ${reqDetails}`);
      return;
    }

    // Capturar subscription ID
    if (msg.subscription?.id) {
      if (this.subscriptionId !== msg.subscription.id) {
        this.subscriptionId = msg.subscription.id;
        this.logger.log(`📋 Subscription ID capturado: ${this.subscriptionId}`);
      }
    }

    switch (msg.msg_type) {
      case 'history':
        this.logger.log(`📊 Histórico recebido: ${msg.history?.prices?.length || 0} preços`);
        this.processHistory(msg.history, msg.subscription?.id);
        break;

      case 'ticks_history':
        const subId = msg.subscription?.id || msg.subscription_id || msg.id;
        if (subId) {
          this.subscriptionId = subId;
          // ✅ Tentar identificar o símbolo pela subscription
          // A API da Deriv pode retornar o símbolo na mensagem (echo contém a requisição original)
          let symbolFromMsg = this.symbol; // Default

          // Tentar extrair do echo (requisição original)
          if (msg.echo?.ticks_history) {
            symbolFromMsg = msg.echo.ticks_history;
          } else if (msg.ticks_history) {
            symbolFromMsg = msg.ticks_history;
          }

          // Mapear subscription ID para símbolo
          this.subscriptions.set(symbolFromMsg, subId);
          this.logger.log(`📋 Subscription ID ${subId} mapeado para símbolo ${symbolFromMsg}`);
        }
        if (msg.history?.prices) {
          this.processHistory(msg.history, subId);
        }
        break;

      case 'tick':
        if (msg.tick) {
          // ✅ Identificar símbolo pelo subscription ID ou usar R_100 como fallback
          const tickSubId = msg.subscription?.id;
          const symbolForTick = msg.tick.symbol || this.getSymbolForSubscription(tickSubId) || this.symbol;

          if (tickSubId && (this.subscriptionId !== tickSubId || !this.subscriptions.has(symbolForTick))) {
            this.subscriptionId = tickSubId;
            this.subscriptions.set(symbolForTick, tickSubId); // ✅ Garantir mapeamento
            this.logger.log(`📋 [AutonomousAgent] Subscription ID capturado: ${tickSubId} (símbolo: ${symbolForTick})`);
          }

          // ✅ Log de debug para verificar se está recebendo ticks
          this.logger.debug(`[AutonomousAgent] 📥 Tick recebido: quote=${msg.tick.quote}, symbol=${symbolForTick}`);

          this.processTick(msg.tick, symbolForTick);
        }
        break;

      default:
        if (msg.msg_type) {
          this.logger.debug(`⚠️ Mensagem desconhecida: msg_type=${msg.msg_type}`);
        }
        break;
    }
  }

  /**
   * Processa histórico de preços
   */
  private processHistory(history: any, subscriptionId?: string): void {
    if (!history || !history.prices) {
      this.logger.warn('⚠️ Histórico recebido sem dados de preços');
      return;
    }

    if (subscriptionId) {
      this.subscriptionId = subscriptionId;
    }

    this.logger.log(`📊 Processando histórico: ${history.prices?.length || 0} preços recebidos`);

    this.ticks = history.prices.map((price: string, index: number) => {
      const value = parseFloat(price);
      const digit = this.extractLastDigit(value);
      const parity = this.getParityFromDigit(digit);

      return {
        value,
        epoch: history.times ? history.times[index] : Date.now() / 1000,
        timestamp: history.times
          ? new Date(history.times[index] * 1000).toLocaleTimeString('pt-BR')
          : new Date().toLocaleTimeString('pt-BR'),
        digit,
        parity,
      };
    });

    this.logger.log(`✅ ${this.ticks.length} ticks carregados no histórico`);
  }

  /**
   * Processa um tick recebido
   * ✅ ATUALIZADO: Todos os agentes autônomos usam R_100
   */
  private processTick(tick: any, symbol?: string): void {
    if (!tick || !tick.quote) {
      this.logger.debug('⚠️ Tick recebido sem quote');
      return;
    }

    // ✅ Cada agente decide os símbolos que processa
    const tickSymbol = symbol;
    const value = parseFloat(tick.quote);
    const digit = this.extractLastDigit(value);
    const parity = this.getParityFromDigit(digit);

    const newTick: Tick = {
      value,
      epoch: tick.epoch || Date.now() / 1000,
      timestamp: new Date(
        (tick.epoch || Date.now() / 1000) * 1000,
      ).toLocaleTimeString('pt-BR'),
      digit,
      parity,
    };

    this.ticks.push(newTick);
    this.lastTickReceivedTime = Date.now();

    // Manter apenas os últimos maxTicks
    if (this.ticks.length > this.maxTicks) {
      this.ticks.shift();
    }

    // ✅ Log a cada tick para debug (temporário)
    this.logger.debug(
      `[AutonomousAgent][Tick][${tickSymbol}] Total: ${this.ticks.length} | Último: valor=${newTick.value} | dígito=${digit} | paridade=${parity}`,
    );

    // ✅ Enviar tick para o StrategyManager do agente autônomo com o símbolo correto
    if (!this.strategyManager) {
      this.logger.error('[StrategyManager] Indisponível - tick ignorado');
      return;
    }

    this.logger.debug(`[AutonomousAgent] Enviando tick para StrategyManager (symbol=${tickSymbol})`);

    // ✅ Log terminal para depuração de multi-símbolos
    if (tickSymbol !== 'R_100') {
      console.log(`[TERM] [AutonomousAgent] Submitting ${tickSymbol} tick to StrategyManager. Users active: ${this.activeSymbols.size}`);
    }

    this.strategyManager.processTick(newTick, tickSymbol).catch((error) => {
      this.logger.error(`[StrategyManager][${tickSymbol}] Erro ao processar tick:`, error);
    });
  }

  /**
   * ✅ NOVO: Método público para receber ticks externos (do AiService)
   * Permite que o AiService compartilhe ticks de R_100 com o AutonomousAgentService
   */
  public receiveExternalTick(tick: Tick, symbol: string = 'R_100'): void {
    if (!this.activeSymbols.has(symbol)) {
      return; // Apenas processar símbolos ativos
    }

    // Processar o tick como se tivesse vindo do WebSocket próprio
    this.processTick(
      {
        quote: tick.value.toString(),
        epoch: tick.epoch,
        symbol: symbol,
      },
      symbol,
    );
  }

  /**
   * ✅ NOVO: Obtém o símbolo associado a uma subscription ID
   */
  private getSymbolForSubscription(subscriptionId: string): string | null {
    for (const [symbol, subId] of this.subscriptions.entries()) {
      if (subId === subscriptionId) {
        return symbol;
      }
    }
    return null;
  }

  /**
   * Extrai o último dígito de um valor
   */
  private extractLastDigit(value: number): number {
    const numeric = Math.abs(value);
    const normalized = numeric.toString().replace('.', '').replace('-', '');
    return parseInt(normalized[normalized.length - 1], 10);
  }

  /**
   * Obtém paridade do dígito
   */
  private getParityFromDigit(digit: number): 'PAR' | 'IMPAR' {
    return digit % 2 === 0 ? 'PAR' : 'IMPAR';
  }

  /**
   * Sincroniza agentes ativos do banco de dados
   */
  async syncActiveAgentsFromDb(): Promise<void> {
    try {
      // ✅ [FIX] BUSCAR APENAS A ESTRATÉGIA MAIS RECENTE POR USUÁRIO
      // Evita reativar múltiplas estratégias se houver mais de uma marcada como ativa
      const activeAgents = await this.dataSource.query(
        `SELECT c.*
         FROM autonomous_agent_config c
         INNER JOIN (
           SELECT user_id, MAX(updated_at) as max_updated
           FROM autonomous_agent_config
           WHERE is_active = TRUE 
             AND session_status NOT IN ('stopped_profit', 'stopped_loss', 'stopped_blindado', 'stopped_consecutive_loss')
           GROUP BY user_id
         ) latest ON c.user_id = latest.user_id AND c.updated_at = latest.max_updated
         WHERE c.is_active = TRUE`,
      );

      this.logger.log(`[SyncActiveAgents] Sincronizando ${activeAgents.length} agentes ativos`);

      for (const agent of activeAgents) {
        try {
          const strategyName = agent.agent_type || 'orion';
          const userId = agent.user_id.toString();

          // ✅ [ZENIX v3.4] Restaurar sessionId em memória se presente no banco
          const sessionId = agent.session_id ? parseInt(agent.session_id) : null;
          if (sessionId) {
            this.userSessionIds.set(userId, sessionId);
          }

          await this.strategyManager.activateUser(strategyName, userId, {
            userId: userId,
            sessionId: sessionId, // Restaurar sessionId
            initialStake: parseFloat(agent.initial_stake),
            dailyProfitTarget: parseFloat(agent.daily_profit_target),
            dailyLossLimit: parseFloat(agent.daily_loss_limit),
            derivToken: agent.token_deriv || agent.deriv_token, // ✅ Usar token_deriv (conta padrão) com fallback para deriv_token
            currency: agent.currency,
            status: agent.status,
            symbol: strategyName === 'zeus' ? '1HZ100V' : (agent.symbol || 'R_100'),
            tradingMode: agent.trading_mode || 'normal',
            initialBalance: parseFloat(agent.initial_balance) || 0,
            // Passar type explicitamente para strategies que precisam (Sentinel/Falcon)
            stopLossType: agent.stop_loss_type,
            riskProfile: agent.risk_level || agent.risk_profile,
            agentType: agent.agent_type
          });
        } catch (err) {
          this.logger.error(`[SyncActiveAgents] Erro ao ativar usuário ${agent.user_id}: ${err.message}`);
        }
      }

      // Verificar se há agentes que precisam ser resetados (mudança de dia)
      await this.checkAndResetDailySessions();
    } catch (error) {
      this.logger.error('[SyncActiveAgents] Erro ao sincronizar agentes:', error);
    }
  }

  /**
   * Verifica e reseta sessões diárias se necessário
   * Se um agente parou no dia anterior (stop loss/win/blindado), reseta para o novo dia
   * Se um agente continua ativo mas a sessão é de ontem, reseta o lucro diário
   */
  async checkAndResetDailySessions(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split('T')[0];

      // 1. Resetar agentes que bateram stop em DIAS ANTERIORES
      // ✅ CORREÇÃO: Usar todayStr para garantir que só reseta se mudou o dia.
      // Removido o filtro de 1 hora que causava resets prematuros.
      const agentsToReset = await this.dataSource.query(
        `SELECT id, user_id, agent_type, session_status, trading_mode, session_source FROM autonomous_agent_config 
         WHERE is_active = TRUE 
           AND session_status IN ('stopped_profit', 'stopped_loss', 'stopped_blindado', 'stopped_consecutive_loss') 
           AND (session_date IS NULL OR DATE(session_date) < ?)`,
        [todayStr],
      );

      // 2. Resetar lucro diário de agentes que ficaram ATIVOS mas mudou o dia
      const activeAgentsToReset = await this.dataSource.query(
        `SELECT id, user_id, session_status, session_date, agent_type, trading_mode, session_source
         FROM autonomous_agent_config 
         WHERE is_active = TRUE 
           AND session_status = 'active'
           AND (session_date IS NULL OR DATE(session_date) < ?)`,
        [todayStr],
      );

      const allAgentsToReset = [...agentsToReset, ...activeAgentsToReset];

      for (const agent of allAgentsToReset) {
        this.logger.log(
          `[ResetDailySession] Resetando sessão diária para usuário ${agent.user_id} (status anterior: ${agent.session_status})`,
        );

        // ✅ [ZENIX v3.3] Registrar Log de Fechamento Diário para o Relatório
        if (this.logQueueService) {
          this.logQueueService.saveLogAsync({
            userId: agent.user_id.toString(),
            level: 'INFO',
            module: 'CORE',
            message: 'Sessão finalizada por FECHAMENTO DIÁRIO às 00:00 (Reset Automático)',
            icon: 'ℹ️',
            details: { resetType: 'midnight' },
            tableName: 'autonomous_agent_logs',
          });
        }

        // Resetar sessão diária no banco
        await this.dataSource.query(
          `UPDATE autonomous_agent_config 
           SET session_status = 'active',
               session_date = NOW(),
               daily_profit = 0,
               daily_loss = 0
           WHERE user_id = ? AND is_active = TRUE`,
          [agent.user_id],
        );

        // Reativar agente na estratégia correta para atualizar o estado em memória (resetar profit interno)
        const config = await this.dataSource.query(
          `SELECT initial_stake, daily_profit_target, daily_loss_limit, 
                  deriv_token, currency, symbol, trading_mode, initial_balance, agent_type,
                  stop_loss_type, risk_level, token_deriv, session_source
           FROM autonomous_agent_config 
           WHERE user_id = ? AND is_active = TRUE
           LIMIT 1`,
          [agent.user_id],
        );

        if (config && config.length > 0) {
          const agentConfig = config[0];
          const userId = agent.user_id.toString();
          const strategyName = agentConfig.agent_type || 'orion';

          // ✅ Forçar "reativação" para garantir RESET DE ESTADO (já que é novo dia)
          // Como já corrigimos o StrategyManager para não dar deactivate se for o mesmo,
          // aqui precisamos decidir se queremos FORÇAR o reset. 
          // Dada a mudança no dia, queremos que o lucro interno volte a zero.

          // Se for active, poderíamos apenas chamar activateUser? 
          // O activateUser já lida com a lógica de não resetar se for o mesmo.
          // Para forçar o reset em memória (lucro diário 0), talvez as estratégias precisem de um sinal de reset.
          // Mas no Zeus/Falcon, activateUser SEMPRE limpa o lucro se houver mudança significativa
          // ou se for a primeira vez. 

          // Para garantir que o lucro zere à meia noite:
          await this.strategyManager.deactivateUser(userId);

          // ✅ [ZENIX v3.4] Iniciar NOVA SESSÃO para o novo dia
          const sessionSource = agentConfig.session_source || 'ALUNO';
          const newSessionId = await this.createNewSession(userId, strategyName, agentConfig.trading_mode || 'normal', sessionSource);

          // Atualizar config com o novo session_id
          await this.dataSource.query(
            `UPDATE autonomous_agent_config SET session_id = ? WHERE user_id = ?`,
            [newSessionId, userId]
          );

          await this.strategyManager.activateUser(strategyName, userId, {
            userId: userId,
            sessionId: newSessionId, // Nova sessão
            initialStake: parseFloat(agentConfig.initial_stake),
            dailyProfitTarget: parseFloat(agentConfig.daily_profit_target),
            dailyLossLimit: parseFloat(agentConfig.daily_loss_limit),
            derivToken: agentConfig.token_deriv || agentConfig.deriv_token,
            currency: agentConfig.currency,
            symbol: agentConfig.symbol || 'R_100',
            tradingMode: agentConfig.trading_mode || 'normal',
            initialBalance: parseFloat(agentConfig.initial_balance) || 0,
            stopLossType: agentConfig.stop_loss_type,
            riskProfile: agentConfig.risk_level || agentConfig.risk_profile,
            agentType: agentConfig.agent_type
          });
        }
      }

      if (allAgentsToReset.length > 0) {
        this.logger.log(`[ResetDailySession] ✅ ${allAgentsToReset.length} sessões resetadas para o novo dia`);
      }
    } catch (error) {
      this.logger.error('[ResetDailySession] Erro ao verificar e resetar sessões:', error);
    }
  }

  /**
   * Ativa um agente autônomo
   */
  async activateAgent(userId: string, config: any): Promise<void> {
    try {
      // ✅ [ORION] Resolução de Token Baseada em Preferência (Feature Solicitada)
      // Buscar configurações de moeda e tokens salvos
      this.logger.log(`[ActivateAgent] 🔍 Resolvendo token para Agente Autônomo (User: ${userId})`);

      const userSettings = await this.dataSource.query(
        `SELECT s.trade_currency, u.token_demo, u.token_real 
         FROM users u
         LEFT JOIN user_settings s ON u.id = s.user_id
         WHERE u.id = ?`,
        [userId]
      );

      let resolvedToken = config.derivToken;
      let resolvedCurrency = config.currency || 'USD';

      if (userSettings && userSettings.length > 0) {
        const { trade_currency, token_demo, token_real } = userSettings[0];
        const preferredCurrency = (trade_currency || 'USD').toUpperCase();

        resolvedCurrency = preferredCurrency;

        // Log Detalhado de Resolução (Debug)
        this.logger.log(`[ActivateAgent][${userId}] 🔍 Rastreio de Token:
            - Modo Preferido: ${preferredCurrency}
            - Token Demo (DB): ${token_demo ? token_demo.substring(0, 8) + '...' : 'N/A'}
            - Token Real (DB): ${token_real ? token_real.substring(0, 8) + '...' : 'N/A'}
            - Token Config Inicial: ${config.derivToken ? config.derivToken.substring(0, 8) + '...' : 'N/A'}
        `);

        if (preferredCurrency === 'DEMO') {
          if (token_demo) {
            resolvedToken = token_demo;
            this.logger.log(`[ActivateAgent] ✅ Modo: DEMO | Moeda: ${preferredCurrency} | Token: ${resolvedToken.substring(0, 8)}... (Usando token_demo do banco)`);
          } else {
            this.logger.warn(`[ActivateAgent] ⚠️ Modo DEMO solicitado, mas 'token_demo' não encontrado no banco. Usando token fornecido: ${resolvedToken ? resolvedToken.substring(0, 8) + '...' : 'N/A'}`);
          }
        } else {
          // USD ou outra moeda Real
          if (token_real) {
            resolvedToken = token_real;
            this.logger.log(`[ActivateAgent] ✅ Modo: REAL | Moeda: ${preferredCurrency} | Token: ${resolvedToken.substring(0, 8)}... (Usando token_real do banco)`);
          } else {
            this.logger.warn(`[ActivateAgent] ⚠️ Modo REAL (${preferredCurrency}) solicitado, mas 'token_real' não encontrado no banco. Usando token fornecido: ${resolvedToken ? resolvedToken.substring(0, 8) + '...' : 'N/A'}`);
          }
        }
      } else {
        this.logger.warn(`[ActivateAgent] ⚠️ Configurações de usuário não encontradas. Usando dados fornecidos no payload.`);
      }

      // Atualizar config com os valores resolvidos para garantir consistência
      config.derivToken = resolvedToken;
      config.currency = resolvedCurrency;

      // ✅ Buscar informações adicionais da conta padrão (token_deriv e amount_deriv)
      let tokenDeriv: string | null = null;
      let amountDeriv: number | null = null;

      if (userSettings && userSettings.length > 0) {
        const { trade_currency, token_demo, token_real } = userSettings[0];
        const tradeCurrency = (trade_currency || 'USD').toUpperCase();

        // Determinar token e amount baseado na conta padrão
        if (tradeCurrency === 'DEMO') {
          tokenDeriv = token_demo;

          // Buscar saldo demo
          const demoBalance = await this.dataSource.query(
            `SELECT demo_amount FROM users WHERE id = ?`,
            [userId]
          );
          amountDeriv = demoBalance && demoBalance.length > 0 ? parseFloat(demoBalance[0].demo_amount || 0) : 0;
        } else {
          // Para USD, BTC ou outras contas reais
          tokenDeriv = token_real;

          // Buscar saldo real e deriv_raw para obter o saldo específico da moeda
          const realData = await this.dataSource.query(
            `SELECT real_amount, deriv_raw FROM users WHERE id = ?`,
            [userId]
          );

          if (realData && realData.length > 0) {
            amountDeriv = parseFloat(realData[0].real_amount || 0);

            // Se deriv_raw estiver disponível, pegar o saldo específico da moeda
            try {
              const derivRaw = typeof realData[0].deriv_raw === 'string'
                ? JSON.parse(realData[0].deriv_raw)
                : realData[0].deriv_raw;

              if (derivRaw?.authorize?.account_list) {
                const defaultAccount = derivRaw.authorize.account_list.find(
                  (acc: any) => acc.currency === tradeCurrency && !acc.is_virtual
                );
                if (defaultAccount) {
                  amountDeriv = parseFloat(defaultAccount.balance || 0);
                }
              }
            } catch (parseError) {
              this.logger.warn(`[ActivateAgent] ⚠️ Erro ao processar deriv_raw:`, parseError);
            }
          }
        }

        this.logger.log(
          `[ActivateAgent] 💰 Conta padrão: currency=${tradeCurrency}, token=${tokenDeriv ? tokenDeriv.substring(0, 8) + '...' : 'null'}, amount=${amountDeriv}`
        );
      }

      // ✅ [ZENIX v2.0] GARANTIR EXCLUSIVIDADE: Desativar qualquer estratégia anterior antes de iniciar a nova
      // Isso resolve o problema de múltiplos agentes rodando simultaneamente (ex: Sentinel e Falcon juntos)
      try {
        await this.strategyManager.deactivateUser(userId);
        this.logger.log(`[ActivateAgent] 🔄 Estratégias anteriores desativadas para usuário ${userId}`);
      } catch (deactivateError) {
        this.logger.warn(`[ActivateAgent] ⚠️ Erro ao desativar estratégias anteriores (não crítico):`, deactivateError);
      }

      // ✅ [ORION] PRIMEIRA AÇÃO: Deletar logs anteriores ao iniciar nova sessão
      // (mantém apenas as transações/trades)
      try {
        await this.dataSource.query(
          `DELETE FROM autonomous_agent_logs 
           WHERE user_id = ?`,
          [userId],
        );
        this.logger.log(`[ActivateAgent] 🗑️ Logs anteriores deletados para usuário ${userId}`);
      } catch (error) {
        this.logger.error(`[ActivateAgent] ⚠️ Erro ao deletar logs do usuário ${userId}:`, error);
        // Não bloquear a ativação se houver erro ao deletar logs
      }

      // ✅ [FIX] Desativar TODAS as outras estratégias ativas do usuário no banco
      // Isso garante que apenas UMA estratégia esteja ativa por vez
      try {
        await this.dataSource.query(
          `UPDATE autonomous_agent_config 
           SET is_active = FALSE, updated_at = NOW() 
           WHERE user_id = ? AND is_active = TRUE`,
          [userId]
        );
        this.logger.log(`[ActivateAgent] ✅ Estratégias anteriores desativadas no banco para usuário ${userId}`);
      } catch (dbError) {
        this.logger.error(`[ActivateAgent] Erro ao desativar estratégias anteriores:`, dbError);
        // Não bloquear - continuar com a ativação
      }

      // ✅ Limpar histórico de ticks para este usuário (começar do zero)
      // Os ticks serão coletados novamente a partir da nova sessão
      // Nota: ticks são globais, mas podemos filtrar por timestamp da sessão no frontend

      // ✅ Limpar histórico de ticks para este usuário (começar do zero)
      // Os ticks serão coletados novamente a partir da nova sessão
      // Nota: ticks são globais, mas podemos filtrar por timestamp da sessão no frontend

      // Verificar se já existe configuração (independente de is_active)
      // O índice idx_user_id é UNIQUE, então só pode haver um registro por user_id
      const existing = await this.dataSource.query(
        `SELECT id, is_active FROM autonomous_agent_config 
         WHERE user_id = ?
         LIMIT 1`,
        [userId],
      );

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (existing && existing.length > 0) {
        // Atualizar configuração existente (reativar se estava desativada)
        // ✅ Determinar agent_type baseado na estratégia
        const agentType = (config.agentType || config.strategy || 'orion').toLowerCase();
        const normalizedAgentType = agentType === 'arion' ? 'orion' : agentType;

        await this.dataSource.query(
          `UPDATE autonomous_agent_config 
           SET is_active = TRUE,
               initial_stake = ?,
               daily_profit_target = ?,
               daily_loss_limit = ?,
               deriv_token = ?,
               token_deriv = ?,
               amount_deriv = ?,
               currency = ?,
               symbol = ?,
               agent_type = ?,
               trading_mode = ?,
               stop_loss_type = ?,
               initial_balance = ?,
               risk_level = ?,
               session_status = 'active',
               session_date = NOW(),
               daily_profit = 0,
               daily_loss = 0,
               updated_at = NOW()
           WHERE user_id = ?`,
          [
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            config.derivToken,
            tokenDeriv,
            amountDeriv,
            config.currency || 'USD',
            config.symbol || 'R_100', // Default fallback, but respects V2 symbols if provided
            normalizedAgentType,
            config.tradingMode || 'normal',
            config.stopLossType || 'normal',
            config.initialBalance || 0,
            config.riskProfile || 'balanced',
            userId,
          ],
        );
        this.logger.log(`[ActivateAgent] ✅ Configuração existente atualizada para usuário ${userId}`);
      } else {
        // ✅ Determinar agent_type baseado na estratégia
        const agentType = (config.agentType || config.strategy || 'orion').toLowerCase();
        const normalizedAgentType = agentType === 'arion' ? 'orion' : agentType;

        // Criar nova configuração
        await this.dataSource.query(
          `INSERT INTO autonomous_agent_config 
           (user_id, is_active, initial_stake, daily_profit_target, daily_loss_limit,
            deriv_token, token_deriv, amount_deriv, currency, symbol, agent_type, trading_mode, stop_loss_type, initial_balance, risk_level,
            session_status, session_date, daily_profit, daily_loss, created_at, updated_at)
           VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), 0, 0, NOW(), NOW())`,
          [
            userId,
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            config.derivToken,
            tokenDeriv,
            amountDeriv,
            config.currency || 'USD',
            normalizedAgentType === 'zeus' ? '1HZ100V' : (config.symbol || 'R_100'),
            normalizedAgentType,
            config.tradingMode || 'normal',
            config.stopLossType || 'normal',
            config.initialBalance || 0,
            config.riskProfile || 'balanced',
          ],
        );
        this.logger.log(`[ActivateAgent] ✅ Nova configuração criada para usuário ${userId}`);
      }

      // ✅ Determinar estratégia baseado no agentType
      // Normalizar estratégia: 'arion' -> 'orion'
      let strategy = (config.agentType || config.strategy || 'orion').toLowerCase();
      if (strategy === 'arion') {
        strategy = 'orion';
      }

      // ✅ Suportar Orion, Sentinel, Falcon e Zeus
      if (strategy !== 'orion' && strategy !== 'sentinel' && strategy !== 'falcon' && strategy !== 'zeus') {
        this.logger.warn(`[ActivateAgent] Estratégia '${strategy}' solicitada, mas apenas 'orion', 'sentinel', 'falcon' e 'zeus' estão disponíveis. Usando 'orion'.`);
        strategy = 'orion';
      }

      // Verificar se strategyManager está disponível
      if (!this.strategyManager) {
        throw new Error('StrategyManager não está disponível. Verifique se o módulo foi inicializado corretamente.');
      }

      // ✅ Zeus usa exclusivamente 1HZ100V
      const agentSymbol = strategy === 'zeus' ? '1HZ100V' : (config.symbol || 'R_100');

      // ✅ Garantir que estamos inscritos no símbolo necessário
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (!this.subscriptions.has(agentSymbol)) {
          this.logger.log(`📡 Inscrevendo-se em ${agentSymbol} para usuário ${userId}...`);
          const subscriptionPayload = {
            ticks_history: agentSymbol,
            adjust_start_time: 1,
            count: this.maxTicks,
            end: 'latest',
            subscribe: 1,
            style: 'ticks',
          };
          this.send(subscriptionPayload);
          this.activeSymbols.add(agentSymbol);
        }
      }

      // Ativar agente na estratégia
      try {
        // ✅ Log para confirmar qual token está sendo usado
        const tokenToUse = tokenDeriv || config.derivToken;
        this.logger.log(
          `[ActivateAgent] 🔑 Token a ser usado: ${tokenDeriv ? 'token_deriv (conta padrão)' : 'deriv_token (fornecido)'} | Token: ${tokenToUse ? tokenToUse.substring(0, 8) + '...' : 'N/A'}`
        );

        // ✅ [ZENIX v3.4] Iniciar nova sessão no ai_sessions para tracking
        const sessionSource = config.session_source || config.sessionSource || 'ALUNO';
        const sessionId = await this.createNewSession(userId, strategy, config.tradingMode || 'normal', sessionSource);

        // Atualizar config com o novo session_id e session_source
        await this.dataSource.query(
          `UPDATE autonomous_agent_config 
           SET session_id = ?, session_source = ? 
           WHERE user_id = ?`,
          [sessionId, sessionSource, userId]
        );

        await this.strategyManager.activateUser(strategy, userId, {
          userId: userId,
          sessionId: sessionId, // Passar sessionId para a estratégia
          initialStake: config.initialStake,
          dailyProfitTarget: config.dailyProfitTarget,
          dailyLossLimit: config.dailyLossLimit,
          derivToken: tokenDeriv || config.derivToken, // ✅ Usar token_deriv (conta padrão) com fallback
          currency: config.currency || 'USD',
          symbol: agentSymbol,
          tradingMode: config.tradingMode || 'normal',
          initialBalance: config.initialBalance || 0,
          // ✅ Parâmetros extras necessários para logic de proteção/gestão
          stopLossType: config.stopLossType,
          riskProfile: this.normalizeRiskProfile(config.riskProfile),
          agentType: strategy
        });
        this.logger.log(`[ActivateAgent] ✅ Usuário ${userId} ativado na estratégia ${strategy} (Session ID: ${sessionId})`);
      } catch (strategyError) {
        this.logger.error(`[ActivateAgent] Erro ao ativar usuário na estratégia ${strategy}:`, strategyError);
        throw new Error(`Erro ao ativar agente na estratégia ${strategy}: ${strategyError.message}`);
      }

      this.logger.log(`[ActivateAgent] ✅ Agente autônomo ativado para usuário ${userId}`);
    } catch (error) {
      this.logger.error(`[ActivateAgent] Erro ao ativar agente:`, error);
      throw error;
    }
  }

  /**
   * ✅ [ZENIX v3.4] Cria uma nova sessão no banco ai_sessions
   */
  private async createNewSession(userId: string, agentType: string, tradingMode: string, sessionSource: string = 'ALUNO'): Promise<number> {
    try {
      // 1. Fechar sessões anteriores do usuário (se houver)
      await this.dataSource.query(
        `UPDATE ai_sessions SET status = 'closed', end_time = NOW() WHERE user_id = ? AND status = 'active'`,
        [userId]
      );

      // 2. Criar nova sessão
      const aiName = `AGENT_${agentType.toUpperCase()}_${sessionSource.toUpperCase()}`;
      const accountType = tradingMode === 'real' ? 'real' : 'demo';

      const result = await this.dataSource.query(
        `INSERT INTO ai_sessions (user_id, ai_name, status, account_type, start_time, total_trades, total_wins, total_losses, total_profit) 
         VALUES (?, ?, 'active', ?, NOW(), 0, 0, 0, 0)`,
        [userId, aiName, accountType]
      );

      const sessionId = result.insertId;
      this.userSessionIds.set(userId, sessionId);
      this.logger.log(`[CreateNewSession] ✅ Nova sessão criada para user ${userId}: ${aiName} (ID: ${sessionId})`);

      return sessionId;
    } catch (error) {
      this.logger.error(`[CreateNewSession] ❌ Erro ao criar nova sessão para user ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Desativa um agente autônomo
   */
  async deactivateAgent(userId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE autonomous_agent_config 
         SET is_active = FALSE, updated_at = NOW()
         WHERE user_id = ? AND is_active = TRUE`,
        [userId],
      );

      await this.strategyManager.deactivateUser(userId);

      // ✅ [ZENIX v3.4] Fechar sessão no ai_sessions
      const sessionId = this.userSessionIds.get(userId);
      if (sessionId) {
        await this.dataSource.query(
          `UPDATE ai_sessions SET status = 'inactive', end_time = NOW() WHERE id = ?`,
          [sessionId]
        );
        this.userSessionIds.delete(userId);
        this.logger.log(`[DeactivateAgent] ✅ Sessão ${sessionId} encerrada para usuário ${userId}`);
      }

      this.logger.log(`[DeactivateAgent] ✅ Agente autônomo desativado para usuário ${userId}`);
    } catch (error) {
      this.logger.error(`[DeactivateAgent] Erro ao desativar agente:`, error);
      throw error;
    }
  }

  /**
   * Obtém configuração do agente
   */
  async getAgentConfig(userId: string): Promise<any> {
    const config = await this.dataSource.query(
      `SELECT * FROM autonomous_agent_config 
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );

    return config && config.length > 0 ? config[0] : null;
  }

  /**
   * Obtém histórico de trades da sessão atual (após session_date)
   */
  async getTradeHistory(userId: string, limit: number = 50): Promise<any[]> {
    // ✅ Buscar session_date da configuração do agente
    const configResults = await this.dataSource.query(
      `SELECT session_date, session_id
        FROM autonomous_agent_config
        WHERE user_id = ? AND is_active = TRUE
        LIMIT 1`,
      [userId],
    );

    // ✅ Se não houver configuração, retornar vazio
    if (!configResults || configResults.length === 0) {
      return [];
    }

    const sessionDate = configResults[0].session_date;
    const sessionId = configResults[0].session_id;

    // ✅ Filtrar por session_id (prioridade) ou session_date
    const whereClause = sessionId
      ? `WHERE user_id = ? AND session_id = ?`
      : (sessionDate ? `WHERE user_id = ? AND created_at >= ?` : `WHERE user_id = ?`);
    const queryParams = sessionId ? [userId, sessionId] : (sessionDate ? [userId, sessionDate] : [userId]);

    return await this.dataSource.query(
      `SELECT * FROM autonomous_agent_trades
        ${whereClause}
        ORDER BY COALESCE(closed_at, created_at) DESC
        LIMIT ?`,
      [...queryParams, limit],
    );
  }

  /**
   * Obtém estatísticas da sessão
   * Calcula o lucro do dia baseado nas operações finalizadas do dia atual
   */
  async getSessionStats(userId: string): Promise<any> {
    // ✅ Buscar configuração do agente
    const config = await this.dataSource.query(
      `SELECT 
         daily_profit,
         daily_loss,
         total_trades,
         total_wins,
         total_losses,
        session_id,
        session_status,
        session_date,
        initial_stake as totalCapital,
        initial_balance
      FROM autonomous_agent_config 
      WHERE user_id = ? AND is_active = TRUE
      LIMIT 1`,
      [userId],
    );

    // ✅ Se não houver configuração, retornar valores padrão
    if (!config || config.length === 0) {
      return {
        daily_profit: 0,
        daily_loss: 0,
        netProfit: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalCapital: 0,
        initialBalance: 0,
        operationsToday: 0,
        session_status: 'inactive',
        session_date: null,
      };
    }

    const configData = config[0];

    // ✅ Buscar operações finalizadas da sessão atual (após session_date)
    const sessionDate = configData.session_date;
    const sessionId = configData.session_id;

    // ✅ Se não houver session_date nem session_id, retornar valores zerados
    if (!sessionDate && !sessionId) {
      return {
        daily_profit: 0,
        daily_loss: 0,
        netProfit: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalCapital: Number(parseFloat(configData.totalCapital || 0).toFixed(2)),
        initialBalance: Number(parseFloat(configData.initial_balance || configData.totalCapital || 0).toFixed(2)),
        operationsToday: 0,
        session_status: configData.session_status || 'active',
        session_date: null,
      };
    }

    // ✅ Filtrar por session_id (prioridade) ou session_date
    const whereClause = sessionId
      ? `WHERE user_id = ? AND session_id = ?`
      : `WHERE user_id = ? AND created_at >= ?`;
    const params = sessionId ? [userId, sessionId] : [userId, sessionDate];

    const sessionTrades = await this.dataSource.query(
      `SELECT 
          status,
          profit_loss,
          created_at,
          closed_at
        FROM autonomous_agent_trades 
        ${whereClause}
          AND status IN ('WON', 'LOST')
          AND profit_loss IS NOT NULL
        ORDER BY COALESCE(closed_at, created_at) DESC`,
      params,
    );

    // ✅ Calcular lucro/perda do dia baseado nas operações
    let dailyProfitFromTrades = 0;
    let dailyLossFromTrades = 0;
    let winsToday = 0;
    let lossesToday = 0;

    this.logger.debug(
      `[GetSessionStats][${userId}] 📊 Operações encontradas da sessão (após ${sessionDate}): ${sessionTrades?.length || 0}`,
    );

    if (sessionTrades && sessionTrades.length > 0) {
      for (const trade of sessionTrades) {
        const profitLoss = parseFloat(trade.profit_loss) || 0;
        this.logger.debug(
          `[GetSessionStats][${userId}] 📊 Trade: status=${trade.status}, profit_loss=${profitLoss}`,
        );
        if (trade.status === 'WON') {
          dailyProfitFromTrades += profitLoss;
          winsToday++;
        } else if (trade.status === 'LOST') {
          dailyLossFromTrades += Math.abs(profitLoss);
          lossesToday++;
        }
      }
    } else {
      this.logger.debug(
        `[GetSessionStats][${userId}] ⚠️ Nenhuma operação finalizada encontrada para a sessão atual (após ${sessionDate})`,
      );
    }

    // ✅ Lucro líquido do dia = lucros - perdas
    const netProfitToday = dailyProfitFromTrades - dailyLossFromTrades;
    const totalTradesToday = winsToday + lossesToday;
    const winRateToday = totalTradesToday > 0 ? (winsToday / totalTradesToday) * 100 : 0;

    // ✅ Log para debug
    this.logger.debug(
      `[GetSessionStats][${userId}] 📊 Estatísticas do dia: ` +
      `trades=${totalTradesToday}, wins=${winsToday}, losses=${lossesToday}, ` +
      `profit=$${dailyProfitFromTrades.toFixed(2)}, loss=$${dailyLossFromTrades.toFixed(2)}, ` +
      `netProfit=$${netProfitToday.toFixed(2)}`,
    );

    // ✅ Calcular saldo inicial para porcentagem (usar initial_balance se disponível, senão usar initial_stake)
    const initialBalance = parseFloat(configData.initial_balance) || parseFloat(configData.totalCapital) || 0;

    // ✅ Obter evolução da sessão para o gráfico
    const evolution = await this.getSessionEvolution(userId);

    // ✅ Retornar dados no formato esperado pelo frontend (garantir que todos sejam números)
    return {
      daily_profit: Number(dailyProfitFromTrades.toFixed(2)),
      daily_loss: Number(dailyLossFromTrades.toFixed(2)),
      netProfit: Number(netProfitToday.toFixed(2)), // ✅ Lucro líquido do dia
      totalTrades: totalTradesToday,
      wins: winsToday,
      losses: lossesToday,
      winRate: Number(winRateToday.toFixed(2)),
      totalProfit: Number(dailyProfitFromTrades.toFixed(2)),
      totalLoss: Number(dailyLossFromTrades.toFixed(2)),
      totalCapital: Number(parseFloat(configData.totalCapital || 0).toFixed(2)),
      initialBalance: Number(initialBalance.toFixed(2)), // ✅ Saldo inicial para cálculo de porcentagem
      operationsToday: totalTradesToday,
      session_status: configData.session_status || 'active',
      session_date: configData.session_date || null,
      evolution: evolution, // ✅ Adicionado para o gráfico
    };
  }

  /**
   * Obtém histórico de preços para um usuário
   * Retorna apenas ticks da sessão atual (após session_date)
   */
  async getPriceHistoryForUser(userId: string, limit: number = 100): Promise<any[]> {
    try {
      // Buscar data da sessão atual do usuário
      const config = await this.dataSource.query(
        `SELECT session_date FROM autonomous_agent_config 
         WHERE user_id = ? AND is_active = TRUE
         LIMIT 1`,
        [userId],
      );

      let sessionStartTime = 0;
      if (config && config.length > 0 && config[0].session_date) {
        sessionStartTime = new Date(config[0].session_date).getTime() / 1000;
      }

      // Filtrar ticks apenas da sessão atual (após session_date)
      const sessionTicks = this.ticks.filter((tick) => {
        const tickTime = tick.epoch || (tick.timestamp ? new Date(tick.timestamp).getTime() / 1000 : 0);
        return tickTime >= sessionStartTime;
      });

      // Retornar os últimos ticks da sessão atual
      return sessionTicks.slice(-limit).map((tick) => ({
        value: tick.value,
        epoch: tick.epoch,
        timestamp: tick.timestamp,
      }));
    } catch (error) {
      this.logger.error(`[GetPriceHistoryForUser] Erro ao buscar histórico:`, error);
      // Em caso de erro, retornar últimos ticks globais
      return this.ticks.slice(-limit).map((tick) => ({
        value: tick.value,
        epoch: tick.epoch,
        timestamp: tick.timestamp,
      }));
    }
  }

  /**
   * Obtém logs do agente
   * ✅ OTIMIZADO: Cache de session_date para reduzir queries
   */
  private sessionDateCache: Map<string, { date: Date | string | null; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30000; // 30 segundos

  async getLogs(userId: string, limit: number = 50000): Promise<any[]> {
    const limitClause = `LIMIT ${limit}`;

    // ✅ Usar cache para session_info (evita query desnecessária a cada 2 segundos)
    let sessionStartTime: Date | string | null = null;
    let sessionId: string | null = null;
    const cached = this.sessionDateCache.get(userId) as any;
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      // Usar cache se ainda válido (menos de 30 segundos)
      sessionStartTime = cached.date;
      sessionId = cached.sessionId;
    } else {
      // Buscar session_date e session_id apenas se cache expirou ou não existe
      const config = await this.dataSource.query(
        `SELECT session_date, session_id FROM autonomous_agent_config 
          WHERE user_id = ?
          ORDER BY updated_at DESC
          LIMIT 1`,
        [userId],
      );

      if (config && config.length > 0) {
        sessionStartTime = config[0].session_date;
        sessionId = config[0].session_id;
        // Atualizar cache
        this.sessionDateCache.set(userId, {
          date: sessionStartTime,
          sessionId: sessionId,
          timestamp: now,
        } as any);
      } else {
        // Cachear null também para evitar queries repetidas
        this.sessionDateCache.set(userId, {
          date: null,
          sessionId: null,
          timestamp: now,
        } as any);
      }
    }

    // ✅ Filtrar logs apenas por session_date (timestamp >= session_start)
    // NOTA: autonomous_agent_logs NÃO tem coluna session_id — filtrar por ela causaria erro SQL
    let whereClause = '';
    let params: any[] = [userId];

    if (sessionStartTime) {
      whereClause = `WHERE user_id = ? AND timestamp >= ?`;
      params.push(sessionStartTime);
    } else {
      // Sem session_date: mostrar logs das últimas 24h
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      whereClause = `WHERE user_id = ? AND timestamp >= ?`;
      params.push(yesterday.toISOString().slice(0, 19).replace('T', ' '));
    }

    const logs = await this.dataSource.query(
      `SELECT 
         id,
         user_id,
         timestamp,
         log_level,
         module,
         message,
         metadata
       FROM autonomous_agent_logs 
       ${whereClause}
       ORDER BY timestamp DESC 
       ${limitClause}`,
      params,
    );

    // ✅ Converter campos snake_case para camelCase para o frontend
    return (logs || []).map((log: any) => ({
      id: log.id,
      userId: log.user_id,
      timestamp: log.timestamp,
      logLevel: log.log_level,
      level: log.log_level, // Alias para compatibilidade
      module: log.module,
      message: log.message,
      metadata: log.metadata,
    }));
  }

  /**
   * Atualiza trades com preços faltantes
   */
  async updateTradesWithMissingPrices(userId: string, limit: number = 10): Promise<any> {
    // Implementação similar à da IA
    return { updated: 0, deleted: 0, errors: 0 };
  }
  async getDailyStats(userId: string, days: number = 30, agent?: string, startDateStr?: string, endDateStr?: string): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let effectiveStartDate: Date;
    let effectiveEndDate: Date = new Date();
    effectiveEndDate.setHours(23, 59, 59, 999);

    if (startDateStr && endDateStr) {
      effectiveStartDate = new Date(startDateStr);
      effectiveStartDate.setHours(0, 0, 0, 0);
      effectiveEndDate = new Date(endDateStr);
      effectiveEndDate.setHours(23, 59, 59, 999);
    } else {
      effectiveStartDate = new Date(today);
      effectiveStartDate.setDate(today.getDate() - days);
      effectiveStartDate.setHours(0, 0, 0, 0);
    }

    // Buscar config para obter DATA DA SESSÃO e filtrar
    const config = await this.getAgentConfig(userId);
    const initialBalance = parseFloat(config?.initial_balance) || 0;
    // const sessionDate = config?.session_date ? new Date(config.session_date) : null;

    // Filter logic
    const strategyFilter = agent && agent !== 'all' ? 'AND strategy = ?' : '';
    const params: any[] = [userId, effectiveStartDate.toISOString(), effectiveEndDate.toISOString()];
    if (strategyFilter && agent) params.push(agent);

    // ✅ CORREÇÃO: Calcular lucro acumulado ANTES do periodo filtrado por estratégia
    const prevParams = [userId, effectiveStartDate.toISOString()];
    if (strategyFilter && agent) prevParams.push(agent);

    const prevTrades = await this.dataSource.query(
      `SELECT SUM(profit_loss) as total
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at < ?
         AND status IN ('WON', 'LOST')
         ${strategyFilter}`,
      prevParams
    );
    const prevProgress = parseFloat(prevTrades[0]?.total) || 0;

    const trades = await this.dataSource.query(
      `SELECT 
         DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) as date,
         SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) as profit,
         SUM(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE 0 END) as loss,
         COUNT(*) as ops,
         SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
         MIN(created_at) as first_op,
         MAX(created_at) as last_op
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at BETWEEN ? AND ?
         AND status IN ('WON', 'LOST')
         ${strategyFilter}
       GROUP BY DATE(CONVERT_TZ(created_at, '+00:00', '-03:00'))
       ORDER BY date ASC`, // ASC para calcular acumulado corretamente
      params
    );


    let cumulativeProfit = prevProgress;
    const dailyData = trades.map((day: any) => {
      const profit = parseFloat(day.profit) || 0;
      const loss = parseFloat(day.loss) || 0;
      const netProfit = profit - loss;
      const ops = parseInt(day.ops) || 0;
      const wins = parseInt(day.wins) || 0;
      const winRate = ops > 0 ? (wins / ops) * 100 : 0;

      cumulativeProfit += netProfit;

      // Calculate average interval
      let avgTime = '--';
      if (ops > 1 && day.first_op && day.last_op) {
        const first = new Date(day.first_op).getTime();
        const last = new Date(day.last_op).getTime();
        const diffMin = Math.round((last - first) / (60000 * (ops - 1)));
        avgTime = diffMin >= 60 ? `${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `${diffMin}min`;
      }

      return {
        date: new Date(day.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        fullDate: new Date(day.date).toISOString().split('T')[0],
        profit: Number(netProfit.toFixed(2)),
        ops,
        wins,
        winRate: Number(winRate.toFixed(2)),
        capital: Number(cumulativeProfit.toFixed(2)),
        avgTime,
        badge: ''
      };
    });

    return dailyData.reverse(); // Volta para DESC para o frontend
  }

  async getSummaryStats(userId: string, groupBy: 'week' | 'month' | 'semester' | 'year' = 'week', agent?: string): Promise<any[]> {
    // Buscar config para obter DATA DA SESSÃO e Saldo Inicial
    const config = await this.getAgentConfig(userId);
    const initialBalance = parseFloat(config?.initial_balance) || 0;

    const today = new Date();
    const startDate = new Date(today);

    // Determine lookback period based on grouping
    if (groupBy === 'week') startDate.setDate(today.getDate() - (26 * 7)); // 6 months of weeks
    else if (groupBy === 'month') startDate.setMonth(today.getMonth() - 24); // 2 years of months
    else if (groupBy === 'semester') startDate.setMonth(today.getMonth() - 60); // 5 years of semesters
    else if (groupBy === 'year') startDate.setFullYear(today.getFullYear() - 10); // 10 years

    // Se tiver sessao ativa, não mostrar dados anteriores a ela (Isso limita a visualização histórica?)
    // O comentário original dizia "Se tiver sessao ativa, não mostrar dados anteriores a ela".
    // Mas para relatórios "Anuais", precisamos ver tudo. Vamos relaxar isso se groupBy != week
    // Ou manter effectiveStartDate apenas se quisermos filtrar pela sessão atual?
    // User pediu "Resumo Semanal deve ter para selecionar...", isso implica ver histórico.
    // Vamos ignorar effectiveStartDate vinculado a sessão e usar startDate calculado.

    // Filter logic
    const strategyFilter = agent && agent !== 'all' ? 'AND strategy = ?' : '';
    const params: any[] = [userId, startDate.toISOString()];
    if (strategyFilter && agent) params.push(agent);

    // Fetch trades for the period
    const trades = await this.dataSource.query(
      `SELECT 
            created_at,
            profit_loss,
            status,
            strategy
         FROM autonomous_agent_trades 
         WHERE user_id = ? 
           AND created_at >= ?
           AND status IN ('WON', 'LOST')
           ${strategyFilter}
         ORDER BY created_at ASC`,
      params
    );

    // Grouping Map
    const groupMap = new Map<string, {
      start: Date,
      end: Date,
      profit: number,
      wins: number,
      ops: number,
      keyLabel: string // For display if needed
    }>();

    for (const trade of trades) {
      const date = new Date(trade.created_at);
      let key = '';
      let startOfGroup = new Date(date);
      let endOfGroup = new Date(date);
      let label = '';

      if (groupBy === 'week') {
        const day = date.getDay();
        const diff = date.getDate() - day;
        startOfGroup.setDate(diff);
        startOfGroup.setHours(0, 0, 0, 0);
        key = startOfGroup.toISOString().split('T')[0];

        endOfGroup = new Date(startOfGroup);
        endOfGroup.setDate(startOfGroup.getDate() + 6);
        endOfGroup.setHours(23, 59, 59, 999);
      } else if (groupBy === 'month') {
        startOfGroup.setDate(1);
        startOfGroup.setHours(0, 0, 0, 0);
        key = `${startOfGroup.getFullYear()}-${startOfGroup.getMonth()}`; // unique key

        endOfGroup = new Date(startOfGroup);
        endOfGroup.setMonth(startOfGroup.getMonth() + 1);
        endOfGroup.setDate(0); // Last day of month
        endOfGroup.setHours(23, 59, 59, 999);
      } else if (groupBy === 'semester') {
        const month = date.getMonth();
        const semesterStartMonth = month < 6 ? 0 : 6;
        startOfGroup.setMonth(semesterStartMonth, 1);
        startOfGroup.setHours(0, 0, 0, 0);
        key = `${startOfGroup.getFullYear()}-S${month < 6 ? 1 : 2}`;

        endOfGroup = new Date(startOfGroup);
        endOfGroup.setMonth(startOfGroup.getMonth() + 6);
        endOfGroup.setDate(0);
        endOfGroup.setHours(23, 59, 59, 999);
      } else if (groupBy === 'year') {
        startOfGroup.setMonth(0, 1);
        startOfGroup.setHours(0, 0, 0, 0);
        key = `${startOfGroup.getFullYear()}`;

        endOfGroup = new Date(startOfGroup);
        endOfGroup.setFullYear(startOfGroup.getFullYear() + 1);
        endOfGroup.setDate(0); // Dec 31 likely fails with setFullYear+1 setDate(0)? No, setFullYear+1 jan 1, setDate(0) -> Dec 31
        // Wait. new Date(2024, 0, 1) -> setFullYear(2025) -> 2025-01-01 -> setDate(0) -> 2024-12-31. Correct.
        // However, let's be explicit.
        endOfGroup = new Date(startOfGroup.getFullYear(), 11, 31, 23, 59, 59, 999);
      }

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          start: startOfGroup,
          end: endOfGroup,
          profit: 0,
          wins: 0,
          ops: 0,
          keyLabel: key
        });
      }

      const stats = groupMap.get(key)!;
      const profit = parseFloat(trade.profit_loss) || 0;
      stats.profit += profit;
      stats.ops += 1;
      if (trade.status === 'WON') stats.wins += 1;
    }

    // Convert to array and calculate cumulative capital
    const groupsList = Array.from(groupMap.values()).sort((a, b) => a.start.getTime() - b.start.getTime());

    // Precisamos do saldo inicial ANTES do primeiro grupo para calcular corretamente (Lucro Acumulado)
    // Query saldo anterior ao startDate filtrado por agente
    const prevParams = [userId, startDate.toISOString()];
    if (strategyFilter && agent) prevParams.push(agent);

    const prevTrades = await this.dataSource.query(
      `SELECT SUM(profit_loss) as total
         FROM autonomous_agent_trades 
         WHERE user_id = ? 
           AND created_at < ?
           AND status IN ('WON', 'LOST')
           ${strategyFilter}`,
      prevParams
    );
    const prevProfit = parseFloat(prevTrades[0]?.total) || 0;

    let currentCapital = prevProfit;
    const result: any[] = [];

    for (const group of groupsList) {
      let periodLabel = '';
      if (groupBy === 'week') {
        const startStr = group.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const endStr = group.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        periodLabel = `${startStr} - ${endStr}`;
      } else if (groupBy === 'month') {
        periodLabel = group.start.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
      } else if (groupBy === 'semester') {
        const sem = group.start.getMonth() < 6 ? '1º Sem' : '2º Sem';
        periodLabel = `${sem} ${group.start.getFullYear()}`;
      } else if (groupBy === 'year') {
        periodLabel = `${group.start.getFullYear()}`;
      }

      // Atualiza capital
      currentCapital += group.profit;

      // Yield relative to capital at start of group
      const startGroupCapital = currentCapital - group.profit;
      const percent = startGroupCapital > 0 ? (group.profit / startGroupCapital) * 100 : 0;
      const winRate = group.ops > 0 ? (group.wins / group.ops) * 100 : 0;

      result.push({
        period: periodLabel,
        // Helper fields for Frontend Click-to-Filter
        startDate: group.start.toISOString().split('T')[0],
        endDate: group.end.toISOString().split('T')[0],

        profit: Number(group.profit.toFixed(2)),
        finalCapital: Number(currentCapital.toFixed(2)),
        percent: Number(percent.toFixed(2)),
        ops: group.ops,
        winRate: Number(winRate.toFixed(1))
      });
    }

    // Sort descending (newest first) for UI
    return result.reverse();
  }

  async getProfitEvolution(userId: string, days: number = 30, agent?: string, startDateStr?: string, endDateStr?: string, aggregateBy: 'trade' | 'day' = 'trade'): Promise<any[]> {
    const config = await this.getAgentConfig(userId);
    const initialBalance = parseFloat(config?.initial_balance) || 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let startDate = new Date(today);
    let endDate: Date = new Date(); // now

    if (startDateStr && endDateStr) {
      startDate = new Date(startDateStr);
      // Se for data YYYY-MM-DD apenas, ajustar hora
      if (startDateStr.length === 10) startDate.setHours(0, 0, 0, 0);

      endDate = new Date(endDateStr);
      if (endDateStr.length === 10) endDate.setHours(23, 59, 59, 999);
    } else {
      // Adjust start date based on days parameter
      if (days <= 1) {
        startDate.setTime(today.getTime());
      } else {
        startDate.setDate(today.getDate() - days);
      }
    }

    // Filter logic
    const strategyFilter = agent && agent !== 'all' ? 'AND strategy = ?' : '';
    // Use BETWEEN for range
    const params: any[] = [userId, startDate.toISOString(), endDate.toISOString()];
    if (strategyFilter && agent) params.push(agent);

    // Select trades in the period
    const trades = await this.dataSource.query(
      `SELECT 
         created_at,
         profit_loss,
         strategy
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at BETWEEN ? AND ?
         AND status IN ('WON', 'LOST')
         ${strategyFilter}
       ORDER BY created_at ASC`,
      params
    );

    // ✅ NOVO: Sempre retornar evolução POR TRADE para melhor visualização (Requisito "Todas as trades")
    const dataPoints: { time: number, value: number }[] = [];
    let cumulativeProfit = 0;

    // Calcular lucro acumulado ANTES do periodo para este agente/filtro
    // Se quisermos o balanço TOTAL (Capital), somamos o initialBalance.
    // Mas se o objetivo for a PERFORMANCE do periodo (conforme mockup com 0 no eixo),
    // vamos iniciar em 0 no início do range ou no lucro acumulado relativo.

    // Para bater com o mockup (eixo 0, -40, -80), o gráfico deve ser o lucro RELATIVO do período.
    const prevParams = [userId, startDate.toISOString()];
    if (strategyFilter && agent) prevParams.push(agent);

    const prevTrades = await this.dataSource.query(
      `SELECT SUM(profit_loss) as total
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at < ?
         AND status IN ('WON', 'LOST')
         ${strategyFilter}`,
      prevParams
    );

    const prevProfit = parseFloat(prevTrades[0]?.total) || 0;

    // Decisão: Iniciar o gráfico em 0 no startDate para mostrar a "Performance do Período Selecionado"
    // Ou iniciar em prevProfit se quisermos a "Performance Acumulada de Todo o Tempo".
    // Como o mockup mostra valores negativos e 0 no centro, a performance RELATIVA é mais provável.
    // Para permitir que o usuário veja o lucro ACUMULADO de hj, começamos em 0.
    const startingValue = 0;

    if (aggregateBy === 'day') {
      // Agrupar por dia (fuso horário local -03:00)
      const dayMap = new Map<string, number>();

      for (const trade of trades) {
        const date = new Date(trade.created_at);
        // Ajustar para fuso -03:00 para agrupar corretamente conforme o dia do usuário
        const localDate = new Date(date.getTime() - (3 * 60 * 60 * 1000));
        const dateKey = localDate.toISOString().split('T')[0];

        const profit = parseFloat(trade.profit_loss) || 0;
        dayMap.set(dateKey, (dayMap.get(dateKey) || 0) + profit);
      }

      // Converter map para pontos do gráfico com lucros INDIVIDUAIS por dia
      const dailyPoints: { time: number, value: number }[] = [];
      const sortedKeys = Array.from(dayMap.keys()).sort();

      // Adicionar ponto inicial em 0 para estética do gráfico de linha
      dailyPoints.push({
        time: startDate.getTime() / 1000,
        value: Number(startingValue.toFixed(2))
      });

      for (const key of sortedKeys) {
        const d = new Date(key + 'T12:00:00'); // Meio do dia para evitar problemas de fuso
        const dailyProfit = dayMap.get(key)!;
        dailyPoints.push({
          time: d.getTime() / 1000,
          value: Number(dailyProfit.toFixed(2))
        });
      }

      return dailyPoints;
    }

    dataPoints.push({
      time: startDate.getTime() / 1000,
      value: Number(startingValue.toFixed(2))
    });

    cumulativeProfit = startingValue;

    for (const trade of trades) {
      cumulativeProfit += parseFloat(trade.profit_loss) || 0;
      dataPoints.push({
        time: new Date(trade.created_at).getTime() / 1000,
        value: Number(cumulativeProfit.toFixed(2))
      });
    }

    // Adicionar ponto final (agora) para manter a linha até o presente
    if (dataPoints.length > 0) {
      dataPoints.push({
        time: Date.now() / 1000,
        value: Number(cumulativeProfit.toFixed(2))
      });
    }

    return dataPoints;
  }

  async getSessionEvolution(userId: string): Promise<any[]> {
    const config = await this.getAgentConfig(userId);
    if (!config || !config.session_date) {
      return [];
    }

    const sessionDate = new Date(config.session_date);
    const now = new Date();
    const diffMs = now.getTime() - sessionDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = diffHours / 24;

    // Determinar lógica de agrupamento baseada na duração da sessão
    let daysForLogic = 1;
    let aggregateBy: 'trade' | 'day' = 'trade';

    if (diffDays <= 1) {
      daysForLogic = 1;
      aggregateBy = 'trade'; // Para sessões curtas, mostrar trade a trade
    } else if (diffDays <= 7) {
      daysForLogic = 7;
      aggregateBy = 'trade';
    } else {
      daysForLogic = Math.ceil(diffDays);
      aggregateBy = 'day'; // Para sessões muito longas, agrupar por dia
    }

    // Reutilizar lógica de buckets com o número de dias calculado
    return this.getProfitEvolution(userId, daysForLogic, 'all', undefined, undefined, aggregateBy);
  }

  /**
   * Obtém trades detalhados de um dia específico
   */

  async getDailyTrades(userId: string, date: string, agent?: string, startDate?: string, endDate?: string, limit: number = 20000, sessionId?: string): Promise<any> {
    try {
      // Buscar config para obter DATA DA SESSÃO
      const config = await this.getAgentConfig(userId);
      // const sessionDate = config?.session_date ? new Date(config.session_date) : null; // Unused now

      // Validar formato da data YYYY-MM-DD
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

      let targetDateStr = date;
      let startRange = '';
      let endRange = '';
      let isRange = false;

      if (startDate && endDate) {
        isRange = true;
        startRange = startDate;
        endRange = endDate;
        // Ensure full timestamps if only dates provided
        if (startRange.length === 10) startRange += 'T00:00:00.000Z';
        if (endRange.length === 10) endRange += 'T23:59:59.999Z';
      } else {
        if (date === 'today' || !dateRegex.test(date)) {
          targetDateStr = new Date().toISOString().split('T')[0];
        }
      }

      // Filter logic
      const strategyFilter = agent && agent !== 'all' ? 'AND strategy = ?' : '';
      let params: any[] = [userId];

      let dateCondition = '';
      if (isRange) {
        // Adjust ISO strings to MySQL format (YYYY-MM-DD HH:MM:SS)
        startRange = startRange.replace('T', ' ').replace('Z', '').split('.')[0];
        endRange = endRange.replace('T', ' ').replace('Z', '').split('.')[0];
        dateCondition = `AND created_at BETWEEN ? AND ?`;
        params.push(startRange, endRange);
      } else {
        dateCondition = `AND DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) = ?`;
        params.push(targetDateStr);
      }

      if (strategyFilter && agent) params.push(agent);

      // ✅ [SESSION FIX] Filtro por session_id apenas quando explicitamente pedido (período 'sessão')
      // Outros períodos (hoje, 7d, 30d) continuam filtrando só por data, sem filtro de sessão
      const sessionFilter = sessionId ? 'AND session_id = ?' : '';
      if (sessionId) params.push(sessionId);

      // Add limit to params
      params.push(limit);

      let query = `
         SELECT 
           id,
           created_at,
           symbol,
           contract_type,
           stake_amount as stake,
           profit_loss,
           status,
           entry_price,
           exit_price,
           strategy,
           session_id
         FROM autonomous_agent_trades 
         WHERE user_id = ? 
           ${dateCondition}
           AND status IN ('WON', 'LOST')
           ${strategyFilter}
           ${sessionFilter}
         ORDER BY created_at DESC
         LIMIT ?
      `;

      // REMOVIDO: Filtro de sessão para HOJE
      // O usuário relatou sumiço de operações.
      // O correto é mostrar TUDO do dia selecionado, a "Sessão" é apenas um conceito de controle de risco.
      // Se ele pausou e iniciou 3 sessões hoje, quer ver todas no relatório de hoje.
      /*
      if (isToday && sessionDate) {
        // query += ` AND created_at >= ?`;
        // params.push(sessionDate.toISOString());
      }
      */

      // query += ` ORDER BY created_at DESC`; // Already in query above

      // Params for summary: remove limit, but keep sessionId if present
      let summaryParams = params.slice(0, params.length - 1); // Remove limit
      // If sessionId was added AFTER strategy filter, we need to recalculate
      // summaryParams correctly: userId + dateParams + (agent?) + (sessionId?)
      // Rebuild summaryParams without limit
      const summaryParamsBase: any[] = [userId];
      if (isRange) {
        summaryParamsBase.push(startRange, endRange);
      } else {
        summaryParamsBase.push(targetDateStr);
      }
      if (strategyFilter && agent) summaryParamsBase.push(agent);
      if (sessionId) summaryParamsBase.push(sessionId);

      const summaryQuery = `
      SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as totalWins,
        SUM(profit_loss) as totalProfit
      FROM autonomous_agent_trades 
      WHERE user_id = ? 
        ${dateCondition}
        AND status IN ('WON', 'LOST')
        ${strategyFilter}
        ${sessionFilter}
    `;

      const [trades, summaryData] = await Promise.all([
        this.dataSource.query(query, params),
        this.dataSource.query(summaryQuery, summaryParamsBase)
      ]);

      const summary = {
        totalTrades: parseInt(summaryData[0]?.totalTrades) || 0,
        totalWins: parseInt(summaryData[0]?.totalWins) || 0,
        totalProfit: parseFloat(summaryData[0]?.totalProfit) || 0,
        winRate: (parseInt(summaryData[0]?.totalTrades) || 0) > 0
          ? (parseInt(summaryData[0]?.totalWins) || 0) / (parseInt(summaryData[0]?.totalTrades) || 0) * 100
          : 0
      };

      const formattedTrades = trades.map((t: any) => ({
        id: t.id,
        session_id: t.session_id || null, // Mantém compatibilidade mas busca do campo se existir futuramente
        time: new Date(t.created_at).toLocaleTimeString('pt-BR', { hour12: false }),
        createdAt: t.created_at ? new Date(t.created_at).toISOString() : new Date().toISOString(),
        market: t.symbol,
        contract: t.contract_type,
        stake: parseFloat(t.stake) || 0,
        profit: parseFloat(t.profit_loss) || 0,
        result: (parseFloat(t.profit_loss) >= 0 ? '+' : '') + parseFloat(t.profit_loss).toFixed(2),
        entry: t.entry_price,
        exit: t.exit_price,
        status: t.status,
        strategy: t.strategy
      }));

      return {
        trades: formattedTrades,
        summary
      };
    } catch (error) {
      Logger.error(`[GetDailyTrades] Error fetching trades for user ${userId}:`, error);
      return { trades: [], summary: { totalTrades: 0, totalWins: 0, totalProfit: 0, winRate: 0 } };
    }
  }

  /**
   * Cria índices para otimizar queries de estatísticas
   * Índices são mais leves que views e não causam locks
   */


  /**
   * Obtém estatísticas gerais de todas as IAs com filtro de data
   * Retorna dados agregados para as 5 IAs ativas: Orion, Apollo, Nexus, Titan, Atlas
   * OTIMIZADO: Usa view pre-agregada para performance
   */
  async getGeneralStats(startDate?: string, endDate?: string): Promise<any> {
    try {
      this.logger.log(`[GetGeneralStats] Buscando estatísticas gerais (startDate: ${startDate}, endDate: ${endDate})`);

      // Definir estratégias disponíveis (IAs usam 'strategy' field em ai_user_config)
      const strategies = ['orion', 'apollo', 'nexus', 'titan', 'atlas'];


      // Construir filtro de data
      let dateFilter = '';
      const params: any[] = [];

      if (startDate && endDate) {
        dateFilter = ` AND DATE(t.created_at) BETWEEN ? AND ?`;
        params.push(startDate, endDate);
      } else if (startDate) {
        dateFilter = ` AND DATE(t.created_at) >= ?`;
        params.push(startDate);
      } else if (endDate) {
        dateFilter = ` AND DATE(t.created_at) <= ?`;
        params.push(endDate);
      }

      // Agora que ai_trades tem coluna 'strategy', podemos buscar diretamente!
      // Cada trade está marcado com a estratégia que o gerou

      const statsQuery = `
        SELECT 
          strategy,
          COUNT(DISTINCT user_id) as totalUsers,
          COUNT(id) as totalTrades,
          SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN status = 'WON' THEN profit_loss ELSE 0 END) as totalProfit,
          SUM(CASE WHEN status = 'LOST' THEN profit_loss ELSE 0 END) as totalLoss,
          SUM(profit_loss) as netProfit
        FROM ai_trades
        WHERE strategy IN (?, ?, ?, ?, ?)
          AND status IN ('WON', 'LOST')
          ${dateFilter.replace(/t\./g, '')}
        GROUP BY strategy
      `;

      this.logger.log(`[GetGeneralStats] 🔍 Executando query de stats...`);
      const stats = await this.dataSource.query(statsQuery, [...strategies, ...params]);
      this.logger.log(`[GetGeneralStats] 📊 Stats: ${JSON.stringify(stats)}`);


      // Processar resultados e preencher estratégias sem dados
      const strategyStats = strategies.map(strategy => {
        const stat = stats.find((s: any) => s.strategy === strategy);

        if (stat) {
          const totalTrades = parseInt(stat.totalTrades) || 0;
          const wins = parseInt(stat.wins) || 0;
          const losses = parseInt(stat.losses) || 0;
          const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : '0.00';
          const netProfit = parseFloat(stat.netProfit) || 0;

          return {
            name: this.getStrategyDisplayName(strategy),
            strategy: strategy,
            status: 'active',
            totalUsers: parseInt(stat.totalUsers) || 0,
            totalTrades: totalTrades,
            wins: wins,
            losses: losses,
            profit: netProfit,
            winRate: parseFloat(winRate),
            profitReached: 0,
            lossReached: 0,
            activeStop: 0,
            riskMode: 'N/A',
            tradeMode: 'N/A',
          };
        } else {
          // Estratégia sem dados
          return {
            name: this.getStrategyDisplayName(strategy),
            strategy: strategy,
            status: 'active',
            totalUsers: 0,
            totalTrades: 0,
            wins: 0,
            losses: 0,
            profit: 0,
            winRate: 0,
            profitReached: 0,
            lossReached: 0,
            activeStop: 0,
            riskMode: 'N/A',
            tradeMode: 'N/A',
          };
        }
      });

      // ✅ ZENIX v2.0: Calcular Modo e Risco mais usados (Consulta em ai_user_config)
      try {
        // Obter contagem de modos por estratégia
        const modeStats = await this.dataSource.query(`
          SELECT strategy, mode, COUNT(*) as count 
          FROM ai_user_config 
          WHERE strategy IN (?, ?, ?, ?, ?)
            AND mode IS NOT NULL
          GROUP BY strategy, mode
        `, strategies);

        // Obter contagem de riscos por estratégia (tentando risk_profile ou modoMartingale)
        // Nota: O nome da coluna pode variar, ajustando conforme padrão encontrado
        // Vamos tentar 'risk_profile' que é o padrão do Zenix v2.0
        const riskStats = await this.dataSource.query(`
          SELECT strategy, risk_profile as risk, COUNT(*) as count 
          FROM ai_user_config 
          WHERE strategy IN (?, ?, ?, ?, ?)
            AND risk_profile IS NOT NULL
          GROUP BY strategy, risk_profile
        `, strategies).catch(async () => {
          // Fallback: tentar 'modo_martingale' se 'risk_profile' falhar
          return await this.dataSource.query(`
            SELECT strategy, modo_martingale as risk, COUNT(*) as count 
            FROM ai_user_config 
            WHERE strategy IN (?, ?, ?, ?, ?)
              AND modo_martingale IS NOT NULL
            GROUP BY strategy, modo_martingale
          `, strategies).catch(() => []); // Retornar vazio se falhar ambos
        });

        // Atualizar strategyStats com os dados encontrados
        strategyStats.forEach(stat => {
          // 1. Encontrar modo mais usado
          const modesForStrategy = modeStats.filter((m: any) => m.strategy === stat.strategy);
          if (modesForStrategy.length > 0) {
            // Ordenar por count decrescente
            modesForStrategy.sort((a: any, b: any) => parseInt(b.count) - parseInt(a.count));
            stat.tradeMode = modesForStrategy[0].mode ? modesForStrategy[0].mode.toUpperCase() : 'N/A';
          }

          // 2. Encontrar risco mais usado
          const risksForStrategy = riskStats.filter((r: any) => r.strategy === stat.strategy);
          if (risksForStrategy.length > 0) {
            // Ordenar por count decrescente
            risksForStrategy.sort((a: any, b: any) => parseInt(b.count) - parseInt(a.count));
            stat.riskMode = risksForStrategy[0].risk ? risksForStrategy[0].risk.toUpperCase() : 'N/A';
          }
        });

      } catch (error) {
        this.logger.warn(`[GetGeneralStats] ⚠️ Não foi possível calcular estatísticas de Modo/Risco: ${error.message}`);
        // Não falhar a request inteira, apenas deixar como N/A
      }


      // Calcular totais
      const totalActiveIAs = 5; // ✅ Sempre 5 IAs ativas
      const combinedProfit = strategyStats.reduce((sum, s) => sum + s.profit, 0);
      const totalTrades = strategyStats.reduce((sum, s) => sum + s.totalTrades, 0);
      const totalWins = strategyStats.reduce((sum, s) => sum + s.wins, 0);
      const globalAccuracy = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(2) : '0.00';

      // Identificar IA com maior lucro
      const topPerformer = strategyStats.reduce((top, current) => {
        return current.profit > top.profit ? current : top;
      }, strategyStats[0]);

      this.logger.log(`[GetGeneralStats] Resumo: ${totalActiveIAs} IAs, ${totalTrades} trades, lucro combinado: ${combinedProfit}`);

      return {
        strategies: strategyStats,
        summary: {
          totalActiveIAs: totalActiveIAs,
          combinedProfit: parseFloat(combinedProfit.toFixed(2)),
          globalAccuracy: parseFloat(globalAccuracy),
          topPerformer: {
            name: topPerformer.name,
            profit: parseFloat(topPerformer.profit.toFixed(2)),
          },
        },
      };
    } catch (error) {
      this.logger.error('[GetGeneralStats] Erro ao buscar estatísticas gerais:', error);
      throw error;
    }
  }

  /**
   * Retorna nome de exibição da estratégia
   */
  private getStrategyDisplayName(strategy: string): string {
    const names: { [key: string]: string } = {
      orion: 'IA Orion',
      apollo: 'IA Apollo',
      nexus: 'IA Nexus',
      titan: 'IA Titan',
      atlas: 'IA Atlas',
      falcon: 'IA Falcon', // Mantido para compatibilidade
    };
    return names[strategy] || strategy.toUpperCase();
  }

  /**
   * Normaliza o perfil de risco para o padrão esperado pelas estratégias (Caps)
   */
  private normalizeRiskProfile(risk: string): string {
    if (!risk) return 'MODERADO';

    const r = risk.toLowerCase();
    if (r === 'fixed' || r === 'fixo') return 'FIXO';
    if (r === 'conservative' || r === 'conservador') return 'CONSERVADOR';
    if (r === 'balanced' || r === 'moderado' || r === 'moderada') return 'MODERADO';
    if (r === 'aggressive' || r === 'agressivo' || r === 'agressiva') return 'AGRESSIVO';

    return risk.toUpperCase();
  }

}
