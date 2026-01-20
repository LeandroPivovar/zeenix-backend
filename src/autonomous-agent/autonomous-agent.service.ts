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
  private symbol = 'R_100'; // Símbolo padrão para todos os agentes autônomos
  private activeSymbols = new Set<string>(['R_100']); // ✅ Todos os agentes autônomos usam R_100
  private subscriptions = new Map<string, string>(); // ✅ Mapeia símbolo -> subscriptionId
  private isConnected = false;
  private subscriptionId: string | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private lastTickReceivedTime: number = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(forwardRef(() => AutonomousAgentStrategyManagerService))
    private readonly strategyManager: AutonomousAgentStrategyManagerService,
    @Inject(forwardRef(() => LogQueueService))
    private readonly logQueueService?: LogQueueService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async onModuleInit() {
    this.logger.log('🚀 Inicializando AutonomousAgentService...');
    try {
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
  private subscribeToTicks(): void {
    // ✅ Todos os agentes autônomos usam R_100
    const symbol = 'R_100';
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
    this.logger.log(`✅ [AutonomousAgent] Requisição de inscrição enviada para ${symbol}`);
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
      this.logger.error('❌ Erro da API:', errorMsg);
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
          // ✅ Todos os agentes autônomos usam R_100
          const symbolForTick = 'R_100';

          if (msg.subscription?.id && this.subscriptionId !== msg.subscription.id) {
            this.subscriptionId = msg.subscription.id;
            this.logger.log(`📋 [AutonomousAgent] Subscription ID capturado: ${this.subscriptionId} (símbolo: ${symbolForTick})`);
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

    // ✅ Todos os agentes autônomos usam R_100
    const tickSymbol = symbol || 'R_100';
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
    this.strategyManager.processTick(newTick, tickSymbol).catch((error) => {
      this.logger.error(`[StrategyManager][${tickSymbol}] Erro ao processar tick:`, error);
    });
  }

  /**
   * ✅ NOVO: Método público para receber ticks externos (do AiService)
   * Permite que o AiService compartilhe ticks de R_100 com o AutonomousAgentService
   */
  public receiveExternalTick(tick: Tick, symbol: string = 'R_100'): void {
    if (symbol !== 'R_100') {
      return; // Apenas processar R_100
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
      const activeAgents = await this.dataSource.query(
        `SELECT user_id, agent_type, symbol
         FROM autonomous_agent_config 
         WHERE is_active = TRUE AND agent_type = 'orion'`,
      );

      this.logger.log(`[SyncActiveAgents] Sincronizados ${activeAgents.length} agentes ativos`);

      // Verificar se há agentes que precisam ser resetados (mudança de dia)
      await this.checkAndResetDailySessions();
    } catch (error) {
      this.logger.error('[SyncActiveAgents] Erro ao sincronizar agentes:', error);
    }
  }

  /**
   * Verifica e reseta sessões diárias se necessário
   * Se um agente parou no dia anterior (stop loss/win/blindado), reseta para o novo dia
   */
  async checkAndResetDailySessions(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split('T')[0];

      // Buscar agentes que pararam no dia anterior
      const agentsToReset = await this.dataSource.query(
        `SELECT user_id, session_status, session_date
         FROM autonomous_agent_config 
         WHERE is_active = TRUE 
           AND agent_type = 'orion'
           AND session_status IN ('stopped_profit', 'stopped_loss', 'stopped_blindado')
           AND (session_date IS NULL OR DATE(session_date) < ?)`,
        [todayStr],
      );

      for (const agent of agentsToReset) {
        this.logger.log(
          `[ResetDailySession] Resetando sessão diária para usuário ${agent.user_id} (status anterior: ${agent.session_status})`,
        );

        // Resetar sessão diária
        await this.dataSource.query(
          `UPDATE autonomous_agent_config 
           SET session_status = 'active',
               session_date = NOW(),
               daily_profit = 0,
               daily_loss = 0
           WHERE user_id = ? AND is_active = TRUE`,
          [agent.user_id],
        );

        // Reativar agente na estratégia Orion
        const config = await this.dataSource.query(
          `SELECT initial_stake, daily_profit_target, daily_loss_limit, 
                  deriv_token, currency, symbol, trading_mode, initial_balance
           FROM autonomous_agent_config 
           WHERE user_id = ? AND is_active = TRUE
           LIMIT 1`,
          [agent.user_id],
        );

        if (config && config.length > 0) {
          const agentConfig = config[0];
          const userId = agent.user_id.toString();
          await this.strategyManager.activateUser('orion', userId, {
            userId: userId,
            initialStake: parseFloat(agentConfig.initial_stake),
            dailyProfitTarget: parseFloat(agentConfig.daily_profit_target),
            dailyLossLimit: parseFloat(agentConfig.daily_loss_limit),
            derivToken: agentConfig.deriv_token,
            currency: agentConfig.currency,
            symbol: agentConfig.symbol || 'R_100',
            tradingMode: agentConfig.trading_mode || 'normal',
            initialBalance: parseFloat(agentConfig.initial_balance) || 0,
          });
        }
      }

      if (agentsToReset.length > 0) {
        this.logger.log(`[ResetDailySession] ✅ ${agentsToReset.length} sessões resetadas para o novo dia`);
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
      // ✅ PRIMEIRA AÇÃO: Deletar logs anteriores ao iniciar nova sessão
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
               currency = ?,
               symbol = ?,
               agent_type = ?,
               trading_mode = ?,
               initial_balance = ?,
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
            config.currency || 'USD',
            config.symbol || 'R_100', // ✅ Todos os agentes autônomos usam R_100
            normalizedAgentType,
            config.tradingMode || 'normal',
            config.initialBalance || 0,
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
            deriv_token, currency, symbol, agent_type, trading_mode, initial_balance,
            session_status, session_date, daily_profit, daily_loss, created_at, updated_at)
           VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), 0, 0, NOW(), NOW())`,
          [
            userId,
            config.initialStake,
            config.dailyProfitTarget,
            config.dailyLossLimit,
            config.derivToken,
            config.currency || 'USD',
            config.symbol || 'R_100', // ✅ Todos os agentes autônomos usam R_100
            normalizedAgentType,
            config.tradingMode || 'normal',
            config.initialBalance || 0,
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

      // ✅ Suportar Orion, Sentinel e Falcon
      if (strategy !== 'orion' && strategy !== 'sentinel' && strategy !== 'falcon') {
        this.logger.warn(`[ActivateAgent] Estratégia '${strategy}' solicitada, mas apenas 'orion', 'sentinel' e 'falcon' estão disponíveis. Usando 'orion'.`);
        strategy = 'orion';
      }

      // Verificar se strategyManager está disponível
      if (!this.strategyManager) {
        throw new Error('StrategyManager não está disponível. Verifique se o módulo foi inicializado corretamente.');
      }

      // ✅ Todos os agentes autônomos usam R_100
      const agentSymbol = config.symbol || 'R_100';

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
        await this.strategyManager.activateUser(strategy, userId, {
          userId: userId,
          initialStake: config.initialStake,
          dailyProfitTarget: config.dailyProfitTarget,
          dailyLossLimit: config.dailyLossLimit,
          derivToken: config.derivToken,
          currency: config.currency || 'USD',
          symbol: agentSymbol,
          tradingMode: config.tradingMode || 'normal',
          initialBalance: config.initialBalance || 0,
        });
        this.logger.log(`[ActivateAgent] ✅ Usuário ${userId} ativado na estratégia ${strategy}`);
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
    const config = await this.dataSource.query(
      `SELECT session_date 
       FROM autonomous_agent_config 
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );

    // ✅ Se não houver configuração ou session_date, retornar vazio
    if (!config || config.length === 0 || !config[0].session_date) {
      return [];
    }

    const sessionDate = config[0].session_date;

    // ✅ Filtrar apenas operações criadas após o início da sessão atual
    return await this.dataSource.query(
      `SELECT * FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at >= ?
       ORDER BY COALESCE(closed_at, created_at) DESC 
       LIMIT ?`,
      [userId, sessionDate, limit],
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

    // ✅ Se não houver session_date, retornar valores zerados
    if (!sessionDate) {
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

    // ✅ Filtrar apenas operações criadas após o início da sessão atual
    const sessionTrades = await this.dataSource.query(
      `SELECT 
         status,
         profit_loss,
         created_at,
         closed_at
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND status IN ('WON', 'LOST')
         AND profit_loss IS NOT NULL
         AND created_at >= ?
       ORDER BY COALESCE(closed_at, created_at) DESC`,
      [userId, sessionDate],
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

  async getLogs(userId: string, limit?: number): Promise<any[]> {
    const limitClause = limit ? `LIMIT ${limit}` : '';

    // ✅ Usar cache para session_date (evita query desnecessária a cada 2 segundos)
    let sessionStartTime: Date | string | null = null;
    const cached = this.sessionDateCache.get(userId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      // Usar cache se ainda válido (menos de 30 segundos)
      sessionStartTime = cached.date;
    } else {
      // Buscar session_date apenas se cache expirou ou não existe
      const config = await this.dataSource.query(
        `SELECT session_date FROM autonomous_agent_config 
         WHERE user_id = ? AND is_active = TRUE
         LIMIT 1`,
        [userId],
      );

      if (config && config.length > 0 && config[0].session_date) {
        sessionStartTime = config[0].session_date;
        // Atualizar cache
        this.sessionDateCache.set(userId, {
          date: sessionStartTime,
          timestamp: now,
        });
      } else {
        // Cachear null também para evitar queries repetidas
        this.sessionDateCache.set(userId, {
          date: null,
          timestamp: now,
        });
      }
    }

    // ✅ Filtrar logs apenas da sessão atual (se houver session_date)
    const whereClause = sessionStartTime
      ? `WHERE user_id = ? AND timestamp >= ?`
      : `WHERE user_id = ?`;
    const params = sessionStartTime
      ? [userId, sessionStartTime]
      : [userId];

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
  async getDailyStats(userId: string, days: number = 30): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    // Buscar config para obter DATA DA SESSÃO e filtrar
    const config = await this.getAgentConfig(userId);
    const sessionDate = config?.session_date ? new Date(config.session_date) : null;

    // Se tiver sessao ativa, não mostrar dados anteriores a ela
    let effectiveStartDate = startDate;
    if (sessionDate && sessionDate > startDate) {
      effectiveStartDate = sessionDate;
    }

    const trades = await this.dataSource.query(
      `SELECT 
         DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) as date,
         SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) as profit,
         SUM(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE 0 END) as loss,
         COUNT(*) as ops,
         SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at >= ?
         AND status IN ('WON', 'LOST')
       GROUP BY DATE(CONVERT_TZ(created_at, '+00:00', '-03:00'))
       ORDER BY date DESC`,
      [userId, effectiveStartDate.toISOString()]
    );

    const dailyData = trades.map((day: any) => {
      const profit = parseFloat(day.profit) || 0;
      const loss = parseFloat(day.loss) || 0;
      const netProfit = profit - loss;
      const ops = parseInt(day.ops) || 0;
      const wins = parseInt(day.wins) || 0;
      const winRate = ops > 0 ? (wins / ops) * 100 : 0;

      return {
        date: new Date(day.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        fullDate: new Date(day.date).toISOString().split('T')[0], // YYYY-MM-DD for querying
        profit: Number(netProfit.toFixed(2)),
        ops,
        winRate: Number(winRate.toFixed(2)),
        // Assuming capital is not tracked historically daily here, would need separate tracking or estimation
        // For now, returning structure compatible with frontend
        capital: 0,
        avgTime: '24min', // Placeholder
        badge: ''
      };
    });

    return dailyData;
  }

  async getWeeklyStats(userId: string, weeks: number = 10): Promise<any[]> {
    // Buscar config para obter DATA DA SESSÃO e Saldo Inicial
    const config = await this.getAgentConfig(userId);
    const sessionDate = config?.session_date ? new Date(config.session_date) : null;
    const initialBalance = parseFloat(config?.initial_balance) || 0;

    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - (weeks * 7)); // Look back X weeks

    // Se tiver sessao ativa, não mostrar dados anteriores a ela
    let effectiveStartDate = startDate;
    if (sessionDate && sessionDate > startDate) {
      effectiveStartDate = sessionDate;
    }

    // Query grouping by Year-Week
    // Note: SQL syntax for week depends on DB. Assuming compatible/standard function or using DATE formatting.
    // For universal support, we might fetch all trades and aggregate in JS, but let's try SQL grouping first.
    // SQLite: strftime('%Y-%W', created_at)
    // MySQL: DATE_FORMAT(created_at, '%Y-%u')
    // We will use JS aggregation for safety across DB types if we want to be safe, 
    // but the existing code uses Date(created_at), implying standard SQL or simple mapping.
    // Let's fetch daily stats and aggregate weekly in JS to be safe and accurate with calendar weeks.

    // Fetch trades for the period
    const trades = await this.dataSource.query(
      `SELECT 
            created_at,
            profit_loss,
            status
         FROM autonomous_agent_trades 
         WHERE user_id = ? 
           AND created_at >= ?
           AND status IN ('WON', 'LOST')
         ORDER BY created_at ASC`,
      [userId, effectiveStartDate.toISOString()]
    );

    // Group by Week (Sunday-Saturday or similar)
    const weeklyMap = new Map<string, {
      start: Date,
      end: Date,
      profit: number,
      wins: number,
      ops: number
    }>();

    for (const trade of trades) {
      const date = new Date(trade.created_at);
      // Get start of week (Sunday)
      const day = date.getDay(); // 0 is Sunday
      const diff = date.getDate() - day; // adjust when day is sunday
      const startOfWeek = new Date(date);
      startOfWeek.setDate(diff);
      startOfWeek.setHours(0, 0, 0, 0);

      const key = startOfWeek.toISOString().split('T')[0];

      if (!weeklyMap.has(key)) {
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        weeklyMap.set(key, {
          start: startOfWeek,
          end: endOfWeek,
          profit: 0,
          wins: 0,
          ops: 0
        });
      }

      const stats = weeklyMap.get(key)!;
      const profit = parseFloat(trade.profit_loss) || 0;
      stats.profit += profit;
      stats.ops += 1;
      if (trade.status === 'WON') stats.wins += 1;
    }

    // Convert to array and calculate cumulative capital
    const weeksList = Array.from(weeklyMap.values()).sort((a, b) => a.start.getTime() - b.start.getTime());

    let currentCapital = initialBalance;
    const result: any[] = [];

    for (const week of weeksList) {
      // Formataçao da data: DD/MM - DD/MM
      const startStr = week.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      const endStr = week.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      const period = `${startStr} - ${endStr}`;

      // Atualiza capital
      currentCapital += week.profit;

      // Percentual de lucro da semana sobre o capital inicial da sessão? 
      // Ou sobre o capital no inicio da semana? Usually over initial balance or current capital.
      // The UI shows % likely relative to initial balance or weekly ROI. 
      // Let's assume ROI relative to initial balance for consistency with other metrics, 
      // OR relative to the capital at start of week. 
      // Let's use relative to initialBalance as it's a "total growth" typically, or simply Week Profit / Start Week Capital.
      // Given the example showed +3% etc, it looks like weekly yield. 
      // Let's calculate: (Profit / (CurrentCapital - Profit)) * 100
      const startWeekCapital = currentCapital - week.profit;
      const percent = startWeekCapital > 0 ? (week.profit / startWeekCapital) * 100 : 0;

      const winRate = week.ops > 0 ? (week.wins / week.ops) * 100 : 0;

      result.push({
        period,
        profit: Number(week.profit.toFixed(2)),
        finalCapital: Number(currentCapital.toFixed(2)),
        percent: Number(percent.toFixed(2)),
        ops: week.ops,
        winRate: Number(winRate.toFixed(1))
      });
    }

    // Sort descending (newest first) for UI
    return result.reverse();
  }

  async getProfitEvolution(userId: string, days: number = 30): Promise<any[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset time to start of today for consistent filtering
    const startDate = new Date(today);

    // Adjust start date based on days parameter
    if (days <= 1) {
      // days=1 treated as "Today" (since midnight)
      startDate.setTime(today.getTime());
    } else {
      startDate.setDate(today.getDate() - days);
    }

    // ✅ Filtro de sessão: Se houver sessão ativa, filtrar a partir da data da sessão
    const config = await this.getAgentConfig(userId);
    const sessionDate = config?.session_date ? new Date(config.session_date) : null;

    if (sessionDate && sessionDate > startDate) {
      startDate.setTime(sessionDate.getTime());
    }

    // Select trades in the period
    const trades = await this.dataSource.query(
      `SELECT 
         created_at,
         profit_loss
       FROM autonomous_agent_trades 
       WHERE user_id = ? 
         AND created_at >= ?
         AND status IN ('WON', 'LOST')
       ORDER BY created_at ASC`,
      [userId, startDate.toISOString()]
    );

    // Map trades to their bucket timestamps
    const tradesMap = new Map<number, number>(); // timestamp (ms) -> profit sum

    for (const trade of trades) {
      const tradeDate = new Date(trade.created_at);
      let bucketTime: number;

      if (days <= 1) {
        // 1 day: Hourly (1h)
        tradeDate.setMinutes(0, 0, 0);
        bucketTime = tradeDate.getTime();
      } else if (days <= 2) {
        // 2 days: Every 6 hours (0, 6, 12, 18)
        const hour = tradeDate.getHours();
        const block = Math.floor(hour / 6) * 6;
        tradeDate.setHours(block, 0, 0, 0);
        bucketTime = tradeDate.getTime();
      } else if (days <= 3) {
        // 3 days: Every 12 hours (0, 12)
        const hour = tradeDate.getHours();
        const block = Math.floor(hour / 12) * 12;
        tradeDate.setHours(block, 0, 0, 0);
        bucketTime = tradeDate.getTime();
      } else {
        // 4+ days: Daily (24h) - Use YYYY-MM-DD (normalized to midnight)
        tradeDate.setHours(0, 0, 0, 0);
        bucketTime = tradeDate.getTime();
      }

      const profit = parseFloat(trade.profit_loss) || 0;
      const current = tradesMap.get(bucketTime) || 0;
      tradesMap.set(bucketTime, current + profit);
    }

    // Generate continuous sequence of buckets
    const dataPoints: { time: string | number, value: number }[] = [];
    let cumulativeProfit = 0;

    // Determine interval in ms
    let intervalMs: number;
    if (days <= 1) intervalMs = 60 * 60 * 1000; // 1 hour
    else if (days <= 2) intervalMs = 6 * 60 * 60 * 1000; // 6 hours
    else if (days <= 3) intervalMs = 12 * 60 * 60 * 1000; // 12 hours
    else intervalMs = 24 * 60 * 60 * 1000; // 24 hours

    // Generate buckets from startDate to Now (or end of today for wider ranges)
    const endTime = Date.now();
    let currentBucketTime = startDate.getTime();

    // Round start bucket down to match interval alignment if needed
    // (startDate is already normalized to midnight or session start, but session start might be mid-interval)
    // For simplicity, we just iterate from startDate. If startDate is 10:15 and interval is 1h, next is 11:15?
    // User requested "divisions", explicitly "00:00, 01:00".
    // So we should align currentBucketTime to the grid.

    if (days <= 1) {
      const d = new Date(currentBucketTime);
      d.setMinutes(0, 0, 0);
      currentBucketTime = d.getTime();
    } else if (days <= 2) {
      const d = new Date(currentBucketTime);
      const h = d.getHours();
      const block = Math.floor(h / 6) * 6;
      d.setHours(block, 0, 0, 0);
      currentBucketTime = d.getTime();
    } // ... and so on. But startDate logic already does some of this? 
    // Actually, startDate is midnight (unless sessionDate overrides).
    // If sessionDate overrides, we probably want to start exactly there or align back?
    // Let's assume aligning to the grid is safer for the "chart divisions".

    while (currentBucketTime <= endTime) {
      // Add profit from this bucket if any
      if (tradesMap.has(currentBucketTime)) {
        cumulativeProfit += tradesMap.get(currentBucketTime)!;
      }

      // Determine output time format
      let timeValue: string | number;
      if (days < 4) {
        // Sub-daily: Unix timestamp (seconds)
        timeValue = currentBucketTime / 1000;
      } else {
        // Daily: YYYY-MM-DD string
        timeValue = new Date(currentBucketTime).toISOString().split('T')[0];
      }

      dataPoints.push({
        time: timeValue,
        value: Number(cumulativeProfit.toFixed(2))
      });

      currentBucketTime += intervalMs;
    }

    return dataPoints;
  }

  /**
   * Obtém trades detalhados de um dia específico
   */

  async getDailyTrades(userId: string, date: string): Promise<any[]> {
    try {
      // Buscar config para obter DATA DA SESSÃO
      const config = await this.getAgentConfig(userId);
      const sessionDate = config?.session_date ? new Date(config.session_date) : null;

      // Validar formato da data YYYY-MM-DD
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

      let targetDateStr = date;

      if (date === 'today' || !dateRegex.test(date)) {
        targetDateStr = new Date().toISOString().split('T')[0];
      }

      // Se a data solicitada for HOJE, filtra pela SESSÃO ATUAL (se existir)
      const todayStr = new Date().toISOString().split('T')[0];
      const isToday = targetDateStr === todayStr;

      // Definir início e fim do dia para compatibilidade com qualquer DB (SQLite, Postgres, etc)
      // Assumindo UTC strings
      const startOfDayStr = `${targetDateStr}T00:00:00.000Z`;
      const endOfDayStr = `${targetDateStr}T23:59:59.999Z`;

      let query = `
         SELECT 
           created_at,
           symbol,
           contract_type,
           stake_amount as stake,
           profit_loss,
           status,
           entry_price,
           exit_price
         FROM autonomous_agent_trades 
         WHERE user_id = ? 
           AND DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) = ?
           AND status IN ('WON', 'LOST')
      `;

      const params: any[] = [userId, targetDateStr];

      // Adicionar filtro de sessão se for HOJE e tiver sessionDate
      /* NOVO: Comentado para análise. O usuário pediu "APENAS operações dentro da sessão atual"
         Se filtrarmos aqui, a tabela mostrará apenas a sessão.
         Mas o "Relatório Diário" implica dia todo.
         Se a sessão começou ontem, "Sessão Atual" pode incluir ontem?
         Session Date é timestamp.
         
         Vou assumir que o usuário quer ver TUDO do DIA, mas limitar estatísticas à sessão?
         Ou ver apenas SESSÃO no relatório?
         O prompt diz: "mostre aqui APENAS operações dentro da sessão atual"
         Vou aplicar o filtro de sessão se for hoje.
      */
      if (isToday && sessionDate) {
        query += ` AND created_at >= ?`;
        params.push(sessionDate.toISOString());
      }

      query += ` ORDER BY created_at DESC`;

      const trades = await this.dataSource.query(query, params);

      return trades.map((t: any) => ({
        time: new Date(t.created_at).toLocaleTimeString('pt-BR', { hour12: false }),
        market: t.symbol,
        contract: t.contract_type,
        stake: parseFloat(t.stake) || 0,
        profit: parseFloat(t.profit_loss) || 0,
        result: (parseFloat(t.profit_loss) >= 0 ? '+' : '') + parseFloat(t.profit_loss).toFixed(2),
        entry: t.entry_price,
        exit: t.exit_price,
        status: t.status
      }));
    } catch (error) {
      Logger.error(`[GetDailyTrades] Error returning empty:`, error);
      return [];
    }
  }

  /**
   * Obtém estatísticas gerais de todas as IAs com filtro de data
   * Retorna dados agregados para as 5 IAs ativas: Orion, Apollo, Nexus, Titan, Falcon
   */
  async getGeneralStats(startDate?: string, endDate?: string): Promise<any> {
    try {
      this.logger.log(`[GetGeneralStats] Buscando estatísticas gerais (startDate: ${startDate}, endDate: ${endDate})`);

      // Definir estratégias disponíveis (IAs usam 'strategy' field em ai_user_config)
      const strategies = ['orion', 'apollo', 'nexus', 'titan', 'atlas'];

      // Construir filtro de data para subquery
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

      // Buscar estatísticas agregadas por estratégia
      // CORRIGIDO: Usar ai_user_config e ai_trades (tabelas das IAs)
      const statsQuery = `
        SELECT 
          c.strategy as strategy,
          COUNT(DISTINCT c.user_id) as totalUsers,
          COALESCE(COUNT(t.id), 0) as totalTrades,
          COALESCE(SUM(CASE WHEN t.status = 'WON' THEN 1 ELSE 0 END), 0) as wins,
          COALESCE(SUM(CASE WHEN t.status = 'LOST' THEN 1 ELSE 0 END), 0) as losses,
          COALESCE(SUM(CASE WHEN t.status = 'WON' THEN t.profit_loss ELSE 0 END), 0) as totalProfit,
          COALESCE(SUM(CASE WHEN t.status = 'LOST' THEN t.profit_loss ELSE 0 END), 0) as totalLoss,
          COALESCE(SUM(t.profit_loss), 0) as netProfit
        FROM ai_user_config c
        LEFT JOIN ai_trades t ON c.user_id = t.user_id 
          AND t.status IN ('WON', 'LOST')
          ${dateFilter}
        WHERE c.strategy IN (?, ?, ?, ?, ?)
        GROUP BY c.strategy
      `;

      const stats = await this.dataSource.query(statsQuery, [...strategies, ...params]);

      this.logger.log(`[GetGeneralStats] Resultados da query: ${JSON.stringify(stats)}`);

      // Processar resultados e preencher estratégias sem dados
      const strategyStats = strategies.map(strategy => {
        const found = stats.find((s: any) => s.strategy === strategy);

        // Se encontrou dados na query, usar esses dados
        if (found) {
          const totalTrades = parseInt(found.totalTrades) || 0;
          const wins = parseInt(found.wins) || 0;
          const losses = parseInt(found.losses) || 0;
          const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : '0.00';

          return {
            name: this.getStrategyDisplayName(strategy),
            strategy: strategy,
            status: 'active', // ✅ Sempre ativa
            totalUsers: parseInt(found.totalUsers) || 0,
            totalTrades: totalTrades,
            wins: wins,
            losses: losses,
            profit: parseFloat(found.netProfit) || 0,
            winRate: parseFloat(winRate),
            profitReached: 0,
            lossReached: 0,
            activeStop: 0,
            riskMode: 'N/A',
            tradeMode: 'N/A',
          };
        } else {
          // Se não encontrou na query, retornar com zeros mas status ativo
          return {
            name: this.getStrategyDisplayName(strategy),
            strategy: strategy,
            status: 'active', // ✅ Sempre ativa mesmo sem dados
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

}
