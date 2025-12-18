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
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[TRINITY] Estratégia TRINITY inicializada');
    await this.initializeTrinityWebSockets();
    
    // ✅ Log: Sistema inicializado
    for (const userId of this.trinityUsers.keys()) {
      this.saveTrinityLog(userId, 'SISTEMA', 'info', 
        `Sistema INICIADO | Conectando 3 ativos (R_10, R_25, R_50)...`);
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
    
    // ✅ Log: Usuário ativado
    this.saveTrinityLog(userId, 'SISTEMA', 'info', 
      `Usuário ATIVADO | Modo: ${mode || 'veloz'} | Capital: $${stakeAmount.toFixed(2)} | ` +
      `Martingale: ${modoMartingale || 'conservador'} | ` +
      `Meta: ${profitTarget ? `+$${profitTarget.toFixed(2)}` : 'Não definida'} | ` +
      `Stop-loss: ${lossLimit ? `-$${Math.abs(lossLimit).toFixed(2)}` : 'Não definido'}`, {
        mode: mode || 'veloz',
        capital: stakeAmount,
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
    
    // ✅ Log: Iniciando conexões
    for (const userId of this.trinityUsers.keys()) {
      this.saveTrinityLog(userId, 'SISTEMA', 'info', 
        `Conectando 3 ativos...`);
      for (const symbol of symbols) {
        this.saveTrinityLog(userId, symbol, 'info', `Conectando ao WebSocket...`);
      }
    }
    
    for (const symbol of symbols) {
      if (this.trinityConnected[symbol] && this.trinityWebSockets[symbol]?.readyState === WebSocket.OPEN) {
        continue;
      }
      await this.initializeTrinityWebSocket(symbol);
    }
    
    // ✅ Log: Todas conexões estabelecidas
    const totalConectados = symbols.filter(s => this.trinityConnected[s]).length;
    for (const userId of this.trinityUsers.keys()) {
      this.saveTrinityLog(userId, 'SISTEMA', 'info', 
        `${totalConectados} ativos conectados | Iniciando coleta`);
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
        
        // ✅ Log de conexão para todos os usuários ativos
        for (const userId of this.trinityUsers.keys()) {
          this.saveTrinityLog(userId, symbol, 'info', `Conectado ✅ | Subscrito em ticks`, {
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

    // ✅ Log de tick para todos os usuários ativos
    const tickNumero = this.trinityTicks[symbol].length;
    const tipo = tick.parity;
    for (const userId of this.trinityUsers.keys()) {
      this.saveTrinityLog(userId, symbol, 'tick', 
        `Tick #${tickNumero} | Preço: ${tick.value.toFixed(3)} → Dígito: ${tick.digit} (${tipo})`, {
        tickNumero,
        preco: tick.value,
        digito: tick.digit,
        tipo,
        historicoAtual: tickNumero,
        amostraMinima: 20, // Será ajustado pelo modo
        progresso: `${Math.round((tickNumero / 20) * 100)}%`,
      });
      
      // Log de progresso quando completa amostra
      const state = this.trinityUsers.get(userId);
      if (state) {
        const modeConfig = this.getModeConfig(state.mode);
        if (modeConfig && tickNumero === modeConfig.amostraInicial) {
          this.saveTrinityLog(userId, symbol, 'info', 
            `Coleta: ${tickNumero}/${modeConfig.amostraInicial} ticks (100%) ✅ | Amostra completa`);
        }
      }
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
      
      // ✅ Log: Debug de rotação
      if (this.trinityUsers.size > 0) {
        const firstUserId = Array.from(this.trinityUsers.keys())[0];
        if (firstUserId === userId) { // Log apenas para o primeiro usuário para não poluir
          this.saveTrinityLog(userId, 'SISTEMA', 'info', 
            `Rotação: Próximo ativo = ${nextAsset}, Tick recebido = ${symbol}`, {
              proximoAtivo: nextAsset,
              tickRecebido: symbol,
              currentAssetIndex: state.currentAssetIndex,
            });
        }
      }
      
      // ✅ Se o tick recebido não é do próximo ativo na rotação, pular
      if (nextAsset !== symbol) {
        // Log de prioridade de martingale se aplicável
        const assetInMartingale = ['R_10', 'R_25', 'R_50'].find(
          s => state.assets[s as 'R_10' | 'R_25' | 'R_50'].martingaleStep > 0 && 
               !state.assets[s as 'R_10' | 'R_25' | 'R_50'].isOperationActive
        );
        if (assetInMartingale && assetInMartingale === nextAsset) {
          this.saveTrinityLog(userId, 'SISTEMA', 'info', 
            `Prioridade: ${nextAsset} (martingale ativo) | Pulando rotação normal`, {
              ativoPrioritario: nextAsset,
              motivo: 'martingale_ativo',
            });
        }
        
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
        // ✅ Log: Por que não pode processar
        if (asset.isOperationActive) {
          this.saveTrinityLog(userId, symbol, 'info', 
            `Aguardando resultado da operação anterior...`);
        } else {
          const modeConfig = this.getModeConfig(state.mode);
          if (modeConfig && state.mode === 'veloz' && 'intervaloTicks' in modeConfig && modeConfig.intervaloTicks) {
            if (asset.ticksDesdeUltimaOp < modeConfig.intervaloTicks) {
              this.saveTrinityLog(userId, symbol, 'info', 
                `Aguardando intervalo mínimo: ${asset.ticksDesdeUltimaOp}/${modeConfig.intervaloTicks} ticks`);
            }
          }
        }
        continue;
      }

      // Obter configuração do modo
      const modeConfig = this.getModeConfig(state.mode);
      if (!modeConfig) continue;

      // Verificar amostra mínima
      if (this.trinityTicks[symbol].length < modeConfig.amostraInicial) {
        continue;
      }

      // ✅ Log: Análise iniciada
      this.saveTrinityLog(userId, symbol, 'analise', `ANÁLISE INICIADA | Modo: ${state.mode.toUpperCase()}`);
      
      // Gerar sinal
      const sinal = gerarSinalZenix(this.trinityTicks[symbol], modeConfig, state.mode.toUpperCase());
      
      if (!sinal || !sinal.sinal) {
        // ✅ Log: Sinal rejeitado
        this.saveTrinityLog(userId, symbol, 'alerta', `SINAL REJEITADO | Motivo: ${sinal ? 'Critérios não atendidos' : 'Sem sinal gerado'}`, {
          motivo: sinal ? 'criterios_nao_atendidos' : 'sem_sinal',
          desequilibrio: sinal?.detalhes?.desequilibrio?.desequilibrio ? sinal.detalhes.desequilibrio.desequilibrio * 100 : 0,
          confianca: sinal?.confianca || 0,
        });
        
        // ✅ Sem sinal válido: avançar para próximo ativo na rotação
        this.advanceToNextAsset(state);
        continue;
      }
      
      // ✅ Log: Análises detalhadas (4 análises)
      const detalhes = sinal.detalhes || {};
      
      // Análise 1: Desequilíbrio Estatístico
      if (detalhes.desequilibrio) {
        const deseq = detalhes.desequilibrio;
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        const desequilibrioPerc = (deseq.desequilibrio * 100).toFixed(1);
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 1/4: Desequilíbrio Estatístico | Últimos ${modeConfig.amostraInicial} ticks: ${deseq.percentualPar > deseq.percentualImpar ? percPar : percImpar}% ${deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR'} | Desequilíbrio: ${desequilibrioPerc}% (mínimo: ${(modeConfig.desequilibrioMin * 100).toFixed(0)}%) ✅`, {
          analise: 'desequilibrio',
          janela: modeConfig.amostraInicial,
          pares: Math.round(deseq.percentualPar * modeConfig.amostraInicial),
          impares: Math.round(deseq.percentualImpar * modeConfig.amostraInicial),
          percPar: parseFloat(percPar),
          percImpar: parseFloat(percImpar),
          desequilibrio: parseFloat(desequilibrioPerc),
          desequilibrioMinimo: modeConfig.desequilibrioMin * 100,
          atendeCriterio: true,
          direcao: sinal.sinal,
          confiancaBase: detalhes.confiancaBase || sinal.confianca,
        });
      }
      
      // Análise 2: Sequências Repetidas
      if (detalhes.sequencias) {
        const seq = detalhes.sequencias;
        const bonus = seq.bonus || 0;
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 2/4: Sequências Repetidas | Maior sequência: ${seq.tamanho || 0} ${seq.paridade || ''} consecutivos | Critério: ≥5 consecutivos ${seq.tamanho >= 5 ? '✅' : '❌'} | Bônus: ${bonus > 0 ? '+' : ''}${bonus}% confiança`, {
          analise: 'sequencias',
          maiorSequencia: seq.tamanho || 0,
          tipoSequencia: seq.paridade || '',
          criterioMinimo: 5,
          atendeCriterio: seq.tamanho >= 5,
          bonus,
          confiancaAntes: detalhes.confiancaBase || sinal.confianca,
          confiancaDepois: (detalhes.confiancaBase || sinal.confianca) + bonus,
        });
      }
      
      // Análise 3: Micro-Tendências
      if (detalhes.microTendencias) {
        const micro = detalhes.microTendencias;
        const bonus = micro.bonus || 0;
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 3/4: Micro-Tendências | Diferença: ${(micro.aceleracao ? (micro.aceleracao * 100).toFixed(1) : '0')}% (mínimo: 10%) ${micro.aceleracao > 0.10 ? '✅' : '❌'} | Bônus: ${bonus > 0 ? '+' : ''}${bonus}% confiança`, {
          analise: 'microTendencias',
          aceleracao: micro.aceleracao || 0,
          criterioMinimo: 10,
          atendeCriterio: micro.aceleracao > 0.10,
          bonus,
        });
      }
      
      // Análise 4: Força do Desequilíbrio
      if (detalhes.forca) {
        const forca = detalhes.forca;
        const bonus = forca.bonus || 0;
        this.saveTrinityLog(userId, symbol, 'analise', 
          `Análise 4/4: Força do Desequilíbrio | Ticks consecutivos com desequilíbrio >60%: ${forca.velocidade ? Math.round(forca.velocidade * 100) : 0} | Critério: >5 ticks ${(forca.velocidade || 0) > 0.05 ? '✅' : '❌'} | Bônus: ${bonus > 0 ? '+' : ''}${bonus}% confiança`, {
          analise: 'forca',
          ticksConsecutivos: forca.velocidade ? Math.round(forca.velocidade * 100) : 0,
          criterioMinimo: 5,
          atendeCriterio: (forca.velocidade || 0) > 0.05,
          bonus,
        });
      }
      
      // Log final da análise
      this.saveTrinityLog(userId, symbol, 'analise', 
        `ANÁLISE COMPLETA ✅ | Confiança final: ${sinal.confianca.toFixed(1)}% | Direção: ${sinal.sinal}`, {
          criteriosAtendidos: 4,
          criteriosTotais: 4,
          desequilibrio: detalhes.desequilibrio ? (detalhes.desequilibrio.desequilibrio * 100) : 0,
          sequencia: detalhes.sequencias?.tamanho || 0,
          microTendencia: detalhes.microTendencias ? (detalhes.microTendencias.aceleracao * 100) : 0,
          forca: detalhes.forca ? (detalhes.forca.velocidade * 100) : 0,
          confiancaFinal: sinal.confianca,
          direcao: sinal.sinal,
          sinalValido: true,
        });
      
      // ✅ Log: Sinal gerado
      this.saveTrinityLog(userId, symbol, 'sinal', 
        `SINAL GERADO ✅ | ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}% | ${sinal.motivo}`, {
          direcao: sinal.sinal,
          confianca: sinal.confianca,
          desequilibrio: detalhes.desequilibrio ? (detalhes.desequilibrio.desequilibrio * 100) : 0,
          timestamp: Date.now(),
        });
      
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
        // ✅ Log: Erro ao executar operação
        this.saveTrinityLog(state.userId, symbol, 'erro', 
          `Erro ao executar operação | Não foi possível criar contrato`);
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
      
      // ✅ Log: Operação executada (após ter contractId e tradeId)
      const operacaoNumero = (asset.martingaleStep > 0 ? asset.martingaleStep : 0) + 1;
      this.saveTrinityLog(state.userId, symbol, 'operacao', 
        `OPERAÇÃO #${operacaoNumero} EXECUTADA | ${operation} | $${stakeAmount.toFixed(2)} | ` +
        `Martingale: ${asset.martingaleStep > 0 ? `Nível ${asset.martingaleStep}` : 'Não'} | ` +
        `Contrato: ${contractId}`, {
          operacaoNumero,
          direcao: operation,
          aposta: stakeAmount,
          confianca: 0, // Será preenchido se disponível
          martingale: {
            ativo: asset.martingaleStep > 0,
            nivel: asset.martingaleStep,
          },
          capitalAntes: state.capital,
          contractId,
          tradeId,
          timestamp: Date.now(),
        });

      // ✅ Monitorar contrato e processar resultado
      await this.monitorTrinityContract(contractId, state, symbol, stakeAmount, operation, tradeId);
      
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
              
              const profit = Number(contract.profit || 0);
              const isWin = profit > 0;
              // ✅ Usar exit_spot ou current_spot como a Orion faz
              const exitPrice = Number(contract.exit_spot || contract.exit_tick || contract.exit_tick_display_value || contract.current_spot || 0);
              
              // ✅ Log: Contrato finalizado
              this.saveTrinityLog(state.userId, symbol, 'info', 
                `Contrato FINALIZADO | Profit: $${profit.toFixed(2)} | isWin: ${isWin}`, {
                  contractId,
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
    asset.lastOperationTimestamp = new Date();
    // ✅ Resetar contador de ticks para permitir nova operação
    asset.ticksDesdeUltimaOp = 0;

    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) return;

    if (isWin) {
      // ✅ VITÓRIA
      const lucro = profit > 0 ? profit : stakeAmount * modeConfig.payout;
      const capitalDepois = state.capital + lucro;
      const roi = ((lucro / state.capital) * 100).toFixed(2);
      
      // Atualizar capital
      state.capital += lucro;
      state.totalProfitLoss += lucro;
      
      // ✅ Resetar martingale se estava ativo
      if (asset.martingaleStep > 0) {
        const nivelAntes = asset.martingaleStep;
        const perdaRecuperada = asset.perdaAcumulada;
        
        // ✅ Log: Martingale recuperado
        this.saveTrinityLog(state.userId, symbol, 'info', 
          `MARTINGALE RECUPERADO ✅ | Nível: ${nivelAntes} → 0 (resetado) | Perda recuperada: $${perdaRecuperada.toFixed(2)}`, {
            evento: 'recuperacao',
            nivelAntes,
            nivelDepois: 0,
            perdaRecuperada,
            ganho: lucro,
            lucroLiquido: lucro - perdaRecuperada,
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
      
      // ✅ Log: Resultado vitória
      this.saveTrinityLog(state.userId, symbol, 'resultado', 
        `✅ VITÓRIA! | Aposta: $${stakeAmount.toFixed(2)} | Ganho: $${lucro.toFixed(2)} (payout 95%) | Capital: $${capitalDepois.toFixed(2)} | ROI: +${roi}%`, {
          resultado: 'vitoria',
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
      const roi = ((perda / state.capital) * 100).toFixed(2);
      
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
        
        // ✅ Log: Martingale ativado
        this.saveTrinityLog(state.userId, symbol, 'info', 
          `MARTINGALE ATIVADO | Nível: 1 | Perda acumulada: $${perda.toFixed(2)} | Próxima aposta: $${proximaAposta.toFixed(2)} (modo: ${state.modoMartingale})`, {
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
          // ✅ Log: Martingale incrementado
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `MARTINGALE INCREMENTADO | Nível: ${nivelAntes} → ${asset.martingaleStep} | Perda acumulada: $${perdaAntes.toFixed(2)} → $${asset.perdaAcumulada.toFixed(2)} | Próxima aposta: $${proximaAposta.toFixed(2)}`, {
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
      
      // ✅ Log: Resultado derrota
      this.saveTrinityLog(state.userId, symbol, 'resultado', 
        `❌ DERROTA! | Aposta: $${stakeAmount.toFixed(2)} | Perda: -$${perda.toFixed(2)} | Capital: $${capitalDepois.toFixed(2)} | ROI: -${roi}%`, {
          resultado: 'derrota',
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

    // ✅ Log: Rotação de ativo
    const nextAsset = this.getNextAssetInRotation(state);
    this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
      `Rotação: ${symbol} → ${nextAsset}`, {
        ativoAnterior: symbol,
        ativoProximo: nextAsset,
      });
    
    // ✅ Avançar para próximo ativo na rotação
    this.advanceToNextAsset(state);

    // ✅ Atualizar trade no banco de dados
    if (tradeId) {
      await this.updateTrinityTrade(tradeId, {
        status: isWin ? 'WON' : 'LOST',
        profitLoss: profit,
        exitPrice: exitPrice || 0,
      });
    }

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
    if (state.stopLoss && lucroAtual <= state.stopLoss) {
      state.isStopped = true;
      const roi = ((lucroAtual / state.capitalInicial) * 100).toFixed(2);
      this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
        `STOP-LOSS ATINGIDO! ⚠️ | Stop-loss: -$${Math.abs(state.stopLoss).toFixed(2)} | Perda atual: -$${Math.abs(lucroAtual).toFixed(2)} | ROI: ${roi}% | Parando sistema...`, {
          stopLoss: state.stopLoss,
          perdaAtual: lucroAtual,
          roi: parseFloat(roi),
        });
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

      await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, type, icon, message, details, session_id, timestamp)
         VALUES ${placeholders}`,
        flatValues,
      );
      
      // ✅ Log: Confirmar salvamento
      this.logger.log(`[TRINITY][SaveLogsBatch][${userId}] ✅ ${logs.length} logs salvos com sucesso`);
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

