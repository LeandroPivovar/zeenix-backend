import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface Tick {
  value: number;
  epoch: number;
  timestamp: string;
}

export interface GeminiSignal {
  signal: 'CALL' | 'PUT';
  duration: number; // em segundos (máximo 120)
  reasoning: string;
  confidence: number; // 0-100
}

export interface TradeResult {
  id: number;
  status: string;
  entryPrice: number;
  currentPrice?: number;
  profitLoss?: number;
  timeRemaining?: number;
  stakeAmount?: number;
  signal?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private ws: WebSocket.WebSocket | null = null;
  private ticks: Tick[] = [];
  private maxTicks = 20; // Aumentado para 20 para análise
  private appId: string;
  private symbol = 'R_100';
  private isConnected = false;
  private subscriptionId: string | null = null;
  private activeTradeId: number | null = null;
  private isTrading = false;
  
  // WebSocket para monitorar contrato ativo
  private contractWs: WebSocket.WebSocket | null = null;
  private contractSubscriptionId: string | null = null;
  private activeContractId: string | null = null;
  private realTimeProfit: number | null = null;
  private realTimeCurrentPrice: number | null = null;

  constructor(@InjectDataSource() private dataSource: DataSource) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize() {
    if (this.isConnected) {
      this.logger.log('Já está conectado ao Deriv API');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.logger.log('Inicializando conexão com Deriv API...');

      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.ws = new WebSocket.WebSocket(endpoint);

      this.ws.on('open', () => {
        this.logger.log('✅ Conexão WebSocket estabelecida');
        this.isConnected = true;
        this.subscribeToTicks();
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
        this.ws = null;
      });

      // Timeout de 10 segundos
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Timeout ao conectar com Deriv API'));
        }
      }, 10000);
    });
  }

  private subscribeToTicks() {
    this.logger.log(`Inscrevendo-se nos ticks de ${this.symbol}...`);
    this.send({
      ticks_history: this.symbol,
      adjust_start_time: 1,
      count: this.maxTicks,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    });
  }

  private handleMessage(msg: any) {
    if (msg.error) {
      this.logger.error('Erro da API:', msg.error.message);
      return;
    }

    switch (msg.msg_type) {
      case 'history':
        this.processHistory(msg.history, msg.subscription?.id);
        break;

      case 'tick':
        this.processTick(msg.tick);
        break;
    }
  }

  private processHistory(history: any, subscriptionId?: string) {
    if (!history || !history.prices) {
      return;
    }

    if (subscriptionId) {
      this.subscriptionId = subscriptionId;
    }

    this.logger.log('Histórico recebido');

    this.ticks = history.prices.map((price: string, index: number) => ({
      value: parseFloat(price),
      epoch: history.times ? history.times[index] : Date.now() / 1000,
      timestamp: history.times
        ? new Date(history.times[index] * 1000).toLocaleTimeString('pt-BR')
        : new Date().toLocaleTimeString('pt-BR'),
    }));

    this.logger.log(`${this.ticks.length} ticks carregados`);
  }

  private processTick(tick: any) {
    if (!tick || !tick.quote) {
      return;
    }

    const newTick: Tick = {
      value: parseFloat(tick.quote),
      epoch: tick.epoch || Date.now() / 1000,
      timestamp: new Date(
        (tick.epoch || Date.now() / 1000) * 1000,
      ).toLocaleTimeString('pt-BR'),
    };

    this.ticks.push(newTick);

    // Manter apenas os últimos 20 ticks
    if (this.ticks.length > this.maxTicks) {
      this.ticks.shift();
    }

    this.logger.debug(`Novo tick: ${newTick.value}`);
  }

  getTicks(): Tick[] {
    return this.ticks;
  }

  getCurrentPrice(): number | null {
    if (this.ticks.length === 0) {
      return null;
    }
    return this.ticks[this.ticks.length - 1].value;
  }

  getStatistics() {
    if (this.ticks.length === 0) {
      return null;
    }

    const values = this.ticks.map((t) => t.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const current = values[values.length - 1];
    const first = values[0];
    const change = ((current - first) / first) * 100;

    return {
      min,
      max,
      avg,
      current,
      change,
    };
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      ticksCount: this.ticks.length,
      symbol: this.symbol,
      subscriptionId: this.subscriptionId,
    };
  }

  private send(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  disconnect() {
    this.logger.log('Desconectando...');
    if (this.ws) {
      this.ws.close();
    }
    this.isConnected = false;
    this.ticks = [];
  }

  // Métodos para IA de Trading

  async analyzeWithGemini(userId: number): Promise<GeminiSignal> {
    if (this.ticks.length < 20) {
      throw new Error('Não há dados suficientes para análise (mínimo 20 ticks)');
    }

    const prices = this.ticks.map(t => t.value);
    
    this.logger.log(`Enviando ${prices.length} preços para análise do Gemini`);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY não está configurada no arquivo .env');
    }

    // Retry logic: tentar até 3 vezes em caso de erro 503
    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        const prompt = `Você é um especialista em análise técnica de mercado financeiro. Analise os últimos 20 preços do Volatility 100 Index e forneça um sinal de trading.

Últimos 20 preços (do mais antigo ao mais recente):
${prices.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Preço atual: ${prices[prices.length - 1]}

Com base nesta sequência de preços, você deve:
1. Identificar se a tendência é de alta (CALL) ou baixa (PUT)
2. Recomendar uma duração de contrato entre 30 e 120 segundos
3. Fornecer um raciocínio breve (máximo 2 linhas)
4. Indicar o nível de confiança (0-100)

Responda APENAS no seguinte formato JSON (sem markdown, sem explicações extras):
{
  "signal": "CALL" ou "PUT",
  "duration": número entre 30 e 120,
  "reasoning": "explicação breve",
  "confidence": número entre 0 e 100
}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        this.logger.log(`Resposta do Gemini (tentativa ${attempt}): ${text}`);

        // Tentar fazer parse da resposta
        let parsedResponse;
        try {
          // Remover possíveis markdown code blocks
          const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          parsedResponse = JSON.parse(cleanText);
        } catch (e) {
          this.logger.error('Erro ao fazer parse da resposta do Gemini:', e);
          throw new Error('Resposta do Gemini em formato inválido');
        }

        // Validar resposta
        if (!parsedResponse.signal || !['CALL', 'PUT'].includes(parsedResponse.signal)) {
          throw new Error('Sinal inválido do Gemini');
        }

        if (!parsedResponse.duration || parsedResponse.duration < 30 || parsedResponse.duration > 120) {
          this.logger.warn(`Duração inválida: ${parsedResponse.duration}, ajustando para 60s`);
          parsedResponse.duration = 60;
        }

        // Sucesso! Retornar resultado
        return {
          signal: parsedResponse.signal,
          duration: parsedResponse.duration,
          reasoning: parsedResponse.reasoning || 'Análise técnica',
          confidence: parsedResponse.confidence || 70,
        };

      } catch (error: any) {
        lastError = error;
        
        // Se for erro 503 (overloaded) e ainda tiver tentativas, aguardar e tentar novamente
        if (error.status === 503 && attempt < maxRetries) {
          const waitTime = attempt * 2000; // 2s, 4s
          this.logger.warn(`Gemini sobrecarregado (503). Tentativa ${attempt}/${maxRetries}. Aguardando ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        // Se não for 503 ou não tiver mais tentativas, lançar erro
        this.logger.error(`Erro ao analisar com Gemini (tentativa ${attempt}/${maxRetries}):`, error);
        break;
      }
    }

    // Se chegou aqui, todas as tentativas falharam
    throw lastError;
  }

  async executeTrade(
    userId: number,
    signal: GeminiSignal,
    stakeAmount: number,
    derivToken: string,
    currency: string = 'USD',
  ): Promise<number> {
    if (this.isTrading) {
      throw new Error('Já existe uma operação em andamento');
    }

    const currentPrice = this.getCurrentPrice();
    if (!currentPrice) {
      throw new Error('Preço atual não disponível');
    }

    this.logger.log(`Executando trade com moeda: ${currency}`);

    // Salvar trade inicial no banco
    const query = `
      INSERT INTO ai_trades (
        user_id, analysis_data, gemini_signal, gemini_duration, 
        gemini_reasoning, entry_price, stake_amount, contract_type, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      userId,
      JSON.stringify(this.ticks),
      signal.signal,
      signal.duration,
      signal.reasoning,
      currentPrice,
      stakeAmount,
      signal.signal === 'CALL' ? 'CALL' : 'PUT',
      'PENDING',
    ];

    const result = await this.dataSource.query(query, values);
    const tradeId = result.insertId;

    this.activeTradeId = tradeId;
    this.isTrading = true;

    this.logger.log(`Trade criado com ID: ${tradeId}`);

    // Executar trade real na Deriv
    try {
      await this.executeBuyOnDeriv(tradeId, signal, stakeAmount, derivToken, currency);
    } catch (error) {
      this.logger.error('Erro ao executar trade na Deriv:', error);
      
      // Marcar trade como erro no banco
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error.message, tradeId]
      );
      
      this.isTrading = false;
      this.activeTradeId = null;
      throw error;
    }

    return tradeId;
  }

  /**
   * Executa a compra do contrato na Deriv API
   * Baseado no método do OperationChart.vue
   */
  private async executeBuyOnDeriv(
    tradeId: number,
    signal: GeminiSignal,
    stakeAmount: number,
    derivToken: string,
    currency: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.log('Conectando à Deriv para executar trade...');
      
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const buyWs = new WebSocket(endpoint);
      
      let proposalId: string | null = null;
      let proposalPrice: number | null = null;
      let isCompleted = false;
      
      // Timeout de segurança (60 segundos)
      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          this.logger.error('Timeout ao executar trade na Deriv');
          buyWs.close();
          reject(new Error('Timeout ao executar trade'));
        }
      }, 60000);

      buyWs.on('open', () => {
        this.logger.log('WebSocket conectado, autorizando...');
        buyWs.send(JSON.stringify({ authorize: derivToken }));
      });

      buyWs.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.error) {
            if (!isCompleted) {
              isCompleted = true;
              clearTimeout(timeout);
              this.logger.error('Erro da Deriv:', msg.error);
              buyWs.close();
              reject(new Error(msg.error.message || 'Erro ao executar trade'));
            }
            return;
          }

              // 1. Após autorização, fazer proposal
              if (msg.msg_type === 'authorize') {
                this.logger.log('Autorizado, enviando proposal...');
                
                const proposalPayload = {
                  proposal: 1,
                  amount: stakeAmount,
                  basis: 'stake',
                  contract_type: signal.signal,
                  currency: currency, // Usar moeda passada (USD, BTC, etc)
                  duration: signal.duration,
                  duration_unit: 's', // segundos
                  symbol: this.symbol,
                };
                
                this.logger.log('Proposal payload:', proposalPayload);
                buyWs.send(JSON.stringify(proposalPayload));
              }

          // 2. Receber proposal e fazer buy
          if (msg.msg_type === 'proposal') {
            const proposal = msg.proposal;
            if (!proposal || !proposal.id) {
              if (!isCompleted) {
                isCompleted = true;
                clearTimeout(timeout);
                buyWs.close();
                reject(new Error('Proposta inválida da Deriv'));
              }
              return;
            }

            proposalId = proposal.id;
            proposalPrice = Number(proposal.ask_price);
            const payout = Number(proposal.payout || 0);
            
            this.logger.log('Proposal recebido:', {
              id: proposalId,
              price: proposalPrice,
              payout: payout
            });

            // Atualizar payout no banco
            await this.dataSource.query(
              'UPDATE ai_trades SET payout = ? WHERE id = ?',
              [payout - stakeAmount, tradeId] // payout é o retorno líquido
            );

            // Fazer buy
            const buyPayload = {
              buy: proposalId,
              price: proposalPrice,
            };
            
            this.logger.log('Executando buy...', buyPayload);
            buyWs.send(JSON.stringify(buyPayload));
          }

          // 3. Receber confirmação de buy e subscrever ao contrato
          if (msg.msg_type === 'buy') {
            const buy = msg.buy;
            if (!buy || !buy.contract_id) {
              if (!isCompleted) {
                isCompleted = true;
                clearTimeout(timeout);
                buyWs.close();
                reject(new Error('Compra não confirmada pela Deriv'));
              }
              return;
            }

            const contractId = buy.contract_id;
            const buyPrice = Number(buy.buy_price);
            const entrySpot = Number(buy.entry_spot || this.getCurrentPrice());
            
            this.logger.log('Compra confirmada!', {
              contractId,
              buyPrice,
              entrySpot
            });

            // Atualizar trade no banco
            await this.dataSource.query(
              `UPDATE ai_trades 
               SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
               WHERE id = ?`,
              [contractId, entrySpot, tradeId]
            );

            // Fechar este WebSocket e abrir um novo para monitorar o contrato
            buyWs.close();
            clearTimeout(timeout);

            // Subscrever ao contrato para monitoramento
            await this.subscribeToContract(contractId, derivToken);
            
            if (!isCompleted) {
              isCompleted = true;
              resolve();
            }
          }
        } catch (error) {
          if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeout);
            this.logger.error('Erro ao processar mensagem:', error);
            buyWs.close();
            reject(error);
          }
        }
      });

      buyWs.on('error', (error) => {
        if (!isCompleted) {
          isCompleted = true;
          clearTimeout(timeout);
          this.logger.error('Erro no WebSocket:', error);
          reject(error);
        }
      });

      buyWs.on('close', () => {
        if (!isCompleted) {
          isCompleted = true;
          clearTimeout(timeout);
          reject(new Error('WebSocket fechado inesperadamente'));
        }
      });
    });
  }

  // Método finalizeTrade removido - agora a finalização é feita automaticamente
  // pelo WebSocket quando recebe is_sold === 1 (ver handleContractFinalized)

  /**
   * Conecta ao WebSocket da Deriv para monitorar um contrato em tempo real
   * Similar ao que é feito no OperationChart.vue
   */
  private async subscribeToContract(contractId: string, derivToken: string): Promise<void> {
    this.logger.log(`Conectando ao WebSocket para monitorar contrato: ${contractId}`);
    
    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    
    this.contractWs = new WebSocket(endpoint);
    this.activeContractId = contractId;
    this.realTimeProfit = null;
    this.realTimeCurrentPrice = null;

    this.contractWs.on('open', () => {
      this.logger.log('WebSocket do contrato conectado, autorizando...');
      
      // Autorizar com o token do usuário
      this.contractWs.send(JSON.stringify({ authorize: derivToken }));
    });

    this.contractWs.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.processContractMessage(msg);
      } catch (error) {
        this.logger.error('Erro ao processar mensagem do contrato:', error);
      }
    });

    this.contractWs.on('error', (error) => {
      this.logger.error('Erro no WebSocket do contrato:', error);
    });

    this.contractWs.on('close', () => {
      this.logger.log('WebSocket do contrato fechado');
      this.contractWs = null;
      this.contractSubscriptionId = null;
    });
  }

  /**
   * Processa mensagens do WebSocket do contrato
   */
  private processContractMessage(msg: any): void {
    // Log apenas para mensagens importantes
    if (msg.msg_type === 'authorize' || msg.msg_type === 'proposal_open_contract') {
      this.logger.debug(`Mensagem do contrato: ${msg.msg_type}`);
    }

    if (msg.error) {
      this.logger.error('Erro no WebSocket do contrato:', msg.error);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        // Após autorização, subscrever ao contrato
        if (this.activeContractId) {
          this.logger.log(`Autorizado, subscrevendo ao contrato ${this.activeContractId}`);
          this.contractWs.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: this.activeContractId,
            subscribe: 1
          }));
        }
        break;

      case 'proposal_open_contract':
        // Armazenar ID da subscription
        if (msg.subscription?.id) {
          this.contractSubscriptionId = msg.subscription.id;
        }

        const contract = msg.proposal_open_contract;
        if (contract) {
          // Atualizar profit em tempo real (mesmo método do OperationChart.vue)
          if (contract.profit !== undefined && contract.profit !== null) {
            this.realTimeProfit = Number(contract.profit);
            this.logger.debug(`Profit atualizado: ${this.realTimeProfit}`);
          }

          // Atualizar preço atual
          if (contract.current_spot !== undefined && contract.current_spot !== null) {
            this.realTimeCurrentPrice = Number(contract.current_spot);
          }

          // Se o contrato foi vendido/expirou, finalizar
          if (contract.is_sold === 1) {
            this.logger.log('Contrato finalizado pela Deriv');
            this.handleContractFinalized(contract);
          }
        }
        break;
    }
  }

  /**
   * Trata a finalização de um contrato pela Deriv
   */
  private async handleContractFinalized(contract: any): Promise<void> {
    if (!this.activeTradeId) {
      return;
    }

    const finalProfit = contract.profit !== undefined ? Number(contract.profit) : 0;
    const exitPrice = contract.exit_spot || contract.current_spot || this.getCurrentPrice();
    const status = finalProfit >= 0 ? 'WON' : 'LOST';

    this.logger.log(`Contrato finalizado - Status: ${status}, Profit: ${finalProfit}`);

    // Atualizar no banco
    const updateQuery = `
      UPDATE ai_trades 
      SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
      WHERE id = ?
    `;

    await this.dataSource.query(updateQuery, [exitPrice, finalProfit, status, this.activeTradeId]);

    // Limpar estado
    this.disconnectFromContract();
    this.isTrading = false;
    this.activeTradeId = null;
  }

  /**
   * Desconecta do WebSocket do contrato
   */
  private disconnectFromContract(): void {
    if (this.contractSubscriptionId && this.contractWs) {
      try {
        this.contractWs.send(JSON.stringify({ forget: this.contractSubscriptionId }));
      } catch (error) {
        this.logger.warn('Erro ao desinscrever do contrato:', error);
      }
    }

    if (this.contractWs) {
      try {
        this.contractWs.close();
      } catch (error) {
        this.logger.warn('Erro ao fechar WebSocket do contrato:', error);
      }
      this.contractWs = null;
    }

    this.contractSubscriptionId = null;
    this.activeContractId = null;
    this.realTimeProfit = null;
    this.realTimeCurrentPrice = null;
  }

  async getActiveTrade(): Promise<TradeResult | null> {
    if (!this.activeTradeId) {
      return null;
    }

    const query = `
      SELECT id, status, entry_price, exit_price, profit_loss, 
             gemini_duration, gemini_signal, stake_amount, payout,
             started_at, created_at
      FROM ai_trades 
      WHERE id = ?
    `;

    const result = await this.dataSource.query(query, [this.activeTradeId]);
    
    if (result.length === 0) {
      return null;
    }

    const trade = result[0];
    
    // Calcular tempo restante
    const startTime = trade.started_at || trade.created_at;
    const elapsedSeconds = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);
    const timeRemaining = Math.max(0, trade.gemini_duration - elapsedSeconds);

    // Usar o profit real do WebSocket (mesmo método do OperationChart.vue)
    // Se já temos profit_loss no banco (trade finalizado), usar ele
    // Senão, usar o realTimeProfit do WebSocket
    let profitToReturn = 0;
    if (trade.profit_loss !== null && trade.profit_loss !== undefined) {
      profitToReturn = parseFloat(trade.profit_loss);
    } else if (this.realTimeProfit !== null) {
      profitToReturn = this.realTimeProfit;
    }

    return {
      id: trade.id,
      status: trade.status,
      entryPrice: parseFloat(trade.entry_price),
      currentPrice: this.realTimeCurrentPrice || this.getCurrentPrice() || undefined,
      profitLoss: profitToReturn,
      timeRemaining,
      stakeAmount: trade.stake_amount ? parseFloat(trade.stake_amount) : undefined,
      signal: trade.gemini_signal,
    };
  }

  getIsTrading(): boolean {
    return this.isTrading;
  }

  async getSessionStats(userId: number) {
    // Buscar todas as trades do usuário da sessão atual (hoje)
    const query = `
      SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(profit_loss, 0)) as totalProfitLoss
      FROM ai_trades
      WHERE user_id = ? 
        AND DATE(created_at) = CURDATE()
        AND status IN ('WON', 'LOST')
    `;

    const result = await this.dataSource.query(query, [userId]);
    const stats = result[0];

    return {
      totalTrades: parseInt(stats.totalTrades) || 0,
      wins: parseInt(stats.wins) || 0,
      losses: parseInt(stats.losses) || 0,
      profitLoss: parseFloat(stats.totalProfitLoss) || 0,
    };
  }

  async getTradeHistory(userId: number, limit: number = 20) {
    // Buscar histórico de trades do usuário (últimas 20 por padrão)
    const query = `
      SELECT 
        id,
        gemini_signal as \`signal\`,
        entry_price as entryPrice,
        exit_price as exitPrice,
        stake_amount as stakeAmount,
        profit_loss as profitLoss,
        gemini_duration as duration,
        gemini_reasoning as reasoning,
        status,
        created_at as createdAt,
        closed_at as closedAt
      FROM ai_trades
      WHERE user_id = ? 
        AND status IN ('WON', 'LOST')
      ORDER BY closed_at DESC
      LIMIT ?
    `;

    const result = await this.dataSource.query(query, [userId, limit]);

    return result.map((trade: any) => ({
      id: trade.id,
      signal: trade.signal,
      entryPrice: parseFloat(trade.entryPrice),
      exitPrice: parseFloat(trade.exitPrice),
      stakeAmount: parseFloat(trade.stakeAmount),
      profitLoss: parseFloat(trade.profitLoss),
      duration: trade.duration,
      reasoning: trade.reasoning,
      status: trade.status,
      createdAt: trade.createdAt,
      closedAt: trade.closedAt,
    }));
  }
}

