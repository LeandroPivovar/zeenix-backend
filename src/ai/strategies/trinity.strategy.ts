import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { TradeEventsService } from '../trade-events.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, ModoMartingale } from './common.types';
import { gerarSinalZenix } from './signal-generator';
import { DerivWebSocketPoolService } from '../../broker/deriv-websocket-pool.service';

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
  // ✅ Controle global para evitar múltiplas operações simultâneas (guia: 1 ativo por vez)
  globalOperationActive?: boolean;
  // ✅ Cooldown para evitar novas criações de contrato logo após erro/timeouts (mitiga rate limit)
  creationCooldownUntil?: number;
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
  
  // ✅ Sistema de logs (similar à Orion)
  private logQueue: Array<{
    userId: string;
    symbol: 'R_10' | 'R_25' | 'R_50' | 'SISTEMA';
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;

  constructor(
    private dataSource: DataSource,
    private derivPool: DerivWebSocketPoolService,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[TRINITY] 🔵 Estratégia TRINITY inicializada');
    await this.initializeTrinityWebSockets();
    
    // ✅ Log: Sistema inicializado
    if (this.trinityUsers.size > 0) {
      for (const userId of this.trinityUsers.keys()) {
        this.saveTrinityLog(userId, 'SISTEMA', 'info', 
          `Sistema INICIADO | Conectando 3 ativos (R_10, R_25, R_50)...`);
      }
    } else {
      this.logger.log('[TRINITY] ⚠️ Nenhum usuário ativo - WebSockets conectados, aguardando usuários...');
    }
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
    this.logger.log(`[TRINITY] 🔵 Ativando usuário ${userId}...`);
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
    } = config;

    const stakeAmountNum = Number(stakeAmount);
    const profitTargetNum = profitTarget != null ? Number(profitTarget) : null;
    const lossLimitNum = lossLimit != null ? Number(lossLimit) : null;

    const capitalDisplay = Number.isFinite(stakeAmountNum) ? stakeAmountNum.toFixed(2) : '0.00';
    const profitTargetDisplay =
      typeof profitTargetNum === 'number' && Number.isFinite(profitTargetNum)
        ? `+$${profitTargetNum.toFixed(2)}`
        : 'Não definida';
    const stopLossDisplay =
      typeof lossLimitNum === 'number' && Number.isFinite(lossLimitNum)
        ? `-$${Math.abs(lossLimitNum).toFixed(2)}`
        : 'Não definido';

    const stopLossNormalized = lossLimitNum != null ? -Math.abs(lossLimitNum) : null; // garantir negativo
    
    // ✅ entryValue é o valor de entrada por operação (ex: R$ 1.00)
    // ✅ stakeAmount é o capital total da conta (ex: $8953.20)
    const apostaInicial = entryValue != null ? Number(entryValue) : 0.35; // Usar entryValue se fornecido, senão 0.35 (mínimo)
    
    const { isNew, hasConfigChanges } = this.upsertTrinityUserState({
      userId,
      stakeAmount: stakeAmountNum, // Capital total
      apostaInicial, // Valor de entrada por operação
      derivToken,
      currency,
      mode: mode || 'veloz',
      modoMartingale: modoMartingale || 'conservador',
      profitTarget: profitTargetNum,
      lossLimit: stopLossNormalized,
      stopLossBlindado: Boolean(stopLossBlindado),
    });
    
    if (isNew || hasConfigChanges) {
      const logPrefix = isNew ? 'Usuário ATIVADO' : 'Usuário JÁ ATIVO (config atualizada)';
      this.logger.log(`[TRINITY] ✅ ${logPrefix} ${userId} | Total de usuários: ${this.trinityUsers.size}`);
      
      this.saveTrinityLog(userId, 'SISTEMA', 'info', 
        `${logPrefix} | Modo: ${mode || 'veloz'} | Capital: $${capitalDisplay} | ` +
        `Martingale: ${modoMartingale || 'conservador'} | ` +
        `Meta: ${profitTargetDisplay} | ` +
        `Stop-loss: ${stopLossDisplay} | ` +
        `Stop blindado: ${stopLossBlindado ? 'Ativo' : 'Inativo'}`, {
          mode: mode || 'veloz',
          capital: stakeAmountNum,
          modoMartingale: modoMartingale || 'conservador',
          profitTarget: profitTargetNum,
          lossLimit: lossLimitNum,
          stopLossBlindado: Boolean(stopLossBlindado),
        });
    } else {
      this.logger.log(`[TRINITY] ℹ️ Usuário ${userId} já estava ativo - nenhuma alteração aplicada`);
    }
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
    
    this.logger.log(`[TRINITY] 🔌 Inicializando WebSockets para ${symbols.join(', ')}...`);
    
    // ✅ Log: Iniciando conexões
    if (this.trinityUsers.size > 0) {
      for (const userId of this.trinityUsers.keys()) {
        this.saveTrinityLog(userId, 'SISTEMA', 'info', 
          `Conectando 3 ativos...`);
        for (const symbol of symbols) {
          this.saveTrinityLog(userId, symbol, 'info', `Conectando ao WebSocket...`);
        }
      }
    }
    
    for (const symbol of symbols) {
      if (this.trinityConnected[symbol] && this.trinityWebSockets[symbol]?.readyState === WebSocket.OPEN) {
        this.logger.log(`[TRINITY][${symbol}] ✅ Já está conectado`);
        continue;
      }
      this.logger.log(`[TRINITY][${symbol}] 🔌 Conectando WebSocket...`);
      await this.initializeTrinityWebSocket(symbol);
    }
    
    // ✅ Log: Todas conexões estabelecidas
    const totalConectados = symbols.filter(s => this.trinityConnected[s]).length;
    this.logger.log(`[TRINITY] ✅ ${totalConectados}/3 WebSockets conectados`);
    
    if (this.trinityUsers.size > 0) {
      for (const userId of this.trinityUsers.keys()) {
        this.saveTrinityLog(userId, 'SISTEMA', 'info', 
          `${totalConectados} ativos conectados | Iniciando coleta`);
      }
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
        
        // ✅ Log de conexão para todos os usuários ativos (formato documentação)
        for (const userId of this.trinityUsers.keys()) {
          this.saveTrinityLog(userId, symbol, 'info', `Conectado ✅ | Subscrito em ticks`, {
            ativo: symbol,
            url: endpoint,
            appId: this.appId,
            status: 'connected',
          });
        }
        
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
        
        // ✅ Log de erro de conexão
        for (const userId of this.trinityUsers.keys()) {
          this.saveTrinityLog(userId, symbol, 'erro', 
            `Erro na conexão ❌ | ${error.message}`, {
              error: error.message,
              status: 'error',
            });
        }
        
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
    
    // ✅ Log: Histórico carregado
    for (const userId of this.trinityUsers.keys()) {
      this.saveTrinityLog(userId, symbol, 'info', 
        `Histórico carregado: ${ticks.length} ticks`, {
          totalTicks: ticks.length,
        });
    }
  }

  private processTrinityTick(symbol: 'R_10' | 'R_25' | 'R_50', tickData: any): void {
    const rawQuote = tickData.quote;
    const rawEpoch = tickData.epoch;

    if (rawQuote == null || rawQuote === '' || rawEpoch == null || rawEpoch === '') {
      return;
    }

    // ✅ Log: Tick recebido (a cada 100 ticks para não poluir)
    if (this.trinityTicks[symbol].length % 100 === 0) {
      this.logger.debug(`[TRINITY][${symbol}] 📊 Tick recebido: valor=${rawQuote} | total ticks=${this.trinityTicks[symbol].length} | usuários ativos=${this.trinityUsers.size}`);
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

    // ✅ Log de progresso apenas quando necessário (sem logs de ticks individuais)
    const tickNumero = this.trinityTicks[symbol].length;
    for (const userId of this.trinityUsers.keys()) {
      const state = this.trinityUsers.get(userId);
      const modeConfig = state ? this.getModeConfig(state.mode) : null;
      const amostraMinima = modeConfig?.amostraInicial || 20;
      
      // Log de progresso apenas quando completa amostra (formato documentação)
      if (modeConfig && tickNumero === modeConfig.amostraInicial) {
        this.saveTrinityLog(userId, symbol, 'info', 
          `Coleta: ${tickNumero}/${modeConfig.amostraInicial} ticks (100%) ✅ | Amostra completa`);
      }
      // Removido: logs de ticks individuais e progresso intermediário para reduzir poluição
    }

    // Processar estratégias TRINITY
    if (this.trinityUsers.size > 0) {
      this.processTrinityStrategies(symbol, tick).catch((error) => {
        this.logger.error(`[TRINITY][${symbol}] Erro ao processar estratégias:`, error);
      });
    }
  }

  private async processTrinityStrategies(symbol: 'R_10' | 'R_25' | 'R_50', latestTick: Tick): Promise<void> {
    if (this.trinityUsers.size === 0) {
      // ✅ Log: Sem usuários ativos (apenas a cada 100 ticks para não poluir)
      if (this.trinityTicks[symbol].length % 100 === 0) {
        this.logger.debug(`[TRINITY][${symbol}] ⚠️ Sem usuários ativos para processar (ticks: ${this.trinityTicks[symbol].length})`);
      }
      return;
    }

    this.logger.debug(`[TRINITY][${symbol}] 🔄 Processando ${this.trinityUsers.size} usuário(s) | Ticks: ${this.trinityTicks[symbol].length}`);

    // Processar cada usuário TRINITY
    for (const [userId, state] of this.trinityUsers.entries()) {
      // ✅ Verificar se sistema foi parado
      if (state.isStopped) {
        continue;
      }

      // ✅ ROTAÇÃO SEQUENCIAL: Obter próximo ativo na rotação
      const nextAsset = this.getNextAssetInRotation(state);
      
      // ✅ Removido: Logs de rotação (estavam poluindo o sistema)
      // A rotação funciona internamente sem necessidade de logs constantes
      
      // ✅ Se o tick recebido não é do próximo ativo na rotação, pular
      if (nextAsset !== symbol) {
        // Removido: Log de prioridade de martingale (poluía muito)
        
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

      // ✅ Log: Análise iniciada (conforme documentação)
      this.saveTrinityLog(userId, symbol, 'analise', `ANÁLISE INICIADA | Modo: ${state.mode.toUpperCase()}`);
      
      // Gerar sinal
      const sinal = gerarSinalZenix(this.trinityTicks[symbol], modeConfig, state.mode.toUpperCase());
      
      if (!sinal || !sinal.sinal) {
        // ✅ Log: Sinal rejeitado (conforme documentação)
        const motivo = sinal ? 'Critérios não atendidos' : 'Sem sinal gerado';
        const desequilibrio = sinal?.detalhes?.desequilibrio?.desequilibrio ? sinal.detalhes.desequilibrio.desequilibrio * 100 : 0;
        const confianca = sinal?.confianca || 0;
        const desequilibrioMinimo = modeConfig.desequilibrioMin * 100;
        const confianciaMinima = modeConfig.confianciaMin * 100;
        
        this.saveTrinityLog(userId, symbol, 'alerta', 
          `SINAL REJEITADO | Motivo: ${motivo}${desequilibrio > 0 ? ` | Desequilíbrio: ${desequilibrio.toFixed(1)}% (mínimo: ${desequilibrioMinimo.toFixed(0)}%)` : ''}${confianca > 0 ? ` | Confiança: ${confianca.toFixed(1)}% (mínimo: ${confianciaMinima.toFixed(0)}%)` : ''}`, {
          motivo: sinal ? 'criterios_nao_atendidos' : 'sem_sinal',
          desequilibrio,
          desequilibrioMinimo,
          confianca,
          confianciaMinima,
        });
        
        // ✅ Sem sinal válido: avançar para próximo ativo na rotação
        this.advanceToNextAsset(state);
        continue;
      }
      
      // ✅ Log: Análises detalhadas (4 análises conforme documentação)
      const detalhes = sinal.detalhes || {};
      
      // Análise 1: Desequilíbrio Estatístico (formato documentação)
      if (detalhes.desequilibrio) {
        const deseq = detalhes.desequilibrio;
        const pares = Math.round(deseq.percentualPar * modeConfig.amostraInicial);
        const impares = Math.round(deseq.percentualImpar * modeConfig.amostraInicial);
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        const desequilibrioPerc = (deseq.desequilibrio * 100).toFixed(1);
        const ladoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const direcao = deseq.operacao || sinal.sinal;
        
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 1/4: Desequilíbrio Estatístico
  └─ Últimos ${modeConfig.amostraInicial} ticks: ${pares} PAR (${percPar}%), ${impares} ÍMPAR (${percImpar}%)
  └─ Desequilíbrio: ${desequilibrioPerc}% (mínimo: ${(modeConfig.desequilibrioMin * 100).toFixed(0)}%) ✅
  └─ Direção: ${direcao} (oposto do desequilíbrio)
  └─ Confiança base: ${detalhes.confiancaBase?.toFixed(1) || sinal.confianca.toFixed(1)}%`, {
          analise: 'desequilibrio',
          janela: modeConfig.amostraInicial,
          pares,
          impares,
          percPar: parseFloat(percPar),
          percImpar: parseFloat(percImpar),
          desequilibrio: parseFloat(desequilibrioPerc),
          desequilibrioMinimo: modeConfig.desequilibrioMin * 100,
          atendeCriterio: true,
          direcao,
          confiancaBase: detalhes.confiancaBase || sinal.confianca,
        });
      }
      
      // Análise 2: Sequências Repetidas (formato documentação)
      if (detalhes.sequencias) {
        const seq = detalhes.sequencias;
        const bonus = seq.bonus || 0;
        const confiancaAntes = detalhes.confiancaBase || sinal.confianca;
        const confiancaDepois = confiancaAntes + bonus;
        const atendeCriterio = seq.tamanho >= 5;
        
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 2/4: Sequências Repetidas
  └─ Maior sequência: ${seq.tamanho || 0} ${seq.paridade || ''}ES consecutivos
  └─ Critério: ≥5 consecutivos ${atendeCriterio ? '✅' : '❌'}
  └─ Bônus: ${bonus > 0 ? '+' : ''}${bonus}% confiança
  └─ Confiança acumulada: ${confiancaAntes.toFixed(1)}% ${bonus > 0 ? `+ ${bonus}%` : ''} = ${confiancaDepois.toFixed(1)}%`, {
          analise: 'sequencias',
          maiorSequencia: seq.tamanho || 0,
          tipoSequencia: seq.paridade || '',
          criterioMinimo: 5,
          atendeCriterio,
          bonus,
          confiancaAntes,
          confiancaDepois,
        });
      }
      
      // Análise 3: Micro-Tendências (formato documentação)
      if (detalhes.microTendencias) {
        const micro = detalhes.microTendencias;
        const bonus = micro.bonus || 0;
        const aceleracaoPerc = (micro.aceleracao || 0) * 100;
        const atendeCriterio = micro.aceleracao > 0.10;
        const confiancaAntes = (detalhes.confiancaBase || sinal.confianca) + (detalhes.sequencias?.bonus || 0);
        const confiancaDepois = confiancaAntes + bonus;
        const confiancaLimitada = Math.min(95, confiancaDepois);
        
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 3/4: Micro-Tendências
  └─ Curto prazo (50 ticks): ${((micro.curtoPrazoPercPar || 0) * 100).toFixed(1)}% PAR
  └─ Médio prazo (100 ticks): ${((micro.medioPrazoPercPar || 0) * 100).toFixed(1)}% PAR
  └─ Diferença: ${aceleracaoPerc.toFixed(1)}% (mínimo: 10%) ${atendeCriterio ? '✅' : '❌'}
  └─ Bônus: ${bonus > 0 ? '+' : ''}${bonus}% confiança
  └─ Confiança acumulada: ${confiancaAntes.toFixed(1)}% ${bonus > 0 ? `+ ${bonus}%` : ''} = ${confiancaDepois.toFixed(1)}%${confiancaDepois > 95 ? ` → limitado a ${confiancaLimitada.toFixed(1)}%` : ''}`, {
          analise: 'microTendencias',
          curtoPrazo: {
            janela: 50,
            percPar: (micro.curtoPrazoPercPar || 0) * 100,
          },
          medioPrazo: {
            janela: 100,
            percPar: (micro.medioPrazoPercPar || 0) * 100,
          },
          diferenca: aceleracaoPerc,
          criterioMinimo: 10,
          atendeCriterio,
          bonus,
          confiancaAntes,
          confiancaDepois,
          confiancaLimitada: confiancaDepois > 95 ? confiancaLimitada : confiancaDepois,
        });
      }
      
      // Análise 4: Força do Desequilíbrio (formato documentação)
      if (detalhes.forca) {
        const forca = detalhes.forca;
        const bonus = forca.bonus || 0;
        const ticksConsecutivos = forca.velocidade || 0;
        const atendeCriterio = ticksConsecutivos > 5;
        const confiancaAntes = Math.min(95, (detalhes.confiancaBase || sinal.confianca) + (detalhes.sequencias?.bonus || 0) + (detalhes.microTendencias?.bonus || 0));
        const confiancaDepois = Math.min(95, confiancaAntes + bonus);
        const jaNoLimite = confiancaAntes >= 95;
        
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 4/4: Força do Desequilíbrio
  └─ Ticks consecutivos com desequilíbrio >60%: ${ticksConsecutivos}
  └─ Critério: >5 ticks ${atendeCriterio ? '✅' : '❌'}
  └─ Bônus: ${bonus > 0 ? '+' : ''}${bonus}% confiança
  └─ Confiança final: ${confiancaAntes.toFixed(1)}%${bonus > 0 ? ` ${jaNoLimite ? '(já no limite)' : `+ ${bonus}% = ${confiancaDepois.toFixed(1)}%`}` : ''}`, {
          analise: 'forca',
          ticksConsecutivos,
          criterioMinimo: 5,
          atendeCriterio,
          bonus,
          confiancaAntes,
          confiancaDepois,
          jaNoLimite,
        });
      }
      
      // Log final da análise (formato documentação)
      const criteriosAtendidos = [
        detalhes.desequilibrio?.desequilibrio >= modeConfig.desequilibrioMin,
        detalhes.sequencias?.tamanho >= 5,
        detalhes.microTendencias?.aceleracao > 0.10,
        detalhes.forca?.velocidade > 5,
      ].filter(Boolean).length;
      
      this.saveTrinityLog(userId, symbol, 'analise', 
        `ANÁLISE COMPLETA ✅
  └─ Critérios atendidos: ${criteriosAtendidos}/4
  └─ Desequilíbrio: ${(detalhes.desequilibrio?.desequilibrio || 0) * 100}% ✅
  └─ Sequências: ${detalhes.sequencias?.tamanho || 0} consecutivos ${(detalhes.sequencias?.tamanho || 0) >= 5 ? '✅' : '❌'}
  └─ Micro-tendências: ${((detalhes.microTendencias?.aceleracao || 0) * 100).toFixed(1)}% diferença ${(detalhes.microTendencias?.aceleracao || 0) > 0.10 ? '✅' : '❌'}
  └─ Força: ${detalhes.forca?.velocidade || 0} ticks ${(detalhes.forca?.velocidade || 0) > 5 ? '✅' : '❌'}
  └─ Confiança final: ${sinal.confianca.toFixed(1)}%
  └─ Direção: ${sinal.sinal}`, {
          criteriosAtendidos,
          criteriosTotais: 4,
          desequilibrio: (detalhes.desequilibrio?.desequilibrio || 0) * 100,
          sequencia: detalhes.sequencias?.tamanho || 0,
          microTendencia: (detalhes.microTendencias?.aceleracao || 0) * 100,
          forca: Math.round((detalhes.forca?.velocidade || 0) * 100),
          confiancaFinal: sinal.confianca,
          direcao: sinal.sinal,
          sinalValido: true,
        });
      
      // ✅ Log: Sinal gerado (formato documentação)
      this.saveTrinityLog(userId, symbol, 'sinal', 
        `SINAL GERADO ✅
  └─ Direção: ${sinal.sinal}
  └─ Confiança: ${sinal.confianca.toFixed(1)}%
  └─ Desequilíbrio: ${(detalhes.desequilibrio?.desequilibrio || 0) * 100}%
  └─ Aposta: $${asset.apostaInicial.toFixed(2)} (${asset.martingaleStep > 0 ? 'martingale' : 'normal'})
  └─ Aguardando execução...`, {
          direcao: sinal.sinal,
          confianca: sinal.confianca,
          desequilibrio: (detalhes.desequilibrio?.desequilibrio || 0) * 100,
          aposta: asset.apostaInicial,
          martingaleAtivo: asset.martingaleStep > 0,
          timestamp: Date.now(),
        });
      
      this.logger.log(
        `[TRINITY][${symbol}] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}% | ${sinal.motivo}`,
      );

      // ✅ Executar operação TRINITY (passar sinal para logs)
      await this.executeTrinityOperation(state, symbol, sinal.sinal, sinal);
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
    // Não pode processar se há operação global em andamento (rotação sequencial estrita)
    if (state.globalOperationActive) return false;
    // Não pode processar se está em cooldown de criação
    if (state.creationCooldownUntil && Date.now() < state.creationCooldownUntil) return false;

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
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional, padrão: 0.35)
    derivToken: string;
    currency: string;
    mode: string;
    modoMartingale?: ModoMartingale;
    profitTarget?: number | null;
    lossLimit?: number | null;
    stopLossBlindado?: boolean | null;
  }): { isNew: boolean; hasConfigChanges: boolean } {
    const existing = this.trinityUsers.get(params.userId);
    const stopLossNormalized = params.lossLimit != null ? -Math.abs(params.lossLimit) : null;
    let hasConfigChanges = false;
    if (existing) {
      // ✅ Quando reativar, atualizar capitalInicial para o capital atual (nova sessão)
      // Isso garante que o stop-loss seja calculado corretamente a partir do novo capital
      const novoCapitalInicial = params.stakeAmount;
      // ✅ Sempre usar apostaInicial fornecido, senão usar o valor existente ou 0.35
      const apostaInicial = params.apostaInicial !== undefined 
        ? params.apostaInicial 
        : (existing.assets.R_10.apostaBase || 0.35);
      
      hasConfigChanges =
        existing.capital !== params.stakeAmount ||
        existing.mode !== params.mode ||
        existing.modoMartingale !== (params.modoMartingale || 'conservador') ||
        existing.profitTarget !== (params.profitTarget || null) ||
        existing.stopLoss !== stopLossNormalized ||
        existing.stopLossBlindado !== Boolean(params.stopLossBlindado) ||
        existing.assets.R_10.apostaBase !== apostaInicial;
      
      Object.assign(existing, {
        capital: params.stakeAmount,
        capitalInicial: novoCapitalInicial,
        derivToken: params.derivToken,
        currency: params.currency,
        mode: params.mode,
        modoMartingale: params.modoMartingale || 'conservador',
        profitTarget: params.profitTarget || null,
        stopLoss: stopLossNormalized,
        stopLossBlindado: Boolean(params.stopLossBlindado),
        isStopped: false,
        totalProfitLoss: 0, // Resetar P&L total para nova sessão
      });
      
      // ✅ Sempre atualizar aposta inicial de todos os ativos quando fornecido
      if (params.apostaInicial !== undefined) {
        for (const assetKey of ['R_10', 'R_25', 'R_50'] as const) {
          existing.assets[assetKey].apostaInicial = apostaInicial;
          existing.assets[assetKey].apostaBase = apostaInicial;
          existing.assets[assetKey].ultimaApostaUsada = apostaInicial;
        }
        this.logger.log(
          `[TRINITY] 🔄 Aposta inicial atualizada para todos os ativos: $${apostaInicial.toFixed(2)}`,
        );
      }
      
      return { isNew: false, hasConfigChanges };
    }

      // Criar novo estado
    // ✅ Usar apostaInicial se fornecido, senão usar mínimo de 0.35
    const apostaInicial = params.apostaInicial || 0.35;
    
    const assets: TrinityUserState['assets'] = {
      R_10: {
        symbol: 'R_10',
        ticks: [],
        isOperationActive: false,
        martingaleStep: 0,
        perdaAcumulada: 0,
        apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
        ultimaApostaUsada: apostaInicial,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: apostaInicial, // ✅ Base para cálculos de martingale
        ultimoLucro: 0,
        lastOperationTimestamp: null,
      },
      R_25: {
        symbol: 'R_25',
        ticks: [],
        isOperationActive: false,
        martingaleStep: 0,
        perdaAcumulada: 0,
        apostaInicial: apostaInicial,
        ultimaApostaUsada: apostaInicial,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: apostaInicial,
        ultimoLucro: 0,
        lastOperationTimestamp: null,
      },
      R_50: {
        symbol: 'R_50',
        ticks: [],
        isOperationActive: false,
        martingaleStep: 0,
        perdaAcumulada: 0,
        apostaInicial: apostaInicial,
        ultimaApostaUsada: apostaInicial,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: apostaInicial,
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
      stopLoss: stopLossNormalized || undefined,
      stopLossBlindado: Boolean(params.stopLossBlindado),
      profitTarget: params.profitTarget || undefined,
      isStopped: false,
      globalOperationActive: false,
    });
    
    return { isNew: true, hasConfigChanges: true };
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
    sinal?: { confianca: number; motivo: string } | null,
  ): Promise<void> {
    const asset = state.assets[symbol];
    
    // Marcar como operação ativa
    asset.isOperationActive = true;
    state.globalOperationActive = true;
    
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
        state.userId,
        symbol,
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
        state.globalOperationActive = false;
        // Aplicar cooldown para reduzir chamadas em sequência e mitigar rate limit
        state.creationCooldownUntil = Date.now() + 5000; // 5s
        // ✅ Log: Erro ao executar operação
        this.saveTrinityLog(state.userId, symbol, 'erro', 
          `Erro ao executar operação | Não foi possível criar contrato`);
        // Avançar rotação para não travar no mesmo ativo
        this.advanceToNextAsset(state);
        return;
      }

      // ✅ Salvar trade no banco de dados (status PENDING)
      const entryPrice = this.trinityTicks[symbol].length > 0 
        ? this.trinityTicks[symbol][this.trinityTicks[symbol].length - 1].value 
        : 0;
      const tradeId = await this.saveTrinityTrade({
        userId: state.userId,
        contractId,
        symbol,
        contractType,
        entryPrice,
        stakeAmount,
        operation,
        mode: state.mode,
      });
      
      // ✅ Log: Operação executada (formato documentação)
      const operacaoNumero = asset.martingaleStep > 0 ? asset.martingaleStep : 1;
      this.saveTrinityLog(state.userId, symbol, 'operacao', 
        `OPERAÇÃO #${operacaoNumero} EXECUTADA
  └─ Direção: ${operation}
  └─ Aposta: $${stakeAmount.toFixed(2)}
  └─ Confiança: ${sinal?.confianca?.toFixed(1) || 'N/A'}%
  └─ Martingale: ${asset.martingaleStep > 0 ? `Sim (Nível ${asset.martingaleStep})` : 'Não'}
  └─ Capital antes: $${state.capital.toFixed(2)}
  └─ Aguardando resultado...`, {
          ativo: symbol,
          operacaoNumero,
          direcao: operation,
          aposta: stakeAmount,
          confianca: sinal?.confianca || 0,
          martingale: {
            ativo: asset.martingaleStep > 0,
            nivel: asset.martingaleStep,
          },
          capitalAntes: state.capital,
          timestamp: Date.now(),
          contractId,
          tradeId,
        });

      // ✅ Monitorar contrato e processar resultado
      await this.monitorTrinityContract(contractId, state, symbol, stakeAmount, operation, tradeId);
      
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] Erro ao executar operação:`, error);
      asset.isOperationActive = false;
      state.globalOperationActive = false;
      state.creationCooldownUntil = Date.now() + 5000; // 5s cooldown após erro
      this.advanceToNextAsset(state);
    }
  }

  /**
   * ✅ TRINITY: Executa trade via WebSocket
   */
  private async executeTrinityTradeViaWebSocket(
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_50',
    token: string,
    contractParams: any,
  ): Promise<string | null> {
    try {
      const proposal = await this.derivPool.sendRequest(token, {
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: contractParams.duration || 1,
        duration_unit: contractParams.duration_unit || 't',
        symbol: contractParams.symbol,
        subscribe: 0,
      });

      if (proposal?.error) {
        const err = proposal.error;
        this.saveTrinityLog(userId, symbol, 'erro',
          `Erro ao gerar proposta | ${err.code} - ${err.message}`, {
            etapa: 'proposal',
            error: err,
            contractType: contractParams.contract_type,
            amount: contractParams.amount,
          });
        return null;
      }

      const proposalId = proposal?.proposal?.id;
      const proposalPrice = Number(proposal?.proposal?.ask_price);

      if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
        this.saveTrinityLog(userId, symbol, 'erro',
          `Proposta inválida retornada pela Deriv (sem id ou preço)`, {
            etapa: 'proposal',
            proposal,
          });
        return null;
      }

      const buy = await this.derivPool.sendRequest(token, {
        buy: proposalId,
        price: proposalPrice,
      });

      if (buy?.error || buy?.buy?.error) {
        const err = buy?.error || buy?.buy?.error;
        this.saveTrinityLog(userId, symbol, 'erro',
          `Erro ao comprar contrato | ${err.code} - ${err.message}`, {
            etapa: 'buy',
            error: err,
            contractType: contractParams.contract_type,
            amount: contractParams.amount,
          });
        return null;
      }

      const contractId = buy?.buy?.contract_id;

      if (!contractId) {
        this.saveTrinityLog(userId, symbol, 'erro',
          `Compra sem contract_id retornado pela Deriv`, {
            etapa: 'buy',
            response: buy,
          });
        return null;
      }

      return contractId;
    } catch (err: any) {
      this.saveTrinityLog(userId, symbol, 'erro',
        `Erro de conexão ao criar contrato | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount.toFixed(2)}`, {
          etapa: 'connection',
          error: err?.message || String(err),
        });
      return null;
    }
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
    tradeId?: number | null,
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
        this.processTrinityResult(state, symbol, false, stakeAmount, operation, 0, 0, null); // Timeout = derrota
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

            // ✅ Log: Status do contrato (apenas quando muda ou é importante)
            if (contract.status && (contract.status === 'won' || contract.status === 'lost' || contract.is_sold)) {
              this.saveTrinityLog(state.userId, symbol, 'info', 
                `Contrato monitorado | Status: ${contract.status} | is_sold: ${contract.is_sold} | Profit: $${(contract.profit || 0).toFixed(2)}`, {
                  contractId,
                  status: contract.status,
                  isSold: contract.is_sold,
                  profit: contract.profit || 0,
                });
            }

            // ✅ Log: Debug - verificar valores
            this.logger.log(`[TRINITY][${symbol}] Contrato monitorado: is_sold=${contract.is_sold} (tipo: ${typeof contract.is_sold}), status=${contract.status}, profit=${contract.profit}`);

            // Contrato finalizado (verificar apenas is_sold, como a Orion faz)
            // ✅ Aceitar tanto 1 quanto true (a API pode retornar boolean)
            if (contract.is_sold === 1 || contract.is_sold === true) {
              clearTimeout(timeout);
              
              if (contractSubscriptionId) {
                try {
                  ws.send(JSON.stringify({ forget: contractSubscriptionId }));
                } catch (e) {
                  // Ignore
                }
              }
              
              ws.close();
              
              // ✅ Calcular profit corretamente (pode vir como string ou número)
              const rawProfit = contract.profit;
              const profit = typeof rawProfit === 'string' ? parseFloat(rawProfit) : Number(rawProfit || 0);
              const isWin = profit > 0;
              // ✅ Usar exit_spot ou current_spot como a Orion faz
              const exitPrice = Number(contract.exit_spot || contract.exit_tick || contract.exit_tick_display_value || contract.current_spot || 0);
              
              // ✅ Log: Contrato finalizado com detalhes
              this.logger.log(`[TRINITY][${symbol}] Contrato FINALIZADO | rawProfit=${rawProfit} (tipo: ${typeof rawProfit}) | profit=${profit} | isWin=${isWin} | exitPrice=${exitPrice}`);
              
              this.saveTrinityLog(state.userId, symbol, 'info', 
                `Contrato FINALIZADO | Profit: $${profit.toFixed(2)} | isWin: ${isWin}`, {
                  contractId,
                  rawProfit,
                  profit,
                  isWin,
                  exitPrice,
                });
              
              await this.processTrinityResult(state, symbol, isWin, stakeAmount, operation, profit, exitPrice, tradeId);
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
        this.processTrinityResult(state, symbol, false, stakeAmount, operation, 0, 0, tradeId);
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
    exitPrice: number = 0,
    tradeId?: number | null,
  ): Promise<void> {
    const asset = state.assets[symbol];
    
    // Marcar operação como inativa
    asset.isOperationActive = false;
    state.globalOperationActive = false;
    asset.lastOperationTimestamp = new Date();
    // ✅ Resetar contador de ticks para permitir nova operação
    asset.ticksDesdeUltimaOp = 0;

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return;

    if (isWin) {
      // ✅ VITÓRIA
      const lucro = profit > 0 ? profit : stakeAmount * modeConfig.payout;
      const capitalDepois = state.capital + lucro;
      // ✅ ROI calculado em relação ao capital inicial (não ao capital atual)
      const roi = state.capitalInicial > 0 
        ? ((lucro / state.capitalInicial) * 100).toFixed(2)
        : '0.00';
      
      // Atualizar capital
      state.capital += lucro;
      state.totalProfitLoss += lucro;
      
      // ✅ Resetar martingale se estava ativo
      if (asset.martingaleStep > 0) {
        const nivelAntes = asset.martingaleStep;
        const perdaRecuperada = asset.perdaAcumulada;
        
        // ✅ Log: Martingale recuperado (formato documentação)
        const lucroLiquido = lucro - perdaRecuperada;
        this.saveTrinityLog(state.userId, symbol, 'info', 
          `MARTINGALE RECUPERADO ✅
  └─ Nível: ${nivelAntes} → 0 (resetado)
  └─ Perda recuperada: $${perdaRecuperada.toFixed(2)}
  └─ Ganho: $${lucro.toFixed(2)}
  └─ Lucro líquido: $${lucroLiquido.toFixed(2)} (${lucroLiquido >= 0 ? 'break-even' : 'ainda negativo'})
  └─ Próxima aposta: $${asset.apostaBase.toFixed(2)} (normal)`, {
            ativo: symbol,
            evento: 'recuperacao',
            nivelAntes,
            nivelDepois: 0,
            perdaRecuperada,
            ganho: lucro,
            lucroLiquido,
            proximaAposta: asset.apostaBase,
          });
        
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
      
      // ✅ Log: Resultado vitória (formato documentação)
      // Calcular número da operação: se estava em martingale, usar o nível; senão, contar operações
      const operacaoNumero = asset.martingaleStep > 0 ? asset.martingaleStep : 1;
      const digitoResultado = exitPrice > 0 ? this.extractLastDigit(exitPrice) : 0;
      const tipoResultado = digitoResultado % 2 === 0 ? 'PAR' : 'ÍMPAR';
      
      this.saveTrinityLog(state.userId, symbol, 'resultado', 
        `✅ VITÓRIA! Operação #${operacaoNumero}
  └─ Dígito resultado: ${digitoResultado} (${tipoResultado}) ✅
  └─ Aposta: $${stakeAmount.toFixed(2)}
  └─ Ganho: $${lucro.toFixed(2)} (payout 95%)
  └─ Capital depois: $${capitalDepois.toFixed(2)}
  └─ ROI: +${roi}%`, {
          ativo: symbol,
          operacaoNumero,
          resultado: 'vitoria',
          digitoResultado,
          tipoResultado,
          apostado: stakeAmount,
          ganho: lucro,
          capitalAntes: state.capital - lucro,
          capitalDepois,
          lucroOperacao: lucro,
          roi: parseFloat(roi),
        });
      
      asset.vitoriasConsecutivas += 1;
      asset.ultimoLucro = lucro;
      
    } else {
      // ✅ DERROTA
      const perda = stakeAmount;
      const capitalDepois = state.capital - perda;
      // ✅ ROI calculado em relação ao capital inicial (não ao capital atual)
      const roi = state.capitalInicial > 0
        ? ((perda / state.capitalInicial) * 100).toFixed(2)
        : '0.00';
      
      // Atualizar capital
      state.capital -= perda;
      state.totalProfitLoss -= perda;
      
      // ✅ Ativar/incrementar martingale
      if (asset.martingaleStep === 0) {
        // Primeira derrota: ativar martingale
        asset.martingaleStep = 1;
        asset.perdaAcumulada = perda;
        
        // Calcular próxima aposta
        const proximaAposta = calcularProximaAposta(
          asset.perdaAcumulada,
          state.modoMartingale,
          modeConfig.payout * 100,
          state.modoMartingale === 'agressivo' ? asset.ultimaApostaUsada : 0,
        );
        
        // ✅ Log: Martingale ativado (formato documentação)
        const operacaoNumeroAtivacao = 1; // Primeira derrota = operação #1
        this.saveTrinityLog(state.userId, symbol, 'info', 
          `MARTINGALE ATIVADO
  └─ Motivo: Derrota na operação #${operacaoNumeroAtivacao}
  └─ Nível: 1
  └─ Perda acumulada: $${perda.toFixed(2)}
  └─ Próxima aposta: $${proximaAposta.toFixed(2)} (modo: ${state.modoMartingale})
  └─ Objetivo: Recuperar $${perda.toFixed(2)}`, {
            ativo: symbol,
            evento: 'ativacao',
            nivel: 1,
            perdaAcumulada: perda,
            proximaAposta,
            modoMartingale: state.modoMartingale,
            objetivo: 'recuperar_total',
          });
        
        this.logger.log(
          `[TRINITY][${symbol}] ❌ DERROTA - Martingale ATIVADO | Perda: $${perda.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`,
        );
      } else {
        // Já estava em martingale: incrementar nível
        const nivelAntes = asset.martingaleStep;
        const perdaAntes = asset.perdaAcumulada;
        asset.martingaleStep += 1;
        asset.perdaAcumulada += perda;
        
        // Calcular próxima aposta
        const proximaAposta = calcularProximaAposta(
          asset.perdaAcumulada,
          state.modoMartingale,
          modeConfig.payout * 100,
          state.modoMartingale === 'agressivo' ? asset.ultimaApostaUsada : 0,
        );
        
        // ✅ Conservador: Resetar após 5 perdas
        if (state.modoMartingale === 'conservador' && asset.martingaleStep >= 5) {
          // ✅ Log: Martingale resetado (conservador)
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `MARTINGALE RESETADO (Conservador) | Após 5 perdas consecutivas`, {
              evento: 'reset',
              motivo: 'conservador_limite',
              nivelAntes,
              nivelDepois: 0,
            });
          
          this.logger.warn(
            `[TRINITY][${symbol}] ⚠️ Conservador: Resetando após 5 perdas consecutivas`,
          );
          asset.martingaleStep = 0;
          asset.perdaAcumulada = 0;
          asset.apostaInicial = asset.apostaBase;
        } else {
          // ✅ Log: Martingale incrementado (formato documentação)
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `MARTINGALE INCREMENTADO
  └─ Nível: ${nivelAntes} → ${asset.martingaleStep}
  └─ Perda acumulada: $${perdaAntes.toFixed(2)} → $${asset.perdaAcumulada.toFixed(2)}
  └─ Próxima aposta: $${proximaAposta.toFixed(2)}`, {
              ativo: symbol,
              evento: 'incremento',
              nivelAntes,
              nivelDepois: asset.martingaleStep,
              perdaAntes,
              perdaDepois: asset.perdaAcumulada,
              proximaAposta,
            });
          
          this.logger.log(
            `[TRINITY][${symbol}] ❌ DERROTA - Martingale Nível ${asset.martingaleStep} | ` +
            `Perda acumulada: $${asset.perdaAcumulada.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`,
          );
        }
      }
      
      // ✅ Log: Resultado derrota (formato documentação)
      // Calcular número da operação: se estava em martingale, usar o nível; senão, será 1
      const operacaoNumeroAntes = asset.martingaleStep > 0 ? asset.martingaleStep : 1;
      const digitoResultado = exitPrice > 0 ? this.extractLastDigit(exitPrice) : 0;
      const tipoResultado = digitoResultado % 2 === 0 ? 'PAR' : 'ÍMPAR';
      const esperado = operation;
      
      this.saveTrinityLog(state.userId, symbol, 'resultado', 
        `❌ DERROTA! Operação #${operacaoNumeroAntes}
  └─ Dígito resultado: ${digitoResultado} (${tipoResultado}) ❌ (esperado: ${esperado})
  └─ Aposta: $${stakeAmount.toFixed(2)}
  └─ Perda: -$${perda.toFixed(2)}
  └─ Capital depois: $${capitalDepois.toFixed(2)}
  └─ ROI: -${roi}%`, {
          ativo: symbol,
          operacaoNumero: operacaoNumeroAntes,
          resultado: 'derrota',
          digitoResultado,
          tipoResultado,
          esperado,
          apostado: stakeAmount,
          perda: -perda,
          capitalAntes: state.capital + perda,
          capitalDepois,
          lucroOperacao: -perda,
          roi: -parseFloat(roi),
        });
      
      asset.vitoriasConsecutivas = 0;
      asset.ultimoLucro = -perda;
    }

    // ✅ Avançar para próximo ativo na rotação (sem log para reduzir poluição)
    this.advanceToNextAsset(state);

    // ✅ Atualizar trade no banco de dados
    if (tradeId) {
      // ✅ Log: Debug - valores antes de atualizar
      this.logger.log(`[TRINITY][${symbol}] Atualizando trade ID=${tradeId} | status=${isWin ? 'WON' : 'LOST'} | profitLoss=${profit} | exitPrice=${exitPrice}`);
      
      await this.updateTrinityTrade(tradeId, state.userId, {
        status: isWin ? 'WON' : 'LOST',
        profitLoss: profit,
        exitPrice: exitPrice || 0,
      });
    } else {
      this.logger.warn(`[TRINITY][${symbol}] ⚠️ Trade ID não encontrado, não foi possível atualizar no banco`);
    }

    // ✅ Verificar limites (meta, stop-loss)
    await this.checkTrinityLimits(state);
    
    // ✅ Cooldown curto após término para espaçar requisições (mitiga rate limit)
    state.creationCooldownUntil = Date.now() + 2000; // 2s
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
    const stopLossValue = state.stopLoss != null ? -Math.abs(state.stopLoss) : null; // garantir negativo para comparação
    const lucroAtual = state.capital - state.capitalInicial;
    
    // ✅ Log: Debug - valores para verificação
    this.logger.debug(
      `[TRINITY][CheckLimits] Capital: $${state.capital.toFixed(2)} | Capital Inicial: $${state.capitalInicial.toFixed(2)} | Lucro Atual: $${lucroAtual.toFixed(2)} | Stop-loss: ${state.stopLoss ? `-$${Math.abs(state.stopLoss).toFixed(2)}` : 'N/A'}`,
    );
    
    // ✅ Verificar META DIÁRIA
    if (state.profitTarget && lucroAtual >= state.profitTarget) {
      state.isStopped = true;
      const roi = ((lucroAtual / state.capitalInicial) * 100).toFixed(2);
      this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
        `META DIÁRIA ATINGIDA! 🎉 | Meta: +$${state.profitTarget.toFixed(2)} | Lucro atual: +$${lucroAtual.toFixed(2)} | ROI: +${roi}% | Parando sistema...`, {
          meta: state.profitTarget,
          lucroAtual,
          roi: parseFloat(roi),
        });
      this.logger.log(
        `[TRINITY] 🎯 META ATINGIDA! | Lucro: $${lucroAtual.toFixed(2)} | Meta: $${state.profitTarget}`,
      );
      return;
    }

    // ✅ Verificar STOP-LOSS NORMAL
    // Stop-loss só deve ser acionado se:
    // 1. Há um stop-loss configurado (negativo, ex: -25.00)
    // 2. O lucro atual é negativo (há perda)
    // 3. A perda atual é maior ou igual ao stop-loss (mais negativo)
    if (stopLossValue !== null && lucroAtual < 0 && lucroAtual <= stopLossValue) {
      state.isStopped = true;
      const roi = ((lucroAtual / state.capitalInicial) * 100).toFixed(2);
      this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
        `STOP-LOSS ATINGIDO! ⚠️ | Stop-loss: -$${Math.abs(stopLossValue).toFixed(2)} | Perda atual: -$${Math.abs(lucroAtual).toFixed(2)} | ROI: ${roi}% | Parando sistema...`, {
          stopLoss: stopLossValue,
          perdaAtual: lucroAtual,
          roi: parseFloat(roi),
        });
      this.logger.log(
        `[TRINITY] 🛑 STOP-LOSS ATINGIDO! | Perda: $${Math.abs(lucroAtual).toFixed(2)} | Limite: $${Math.abs(stopLossValue).toFixed(2)}`,
      );
      return;
    }

    // ✅ Verificar STOP-LOSS BLINDADO (protege 50% do lucro)
    if (state.stopLossBlindado && lucroAtual > 0) {
      const stopBlindado = state.capitalInicial + (lucroAtual * 0.5);
      
      if (state.capital <= stopBlindado) {
        state.isStopped = true;
        this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
          `STOP-LOSS BLINDADO ATIVADO! 🛡️ | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} | Parando sistema...`, {
            capital: state.capital,
            stopBlindado,
          });
        this.logger.log(
          `[TRINITY] 🛡️ STOP-LOSS BLINDADO ATIVADO! | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)}`,
        );
        return;
      }
    }
  }

  /**
   * ✅ TRINITY: Salva trade no banco de dados (status PENDING)
   */
  private async saveTrinityTrade(trade: {
    userId: string;
    contractId: string;
    symbol: 'R_10' | 'R_25' | 'R_50';
    contractType: string;
    entryPrice: number;
    stakeAmount: number;
    operation: DigitParity;
    mode: string;
  }): Promise<number | null> {
    try {
      const analysisData = {
        strategy: 'trinity',
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
            gemini_duration, contract_type, contract_id, created_at, analysis_data, symbol)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
          [
            trade.userId,
            trade.operation,
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
        // Se o campo symbol não existir, inserir sem ele
        if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
          this.logger.warn(`[TRINITY][SaveTrade] Campo 'symbol' não existe, inserindo sem ele`);
          insertResult = await this.dataSource.query(
            `INSERT INTO ai_trades 
             (user_id, gemini_signal, entry_price, stake_amount, status, 
              gemini_duration, contract_type, contract_id, created_at, analysis_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [
              trade.userId,
              trade.operation,
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
        this.logger.log(`[TRINITY][${trade.symbol}] ✅ Trade salvo no banco: ID=${tradeId}`);
        this.tradeEvents.emit({
          userId: trade.userId,
          type: 'created',
          tradeId,
          status: 'PENDING',
          strategy: 'trinity',
          symbol: trade.symbol,
          contractType: trade.contractType,
        });
      }
      
      return tradeId;
    } catch (error) {
      this.logger.error(`[TRINITY][${trade.symbol}] Erro ao salvar trade no banco:`, error);
      return null;
    }
  }

  /**
   * ✅ TRINITY: Atualiza trade no banco de dados (status WON/LOST)
   */
  private async updateTrinityTrade(
    tradeId: number,
    userId: string,
    update: {
      status: 'WON' | 'LOST';
      profitLoss: number;
      exitPrice: number;
    }
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE ai_trades 
         SET status = ?,
             profit_loss = ?,
             exit_price = ?,
             closed_at = NOW()
         WHERE id = ?`,
        [
          update.status,
          update.profitLoss,
          update.exitPrice,
          tradeId,
        ]
      );
      
      this.logger.log(`[TRINITY] ✅ Trade atualizado no banco: ID=${tradeId}, Status=${update.status}, P&L=${update.profitLoss.toFixed(2)}`);
      this.tradeEvents.emit({
        userId,
        type: 'updated',
        tradeId,
        status: update.status,
        strategy: 'trinity',
        profitLoss: update.profitLoss,
        exitPrice: update.exitPrice,
      });
    } catch (error) {
      this.logger.error(`[TRINITY] Erro ao atualizar trade no banco (ID=${tradeId}):`, error);
    }
  }

  /**
   * ✅ TRINITY: Sistema de Logs Detalhados
   * Salva log de forma assíncrona (não bloqueia execução)
   */
  private saveTrinityLog(
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_50' | 'SISTEMA',
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro',
    message: string,
    details?: any,
  ): void {
    // Validar parâmetros
    if (!userId || !type || !message || message.trim() === '') {
      return;
    }

    // Adicionar à fila
    this.logQueue.push({ userId, symbol, type, message, details });

    // ✅ Log: Debug - verificar se está adicionando à fila
    if (this.logQueue.length % 10 === 0) {
      this.logger.debug(`[TRINITY][SaveLog] Fila de logs: ${this.logQueue.length} logs pendentes`);
    }

    // Processar fila em background (não bloqueia)
    this.processTrinityLogQueue().catch(error => {
      this.logger.error(`[TRINITY][SaveLog] Erro ao processar fila de logs:`, error);
    });
  }

  /**
   * ✅ TRINITY: Processa fila de logs em batch (otimizado)
   */
  private async processTrinityLogQueue(): Promise<void> {
    if (this.logProcessing || this.logQueue.length === 0) {
      return;
    }

    this.logProcessing = true;

    try {
      // Processar até 50 logs por vez
      const batch = this.logQueue.splice(0, 50);
      
      if (batch.length === 0) {
        this.logProcessing = false;
        return;
      }

      // ✅ Log: Debug - processando batch
      this.logger.debug(`[TRINITY][ProcessLogQueue] Processando ${batch.length} logs, ${this.logQueue.length} restantes na fila`);

      // Agrupar por userId para otimizar
      const logsByUser = new Map<string, typeof batch>();
      for (const log of batch) {
        if (!logsByUser.has(log.userId)) {
          logsByUser.set(log.userId, []);
        }
        logsByUser.get(log.userId)!.push(log);
      }

      // Processar cada usuário em paralelo
      await Promise.all(
        Array.from(logsByUser.entries()).map(([userId, logs]) =>
          this.saveTrinityLogsBatch(userId, logs)
        )
      );

      // Se ainda há logs na fila, processar novamente
      if (this.logQueue.length > 0) {
        setImmediate(() => this.processTrinityLogQueue());
      }
    } catch (error) {
      this.logger.error(`[TRINITY][ProcessLogQueue] Erro:`, error);
    } finally {
      this.logProcessing = false;
    }
  }

  /**
   * ✅ TRINITY: Salva múltiplos logs de um usuário em uma única query (otimizado)
   */
  private async saveTrinityLogsBatch(
    userId: string,
    logs: Array<{
      symbol: 'R_10' | 'R_25' | 'R_50' | 'SISTEMA';
      type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
      message: string;
      details?: any;
    }>,
  ): Promise<void> {
    if (logs.length === 0) return;

    try {
      const icons = {
        info: 'ℹ️',
        tick: '📊',
        analise: '🔍',
        sinal: '⚡',
        operacao: '💰',
        resultado: '✅',
        alerta: '⚠️',
        erro: '🚫',
      };

      // Preparar valores para INSERT em batch
      const values = logs.map(log => {
        const icon = icons[log.type] || 'ℹ️';
        // Incluir símbolo do ativo na mensagem
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
          userId, // session_id (usando userId como fallback)
        ];
      });

      // INSERT em batch (muito mais rápido)
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, NOW(3))').join(', ');
      const flatValues = values.flat();

      const result = await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, type, icon, message, details, session_id, timestamp)
         VALUES ${placeholders}`,
        flatValues,
      );
      
      // ✅ Log: Confirmar salvamento
      this.logger.log(`[TRINITY][SaveLogsBatch][${userId}] ✅ ${logs.length} logs salvos com sucesso | Resultado: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error(`[TRINITY][SaveLogsBatch][${userId}] Erro ao salvar logs em batch:`, error);
      // ✅ Log detalhado do erro
      if (error instanceof Error) {
        this.logger.error(`[TRINITY][SaveLogsBatch][${userId}] Erro detalhado: ${error.message}`);
        this.logger.error(`[TRINITY][SaveLogsBatch][${userId}] Stack: ${error.stack}`);
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

