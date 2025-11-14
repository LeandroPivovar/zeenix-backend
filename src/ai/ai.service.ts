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
  ): Promise<number> {
    if (this.isTrading) {
      throw new Error('Já existe uma operação em andamento');
    }

    const currentPrice = this.getCurrentPrice();
    if (!currentPrice) {
      throw new Error('Preço atual não disponível');
    }

    // Salvar trade no banco
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

    // Executar trade na Deriv (simular por enquanto)
    // TODO: Integrar com Deriv API para executar trade real
    setTimeout(async () => {
      await this.finalizeTrade(tradeId, derivToken);
    }, signal.duration * 1000);

    return tradeId;
  }

  private async finalizeTrade(tradeId: number, derivToken: string) {
    const exitPrice = this.getCurrentPrice();
    
    if (!exitPrice) {
      this.logger.error('Preço de saída não disponível');
      return;
    }

    // Buscar trade do banco
    const tradeQuery = 'SELECT * FROM ai_trades WHERE id = ?';
    const tradeResult = await this.dataSource.query(tradeQuery, [tradeId]);
    const trade = tradeResult[0];

    if (!trade) {
      this.logger.error(`Trade ${tradeId} não encontrado`);
      return;
    }

    // Calcular lucro/perda (simplificado)
    let profitLoss = 0;
    let status = 'LOST';

    if (trade.gemini_signal === 'CALL') {
      if (exitPrice > trade.entry_price) {
        profitLoss = trade.stake_amount * 0.85; // 85% de retorno
        status = 'WON';
      } else {
        profitLoss = -trade.stake_amount;
      }
    } else {
      if (exitPrice < trade.entry_price) {
        profitLoss = trade.stake_amount * 0.85;
        status = 'WON';
      } else {
        profitLoss = -trade.stake_amount;
      }
    }

    // Atualizar trade no banco
    const updateQuery = `
      UPDATE ai_trades 
      SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
      WHERE id = ?
    `;

    await this.dataSource.query(updateQuery, [exitPrice, profitLoss, status, tradeId]);

    this.logger.log(`Trade ${tradeId} finalizado: ${status}, P/L: ${profitLoss}`);

    this.isTrading = false;
    this.activeTradeId = null;
  }

  async getActiveTrade(): Promise<TradeResult | null> {
    if (!this.activeTradeId) {
      return null;
    }

    const query = `
      SELECT id, status, entry_price, exit_price, profit_loss, 
             gemini_duration, started_at, created_at
      FROM ai_trades 
      WHERE id = ?
    `;

    const result = await this.dataSource.query(query, [this.activeTradeId]);
    
    if (result.length === 0) {
      return null;
    }

    const trade = result[0];
    const currentPrice = this.getCurrentPrice();
    
    // Calcular tempo restante
    const startTime = trade.started_at || trade.created_at;
    const elapsedSeconds = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);
    const timeRemaining = Math.max(0, trade.gemini_duration - elapsedSeconds);

    return {
      id: trade.id,
      status: trade.status,
      entryPrice: parseFloat(trade.entry_price),
      currentPrice: currentPrice || undefined,
      profitLoss: trade.profit_loss ? parseFloat(trade.profit_loss) : undefined,
      timeRemaining,
    };
  }

  getIsTrading(): boolean {
    return this.isTrading;
  }
}

