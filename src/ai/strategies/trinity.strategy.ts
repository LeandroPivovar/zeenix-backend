import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, ModoMartingale } from './common.types';
import { gerarSinalZenix } from './signal-generator';

// Estados TRINITY
export interface TrinityAssetState {
  symbol: 'R_10' | 'R_25' | 'R_50';
  ticks: Tick[];
  isOperationActive: boolean;
  martingaleStep: number;
  perdaAcumulada: number;
  apostaInicial: number;
  ticksDesdeUltimaOp: number;
  vitoriasConsecutivas: number;
  apostaBase: number;
  ultimoLucro: number;
  lastOperationTimestamp: Date | null;
}

export interface TrinityUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  modoMartingale: ModoMartingale;
  mode: string;
  assets: {
    R_10: TrinityAssetState;
    R_25: TrinityAssetState;
    R_50: TrinityAssetState;
  };
  currentAssetIndex: number;
  totalProfitLoss: number;
}

@Injectable()
export class TrinityStrategy implements IStrategy {
  name = 'trinity';
  private readonly logger = new Logger(TrinityStrategy.name);
  
  private trinityUsers = new Map<string, TrinityUserState>();
  private trinityTicks: {
    R_10: Tick[];
    R_25: Tick[];
    R_50: Tick[];
  } = {
    R_10: [],
    R_25: [],
    R_50: [],
  };
  
  private trinityWebSockets: {
    R_10: WebSocket | null;
    R_25: WebSocket | null;
    R_50: WebSocket | null;
  } = {
    R_10: null,
    R_25: null,
    R_50: null,
  };
  
  private trinityConnected: {
    R_10: boolean;
    R_25: boolean;
    R_50: boolean;
  } = {
    R_10: false,
    R_25: false,
    R_50: false,
  };
  
  private appId: string;
  private maxTicks = 2000;

  constructor(
    private dataSource: DataSource,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[TRINITY] Estratégia TRINITY inicializada');
    await this.initializeTrinityWebSockets();
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    if (!symbol || !['R_10', 'R_25', 'R_50'].includes(symbol)) {
      return;
    }

    const assetSymbol = symbol as 'R_10' | 'R_25' | 'R_50';
    this.trinityTicks[assetSymbol].push(tick);
    if (this.trinityTicks[assetSymbol].length > this.maxTicks) {
      this.trinityTicks[assetSymbol].shift();
    }

    // Processar estratégias TRINITY para este ativo
    if (this.trinityUsers.size > 0) {
      await this.processTrinityStrategies(assetSymbol, tick);
    }
  }

  async activateUser(userId: string, config: any): Promise<void> {
    const { mode, stakeAmount, derivToken, currency, modoMartingale } = config;
    this.upsertTrinityUserState({
      userId,
      stakeAmount,
      derivToken,
      currency,
      mode: mode || 'veloz',
      modoMartingale: modoMartingale || 'conservador',
    });
  }

  async deactivateUser(userId: string): Promise<void> {
    this.trinityUsers.delete(userId);
    this.logger.log(`[TRINITY] Usuário ${userId} desativado`);
  }

  getUserState(userId: string): TrinityUserState | null {
    return this.trinityUsers.get(userId) || null;
  }

  // Métodos privados
  private async initializeTrinityWebSockets(): Promise<void> {
    const symbols: Array<'R_10' | 'R_25' | 'R_50'> = ['R_10', 'R_25', 'R_50'];
    
    for (const symbol of symbols) {
      if (this.trinityConnected[symbol] && this.trinityWebSockets[symbol]?.readyState === WebSocket.OPEN) {
        continue;
      }
      await this.initializeTrinityWebSocket(symbol);
    }
  }

  private async initializeTrinityWebSocket(symbol: 'R_10' | 'R_25' | 'R_50'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);
      this.trinityWebSockets[symbol] = ws;

