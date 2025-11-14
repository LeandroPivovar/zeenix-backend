import { Injectable, Logger } from '@nestjs/common';
import * as WebSocket from 'ws';

export interface Tick {
  value: number;
  epoch: number;
  timestamp: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private ws: WebSocket | null = null;
  private ticks: Tick[] = [];
  private maxTicks = 10;
  private appId: string;
  private symbol = 'R_100';
  private isConnected = false;
  private subscriptionId: string | null = null;

  constructor() {
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
      this.ws = new WebSocket(endpoint);

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

    // Manter apenas os últimos 10 ticks
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
}

