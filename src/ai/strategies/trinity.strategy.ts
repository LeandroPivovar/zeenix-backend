import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, ModoMartingale } from './common.types';
import { gerarSinalZenix } from './signal-generator';

// ✅ Função para calcular próxima aposta de martingale
function calcularProximaAposta(
  perdasTotais: number,
  modo: ModoMartingale,
  payoutCliente: number = 95,
  ultimaAposta: number = 0, // Para modo agressivo
): number {
  let metaRecuperacao = 0;
  
  switch (modo) {
    case 'conservador':
      // Meta: recuperar 100% das perdas (break-even)
      metaRecuperacao = perdasTotais;
      break;
    case 'moderado':
      // Meta: recuperar 100% das perdas (break-even) - conforme documentação
      metaRecuperacao = perdasTotais;
      break;
    case 'agressivo':
      // Meta: recuperar perdas + gerar lucro do tamanho da última aposta
      metaRecuperacao = perdasTotais + ultimaAposta;
      break;
  }
  
  // Fórmula: entrada_próxima = meta_de_recuperação × 100 / payout_cliente
  const aposta = (metaRecuperacao * 100) / payoutCliente;
  
  return Math.max(0.35, Math.round(aposta * 100) / 100); // Mínimo 0.35 (limite Deriv)
}