      ws.on('open', () => {
        this.logger.log(`[TRINITY][${symbol}] ✅ Conexão WebSocket aberta`);
        this.trinityConnected[symbol] = true;
        this.subscribeToTrinityTicks(symbol);
        resolve();
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleTrinityMessage(symbol, msg);
        } catch (error) {
          this.logger.error(`[TRINITY][${symbol}] Erro ao processar mensagem:`, error);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[TRINITY][${symbol}] Erro no WebSocket:`, error.message);
        this.trinityConnected[symbol] = false;
        reject(error);
      });

      ws.on('close', () => {
        this.logger.log(`[TRINITY][${symbol}] Conexão WebSocket fechada`);
        this.trinityConnected[symbol] = false;
        this.trinityWebSockets[symbol] = null;
      });

      setTimeout(() => {
        if (!this.trinityConnected[symbol]) {
          reject(new Error(`Timeout ao conectar ${symbol}`));
        }
      }, 10000);
    });
  }

  private subscribeToTrinityTicks(symbol: 'R_10' | 'R_25' | 'R_50'): void {
    const ws = this.trinityWebSockets[symbol];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: this.maxTicks,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    }));
  }

  private handleTrinityMessage(symbol: 'R_10' | 'R_25' | 'R_50', msg: any): void {
    if (msg.error) {
      this.logger.error(`[TRINITY][${symbol}] Erro da API:`, msg.error.message);
      return;
    }

    switch (msg.msg_type) {
      case 'history':
        if (msg.history?.prices) {
          this.processTrinityHistory(symbol, msg.history.prices);
        }
        break;
      case 'tick':
        if (msg.tick) {
          this.processTrinityTick(symbol, msg.tick);
        }
        break;
    }
  }

  private processTrinityHistory(symbol: 'R_10' | 'R_25' | 'R_50', prices: any[]): void {
    const ticks: Tick[] = prices
      .map((price: any) => {
        const value = Number(price.quote || price);
        if (!isFinite(value) || value <= 0) return null;
        const digit = this.extractLastDigit(value);
        const epoch = Number(price.epoch || price.time || Date.now() / 1000);
        if (!isFinite(epoch) || epoch <= 0) return null;
        return {
          value,
          epoch,
          timestamp: new Date(epoch * 1000).toLocaleTimeString('pt-BR'),
          digit,
          parity: this.getParityFromDigit(digit),
        };
      })
      .filter((t): t is Tick => t !== null);

    this.trinityTicks[symbol] = ticks;
    this.logger.log(`[TRINITY][${symbol}] ✅ Histórico carregado: ${ticks.length} ticks`);
  }

  private processTrinityTick(symbol: 'R_10' | 'R_25' | 'R_50', tickData: any): void {
    const rawQuote = tickData.quote;
    const rawEpoch = tickData.epoch;

    if (rawQuote == null || rawQuote === '' || rawEpoch == null || rawEpoch === '') {
      return;
    }

    const value = Number(rawQuote);
    const epoch = Number(rawEpoch);

    if (!isFinite(value) || value <= 0 || !isFinite(epoch) || epoch <= 0) {
      return;
    }

    const digit = this.extractLastDigit(value);
    const tick: Tick = {
      value,
      epoch,
      timestamp: new Date(epoch * 1000).toLocaleTimeString('pt-BR'),
      digit,
      parity: this.getParityFromDigit(digit),
    };

    this.trinityTicks[symbol].push(tick);
    if (this.trinityTicks[symbol].length > this.maxTicks) {
      this.trinityTicks[symbol].shift();
    }

    // Processar estratégias TRINITY
    if (this.trinityUsers.size > 0) {
      this.processTrinityStrategies(symbol, tick).catch((error) => {
        this.logger.error(`[TRINITY][${symbol}] Erro ao processar estratégias:`, error);
      });
    }
  }

  private async processTrinityStrategies(symbol: 'R_10' | 'R_25' | 'R_50', latestTick: Tick): Promise<void> {
    if (this.trinityUsers.size === 0) return;

    // Processar cada usuário TRINITY
    for (const [userId, state] of this.trinityUsers.entries()) {
      const asset = state.assets[symbol];
      
      // Incrementar contador de ticks
      if (asset.ticksDesdeUltimaOp !== undefined && asset.ticksDesdeUltimaOp >= 0) {
        asset.ticksDesdeUltimaOp += 1;
      }

      // Verificar se pode processar
      if (!this.canProcessTrinityAsset(state, symbol)) {
        continue;
      }

      // Obter configuração do modo
      const modeConfig = this.getModeConfig(state.mode);
      if (!modeConfig) continue;

      // Verificar amostra mínima
      if (this.trinityTicks[symbol].length < modeConfig.amostraInicial) {
        continue;
      }

      // Gerar sinal
      const sinal = gerarSinalZenix(this.trinityTicks[symbol], modeConfig, state.mode.toUpperCase());
      
      if (!sinal || !sinal.sinal) {
        continue;
      }
      
      this.logger.log(
        `[TRINITY][${symbol}] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`,
      );

      // TODO: Executar operação TRINITY
    }
  }

  private canProcessTrinityAsset(state: TrinityUserState, symbol: 'R_10' | 'R_25' | 'R_50'): boolean {
    const asset = state.assets[symbol];
    if (asset.isOperationActive) return false;

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return false;

    if (state.mode === 'veloz' && 'intervaloTicks' in modeConfig && asset.ticksDesdeUltimaOp < modeConfig.intervaloTicks!) {
      return false;
    }

    if (state.mode === 'moderado' && asset.lastOperationTimestamp) {
      const secondsSinceLastOp = (Date.now() - asset.lastOperationTimestamp.getTime()) / 1000;
      if (secondsSinceLastOp < (modeConfig.intervaloSegundos || 0)) {
        return false;
      }
    }

    return true;
  }

  private getModeConfig(mode: string): ModeConfig | null {
    const modeLower = (mode || 'veloz').toLowerCase();
    if (modeLower === 'veloz') return VELOZ_CONFIG;
    if (modeLower === 'moderado') return MODERADO_CONFIG;
    if (modeLower === 'preciso') return PRECISO_CONFIG;
    return null;
  }

  private upsertTrinityUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    mode: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const existing = this.trinityUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        mode: params.mode,
        modoMartingale: params.modoMartingale || 'conservador',
      });
      return;
    }

    // Criar novo estado
    const assets: TrinityUserState['assets'] = {
      R_10: {
        symbol: 'R_10',
        ticks: [],
        isOperationActive: false,
        martingaleStep: 0,
        perdaAcumulada: 0,
        apostaInicial: params.stakeAmount,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
        lastOperationTimestamp: null,
      },
      R_25: {
        symbol: 'R_25',
        ticks: [],
        isOperationActive: false,
        martingaleStep: 0,
        perdaAcumulada: 0,
        apostaInicial: params.stakeAmount,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
        lastOperationTimestamp: null,
      },
      R_50: {
        symbol: 'R_50',
        ticks: [],
        isOperationActive: false,
        martingaleStep: 0,
        perdaAcumulada: 0,
        apostaInicial: params.stakeAmount,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
        lastOperationTimestamp: null,
      },
    };

    this.trinityUsers.set(params.userId, {
      userId: params.userId,
      derivToken: params.derivToken,
      currency: params.currency,
      capital: params.stakeAmount,
      virtualCapital: params.stakeAmount,
      modoMartingale: params.modoMartingale || 'conservador',
      mode: params.mode,
      assets,
      currentAssetIndex: 0,
      totalProfitLoss: 0,
    });
  }

  private extractLastDigit(value: number): number {
    const numeric = Math.abs(value);
    const normalized = numeric.toString().replace('.', '').replace('-', '');
    const lastChar = normalized.charAt(normalized.length - 1);
    const digit = parseInt(lastChar, 10);
    return Number.isNaN(digit) ? 0 : digit;
  }

  private getParityFromDigit(digit: number): DigitParity {
    return digit % 2 === 0 ? 'PAR' : 'IMPAR';
  }

  // Getters para acesso externo
  getTicks(symbol: 'R_10' | 'R_25' | 'R_50'): Tick[] {
    return this.trinityTicks[symbol];
  }

  getUsers(): Map<string, TrinityUserState> {
    return this.trinityUsers;
  }
}