// Estados TRINITY
export interface TrinityAssetState {
  symbol: 'R_10' | 'R_25' | 'R_50';
  ticks: Tick[];
  isOperationActive: boolean;
  martingaleStep: number;
  perdaAcumulada: number;
  apostaInicial: number;
  ultimaApostaUsada: number; // ✅ Última aposta usada (para cálculo agressivo)
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
  capitalInicial: number; // ✅ Capital inicial para cálculo de stop-loss
  modoMartingale: ModoMartingale;
  mode: string;
  assets: {
    R_10: TrinityAssetState;
    R_25: TrinityAssetState;
    R_50: TrinityAssetState;
  };
  currentAssetIndex: number;
  totalProfitLoss: number;
  stopLoss?: number; // ✅ Stop-loss global (negativo, ex: -100)
  stopLossBlindado?: boolean; // ✅ Se stop-loss blindado está ativo
  profitTarget?: number; // ✅ Meta diária (positivo, ex: 200)
  isStopped: boolean; // ✅ Se sistema foi parado (meta/stop atingido)
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
    const { mode, stakeAmount, derivToken, currency, modoMartingale, profitTarget, lossLimit } = config;
    this.upsertTrinityUserState({
      userId,
      stakeAmount,
      derivToken,
      currency,
      mode: mode || 'veloz',
      modoMartingale: modoMartingale || 'conservador',
      profitTarget: profitTarget || null,
      lossLimit: lossLimit || null,
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
      // ✅ Verificar se sistema foi parado
      if (state.isStopped) {
        continue;
      }

      // ✅ ROTAÇÃO SEQUENCIAL: Obter próximo ativo na rotação
      const nextAsset = this.getNextAssetInRotation(state);
      
      // ✅ Se o tick recebido não é do próximo ativo na rotação, pular
      if (nextAsset !== symbol) {
        // Ainda assim, incrementar contador do ativo atual
        const asset = state.assets[symbol];
        if (asset.ticksDesdeUltimaOp !== undefined && asset.ticksDesdeUltimaOp >= 0) {
          asset.ticksDesdeUltimaOp += 1;
        }
        continue;
      }

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
        // ✅ Sem sinal válido: avançar para próximo ativo na rotação
        this.advanceToNextAsset(state);
        continue;
      }
      
      this.logger.log(
        `[TRINITY][${symbol}] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}% | ${sinal.motivo}`,
      );

      // ✅ Executar operação TRINITY
      await this.executeTrinityOperation(state, symbol, sinal.sinal);
    }
  }

  /**
   * ✅ TRINITY: Obtém próximo ativo na rotação com prioridade de martingale
   */
  private getNextAssetInRotation(state: TrinityUserState): 'R_10' | 'R_25' | 'R_50' {
    const assetsInOrder = ['R_10', 'R_25', 'R_50'] as const;
    
    // ✅ Prioridade 1: Se algum ativo está em martingale, priorizar ele
    const assetInMartingale = assetsInOrder.find(
      s => state.assets[s].martingaleStep > 0 && !state.assets[s].isOperationActive
    );
    if (assetInMartingale) {
      return assetInMartingale;
    }
    
    // ✅ Prioridade 2: Rotação round-robin normal
    return assetsInOrder[state.currentAssetIndex];
  }

  /**
   * ✅ TRINITY: Avança para próximo ativo na rotação
   */
  private advanceToNextAsset(state: TrinityUserState): void {
    state.currentAssetIndex = (state.currentAssetIndex + 1) % 3;
  }

  private canProcessTrinityAsset(state: TrinityUserState, symbol: 'R_10' | 'R_25' | 'R_50'): boolean {
    const asset = state.assets[symbol];
    
    // Não pode processar se já há operação ativa neste ativo
    if (asset.isOperationActive) return false;

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return false;

    // Verificar intervalo de ticks (modo veloz)
    if (state.mode === 'veloz' && 'intervaloTicks' in modeConfig && modeConfig.intervaloTicks) {
      if (asset.ticksDesdeUltimaOp < modeConfig.intervaloTicks) {
        return false;
      }
    }

    // Verificar intervalo de tempo (modo moderado)
    if (state.mode === 'moderado' && asset.lastOperationTimestamp) {
      const secondsSinceLastOp = (Date.now() - asset.lastOperationTimestamp.getTime()) / 1000;
      if ('intervaloSegundos' in modeConfig && modeConfig.intervaloSegundos && secondsSinceLastOp < modeConfig.intervaloSegundos) {
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
    profitTarget?: number | null;
    lossLimit?: number | null;
  }): void {
    const existing = this.trinityUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        capitalInicial: existing.capitalInicial || params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        mode: params.mode,
        modoMartingale: params.modoMartingale || 'conservador',
        profitTarget: params.profitTarget || null,
        stopLoss: params.lossLimit || null,
        isStopped: false,
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
        ultimaApostaUsada: params.stakeAmount,
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
        ultimaApostaUsada: params.stakeAmount,
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
        ultimaApostaUsada: params.stakeAmount,
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
      capitalInicial: params.stakeAmount,
      modoMartingale: params.modoMartingale || 'conservador',
      mode: params.mode,
      assets,
      currentAssetIndex: 0,
      totalProfitLoss: 0,
      stopLoss: params.lossLimit || undefined,
      stopLossBlindado: false,
      profitTarget: params.profitTarget || undefined,
      isStopped: false,
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

  /**
   * ✅ TRINITY: Executa operação completa
   */
  private async executeTrinityOperation(
    state: TrinityUserState,
    symbol: 'R_10' | 'R_25' | 'R_50',
    operation: DigitParity,
  ): Promise<void> {
    const asset = state.assets[symbol];
    
    // Marcar como operação ativa
    asset.isOperationActive = true;
    
    // Resetar contador de ticks
    asset.ticksDesdeUltimaOp = 0;
    
    // Calcular stake (considerar martingale isolado do ativo)
    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) {
      asset.isOperationActive = false;
      return;
    }

    let stakeAmount = asset.apostaInicial;
    
    // ✅ Se está em martingale, usar aposta de recuperação
    if (asset.martingaleStep > 0) {
      stakeAmount = calcularProximaAposta(
        asset.perdaAcumulada,
        state.modoMartingale,
        modeConfig.payout * 100, // Converter para percentual
        state.modoMartingale === 'agressivo' ? asset.ultimaApostaUsada : 0,
      );
      
      // ✅ Verificar stop-loss antes de apostar
      const stopLossDisponivel = this.calculateAvailableStopLoss(state);
      if (stakeAmount > stopLossDisponivel && stopLossDisponivel > 0) {
        // Reduzir aposta para não ultrapassar stop-loss
        stakeAmount = Math.max(asset.apostaInicial, stopLossDisponivel);
        this.logger.warn(
          `[TRINITY][${symbol}] ⚠️ Aposta reduzida para respeitar stop-loss: $${stakeAmount.toFixed(2)}`,
        );
      }
    }

    const contractType = operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
    
    // Salvar aposta usada para cálculo agressivo
    asset.ultimaApostaUsada = stakeAmount;
    
    this.logger.log(
      `[TRINITY][${symbol}] 🎲 EXECUTANDO | User: ${state.userId} | ` +
      `Operação: ${operation} | Stake: $${stakeAmount.toFixed(2)} | ` +
      `Martingale: ${asset.martingaleStep > 0 ? `Nível ${asset.martingaleStep}` : 'Não'}`,
    );

    try {
      // ✅ Executar trade via WebSocket
      const contractId = await this.executeTrinityTradeViaWebSocket(
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

      if (!contractId) {
        asset.isOperationActive = false;
        return;
      }

      // ✅ Monitorar contrato e processar resultado
      await this.monitorTrinityContract(contractId, state, symbol, stakeAmount, operation);
      
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] Erro ao executar operação:`, error);
      asset.isOperationActive = false;
    }
  }

  /**
   * ✅ TRINITY: Executa trade via WebSocket
   */
  private async executeTrinityTradeViaWebSocket(
    token: string,
    contractParams: any,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      let proposalId: string | null = null;
      let proposalSubscriptionId: string | null = null;
      
      const timeout = setTimeout(() => {
        if (proposalSubscriptionId) {
          try {
            ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
          } catch (e) {
            // Ignore
          }
        }
        ws.close();
        resolve(null);
      }, 30000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: token }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.authorize) {
            if (msg.authorize.error) {
              clearTimeout(timeout);
              ws.close();
              resolve(null);
              return;
            }
            
            const proposalPayload = {
              proposal: 1,
              amount: contractParams.amount,
              basis: 'stake',
              contract_type: contractParams.contract_type,
              currency: contractParams.currency || 'USD',
              duration: contractParams.duration || 1,
              duration_unit: contractParams.duration_unit || 't',
              symbol: contractParams.symbol,
              subscribe: 1,
            };
            
            ws.send(JSON.stringify(proposalPayload));
            return;
          }

          if (msg.proposal) {
            if (msg.proposal.error) {
              clearTimeout(timeout);
              ws.close();
              resolve(null);
              return;
            }
            
            proposalId = msg.proposal.id;
            const proposalPrice = Number(msg.proposal.ask_price);
            
            if (msg.subscription?.id) {
              proposalSubscriptionId = msg.subscription.id;
            }
            
            ws.send(JSON.stringify({
              buy: proposalId,
              price: proposalPrice,
            }));
            return;
          }

          if (msg.buy) {
            clearTimeout(timeout);
            
            if (proposalSubscriptionId) {
              try {
                ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
              } catch (e) {
                // Ignore
              }
            }
            
            ws.close();
            
            if (msg.buy.error) {
              resolve(null);
              return;
            }
            
            resolve(msg.buy.contract_id);
            return;
          }
        } catch (error) {
          this.logger.error(`[TRINITY] Erro ao processar mensagem WebSocket:`, error);
        }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        ws.close();
        resolve(null);
      });
    });
  }

  /**
   * ✅ TRINITY: Monitora contrato e processa resultado
   */
  private async monitorTrinityContract(
    contractId: string,
    state: TrinityUserState,
    symbol: 'R_10' | 'R_25' | 'R_50',
    stakeAmount: number,
    operation: DigitParity,
  ): Promise<void> {
    const asset = state.assets[symbol];
    
    return new Promise((resolve) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      let contractSubscriptionId: string | null = null;
      const timeout = setTimeout(() => {
        if (contractSubscriptionId) {
          try {
            ws.send(JSON.stringify({ forget: contractSubscriptionId }));
          } catch (e) {
            // Ignore
          }
        }
        ws.close();
        this.processTrinityResult(state, symbol, false, stakeAmount, operation); // Timeout = derrota
        resolve();
      }, 120000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.authorize && !msg.authorize.error) {
            ws.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: contractId,
              subscribe: 1,
            }));
            return;
          }

          if (msg.proposal_open_contract) {
            const contract = msg.proposal_open_contract;
            
            if (msg.subscription?.id) {
              contractSubscriptionId = msg.subscription.id;
            }

            // Contrato finalizado
            if (contract.is_sold && contract.status === 'sold') {
              clearTimeout(timeout);
              
              if (contractSubscriptionId) {
                try {
                  ws.send(JSON.stringify({ forget: contractSubscriptionId }));
                } catch (e) {
                  // Ignore
                }
              }
              
              ws.close();
              
              const profit = Number(contract.profit || 0);
              const isWin = profit > 0;
              
              await this.processTrinityResult(state, symbol, isWin, stakeAmount, operation, profit);
              resolve();
            }
          }
        } catch (error) {
          this.logger.error(`[TRINITY][${symbol}] Erro ao monitorar contrato:`, error);
        }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        ws.close();
        this.processTrinityResult(state, symbol, false, stakeAmount, operation);
        resolve();
      });
    });
  }

  /**
   * ✅ TRINITY: Processa resultado da operação (vitória/derrota)
   */
  private async processTrinityResult(
    state: TrinityUserState,
    symbol: 'R_10' | 'R_25' | 'R_50',
    isWin: boolean,
    stakeAmount: number,
    operation: DigitParity,
    profit: number = 0,
  ): Promise<void> {
    const asset = state.assets[symbol];
    
    // Marcar operação como inativa
    asset.isOperationActive = false;
    asset.lastOperationTimestamp = new Date();

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return;

    if (isWin) {
      // ✅ VITÓRIA
      const lucro = profit > 0 ? profit : stakeAmount * modeConfig.payout;
      
      // Atualizar capital
      state.capital += lucro;
      state.totalProfitLoss += lucro;
      
      // ✅ Resetar martingale se estava ativo
      if (asset.martingaleStep > 0) {
        this.logger.log(
          `[TRINITY][${symbol}] ✅ VITÓRIA - Martingale recuperado | Nível: ${asset.martingaleStep} | Lucro: $${lucro.toFixed(2)}`,
        );
        asset.martingaleStep = 0;
        asset.perdaAcumulada = 0;
        asset.apostaInicial = asset.apostaBase; // Resetar para aposta base
      } else {
        this.logger.log(
          `[TRINITY][${symbol}] ✅ VITÓRIA | Lucro: $${lucro.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`,
        );
      }
      
      asset.vitoriasConsecutivas += 1;
      asset.ultimoLucro = lucro;
      
    } else {
      // ✅ DERROTA
      const perda = stakeAmount;
      
      // Atualizar capital
      state.capital -= perda;
      state.totalProfitLoss -= perda;
      
      // ✅ Ativar/incrementar martingale
      if (asset.martingaleStep === 0) {
        // Primeira derrota: ativar martingale
        asset.martingaleStep = 1;
        asset.perdaAcumulada = perda;
        this.logger.log(
          `[TRINITY][${symbol}] ❌ DERROTA - Martingale ATIVADO | Perda: $${perda.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`,
        );
      } else {
        // Já estava em martingale: incrementar nível
        asset.martingaleStep += 1;
        asset.perdaAcumulada += perda;
        
        // ✅ Conservador: Resetar após 5 perdas
        if (state.modoMartingale === 'conservador' && asset.martingaleStep >= 5) {
          this.logger.warn(
            `[TRINITY][${symbol}] ⚠️ Conservador: Resetando após 5 perdas consecutivas`,
          );
          asset.martingaleStep = 0;
          asset.perdaAcumulada = 0;
          asset.apostaInicial = asset.apostaBase;
        } else {
          this.logger.log(
            `[TRINITY][${symbol}] ❌ DERROTA - Martingale Nível ${asset.martingaleStep} | ` +
            `Perda acumulada: $${asset.perdaAcumulada.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`,
          );
        }
      }
      
      asset.vitoriasConsecutivas = 0;
      asset.ultimoLucro = -perda;
    }

    // ✅ Avançar para próximo ativo na rotação
    this.advanceToNextAsset(state);

    // ✅ Verificar limites (meta, stop-loss)
    await this.checkTrinityLimits(state);
  }

  /**
   * ✅ TRINITY: Calcula stop-loss disponível
   */
  private calculateAvailableStopLoss(state: TrinityUserState): number {
    if (!state.stopLoss || state.stopLoss >= 0) {
      return Infinity; // Sem stop-loss configurado
    }

    const capitalDisponivel = state.capital;
    const stopLossDisponivel = capitalDisponivel - (state.capitalInicial + state.stopLoss);
    
    return Math.max(0, stopLossDisponivel);
  }

  /**
   * ✅ TRINITY: Verifica limites (meta, stop-loss, stop-blindado)
   */
  private async checkTrinityLimits(state: TrinityUserState): Promise<void> {
    const lucroAtual = state.capital - state.capitalInicial;
    
    // ✅ Verificar META DIÁRIA
    if (state.profitTarget && lucroAtual >= state.profitTarget) {
      state.isStopped = true;
      this.logger.log(
        `[TRINITY] 🎯 META ATINGIDA! | Lucro: $${lucroAtual.toFixed(2)} | Meta: $${state.profitTarget}`,
      );
      return;
    }

    // ✅ Verificar STOP-LOSS NORMAL
    if (state.stopLoss && lucroAtual <= state.stopLoss) {
      state.isStopped = true;
      this.logger.log(
        `[TRINITY] 🛑 STOP-LOSS ATINGIDO! | Perda: $${Math.abs(lucroAtual).toFixed(2)} | Limite: $${Math.abs(state.stopLoss)}`,
      );
      return;
    }

    // ✅ Verificar STOP-LOSS BLINDADO (protege 50% do lucro)
    if (state.stopLossBlindado && lucroAtual > 0) {
      const stopBlindado = state.capitalInicial + (lucroAtual * 0.5);
      
      if (state.capital <= stopBlindado) {
        state.isStopped = true;
        this.logger.log(
          `[TRINITY] 🛡️ STOP-LOSS BLINDADO ATIVADO! | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)}`,
        );
        return;
      }
    }
  }

  // Getters para acesso externo
  getTicks(symbol: 'R_10' | 'R_25' | 'R_50'): Tick[] {
    return this.trinityTicks[symbol];
  }

  getUsers(): Map<string, TrinityUserState> {
    return this.trinityUsers;
  }
}

