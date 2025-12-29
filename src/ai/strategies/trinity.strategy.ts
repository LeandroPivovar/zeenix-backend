import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity, CONFIGS_MARTINGALE } from '../ai.service';
import { TradeEventsService } from '../trade-events.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, LENTA_CONFIG, ModoMartingale } from './common.types';
import { gerarSinalZenix } from './signal-generator';
// ✅ REMOVIDO: DerivWebSocketPoolService - não é mais necessário (ticks vêm do AIService)

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
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
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
  
  // ✅ REMOVIDO: WebSockets próprios - agora recebe ticks do AIService (igual Orion)
  // Os WebSockets para ticks são gerenciados pelo AIService
  
  private appId: string;
  private maxTicks = 100; // ✅ Reduzido de 2000 para 100 ticks
  
  // ✅ Sistema de logs (similar à Orion)
  private logQueue: Array<{
    userId: string;
    symbol: 'R_10' | 'R_25' | 'R_50' | 'SISTEMA';
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;
  // ✅ Rastreamento de logs de coleta de dados e intervalos (para evitar duplicações)
  private coletaLogsEnviados = new Map<string, Set<string>>(); // userId -> set de símbolos já logados
  private intervaloLogsEnviados = new Map<string, boolean>(); // chave `${symbol}_${userId}`
  // ✅ Pool de conexões WebSocket por token (reutilização - uma conexão por token)
  private wsConnections: Map<
    string,
    {
      ws: WebSocket;
      authorized: boolean;
      keepAliveInterval: NodeJS.Timeout | null;
      requestIdCounter: number;
      pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }>;
      subscriptions: Map<string, (msg: any) => void>;
    }
  > = new Map();

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[TRINITY] 🔵 Estratégia TRINITY inicializada');
    // ✅ ARQUITETURA IGUAL ORION: Não cria WebSockets próprios
    // Os ticks são recebidos do AIService via StrategyManager.processTick()
    this.logger.log('[TRINITY] ✅ Aguardando ticks do AIService (R_10, R_25, R_50)...');
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

  // ✅ REMOVIDO: Métodos de gerenciamento de WebSocket próprios
  // Agora os ticks são recebidos do AIService via processTick() (igual Orion)
  // Isso evita duplicação de conexões e rate limiting da Deriv

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
        this.logger.debug(`[TRINITY][${symbol}] ⏸️ User ${userId.substring(0, 8)} está parado (isStopped=true)`);
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
        // Log a cada 50 ticks para diagnóstico
        if (this.trinityTicks[symbol].length % 50 === 0) {
          this.logger.debug(`[TRINITY][${symbol}] 🔄 User ${userId.substring(0, 8)} aguardando ativo ${nextAsset} (rotação)`);
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
        // ✅ Log de diagnóstico: Por que não pode processar?
        const reasons: string[] = [];
        if (asset.isOperationActive) reasons.push('operação ativa no ativo');
        if (state.globalOperationActive) reasons.push('operação global ativa');
        if (state.creationCooldownUntil && Date.now() < state.creationCooldownUntil) {
          const remaining = Math.ceil((state.creationCooldownUntil - Date.now()) / 1000);
          reasons.push(`cooldown (${remaining}s restantes)`);
        }
        const modeConfig = this.getModeConfig(state.mode);
        if (modeConfig && state.mode === 'veloz' && 'intervaloTicks' in modeConfig && modeConfig.intervaloTicks) {
          if (asset.ticksDesdeUltimaOp < modeConfig.intervaloTicks) {
            reasons.push(`aguardando intervalo ticks (${asset.ticksDesdeUltimaOp}/${modeConfig.intervaloTicks})`);
          }
        }
        
        // Log a cada 30 ticks para diagnóstico
        if (this.trinityTicks[symbol].length % 30 === 0) {
          this.logger.debug(`[TRINITY][${symbol}] ⏳ User ${userId.substring(0, 8)} não pode processar: ${reasons.join(', ') || 'razão desconhecida'}`);
        }
        continue;
      }

      // Obter configuração do modo
      const modeConfig = this.getModeConfig(state.mode);
      if (!modeConfig) continue;

      // Verificar amostra mínima
      if (this.trinityTicks[symbol].length < modeConfig.amostraInicial) {
        // Log de coleta (apenas uma vez por usuário/ativo)
        const keyUser = userId;
        const set = this.coletaLogsEnviados.get(keyUser) || new Set<string>();
        if (!set.has(symbol)) {
          this.saveTrinityLog(userId, symbol, 'info', 
            `📊 Aguardando ${modeConfig.amostraInicial} ticks para análise | Ticks coletados: ${this.trinityTicks[symbol].length}/${modeConfig.amostraInicial}`);
          set.add(symbol);
          this.coletaLogsEnviados.set(keyUser, set);
        }
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
        const key = `${symbol}_${state.userId}_intervalo_ticks`;
        if (!this.intervaloLogsEnviados.has(key)) {
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `⏱️ Aguardando intervalo entre operações | Ticks: ${asset.ticksDesdeUltimaOp}/${modeConfig.intervaloTicks} (mínimo)`);
          this.intervaloLogsEnviados.set(key, true);
        }
        return false;
      }
    }

    // Verificar intervalo de tempo (modo moderado)
    if (state.mode === 'moderado' && asset.lastOperationTimestamp) {
      const secondsSinceLastOp = (Date.now() - asset.lastOperationTimestamp.getTime()) / 1000;
      if ('intervaloSegundos' in modeConfig && modeConfig.intervaloSegundos && secondsSinceLastOp < modeConfig.intervaloSegundos) {
        const key = `${symbol}_${state.userId}_intervalo_segundos`;
        if (!this.intervaloLogsEnviados.has(key)) {
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `⏱️ Aguardando intervalo de tempo | ${secondsSinceLastOp.toFixed(0)}s / ${modeConfig.intervaloSegundos}s (mínimo)`);
          this.intervaloLogsEnviados.set(key, true);
        }
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
    if (modeLower === 'lenta' || modeLower === 'lento') return LENTA_CONFIG;
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
        lossVirtualActive: existing.lossVirtualActive ?? false,
        lossVirtualCount: existing.lossVirtualCount ?? 0,
        lossVirtualOperation: existing.lossVirtualOperation ?? null,
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
        lossVirtualActive: false,
        lossVirtualCount: 0,
        lossVirtualOperation: null,
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
    
    // ✅ CHECAGENS PRÉ-ENTRADA: meta, stop-loss e stop-blindado (antes de marcar operação ativa)
    const lucroAtual = state.capital - state.capitalInicial;

    // Meta de lucro (profitTarget) antes da entrada
    if (state.profitTarget && lucroAtual >= state.profitTarget) {
      const roi = ((lucroAtual / state.capitalInicial) * 100).toFixed(2);
      this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
        `META DIÁRIA ATINGIDA! 🎉 | Meta: +$${state.profitTarget.toFixed(2)} | Lucro atual: +$${lucroAtual.toFixed(2)} | ROI: +${roi}% | Parando sistema...`, {
          meta: state.profitTarget,
          lucroAtual,
          roi: parseFloat(roi),
        });
      this.logger.log(`[TRINITY] 🎯 META ATINGIDA (pré-entrada) | Lucro: $${lucroAtual.toFixed(2)} | Meta: $${state.profitTarget}`);
      await this.dataSource.query(
        `UPDATE ai_user_config 
         SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
         WHERE user_id = ? AND is_active = 1`,
        [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} (Meta: +$${state.profitTarget.toFixed(2)})`, state.userId],
      );
      this.trinityUsers.delete(state.userId);
      asset.isOperationActive = false;
      state.globalOperationActive = false;
      state.isStopped = true;
      return;
    }

    // Stop-loss global antes da entrada
    if (state.stopLoss && state.stopLoss < 0) {
      const stopLossValue = -Math.abs(state.stopLoss);
      if (lucroAtual < 0 && lucroAtual <= stopLossValue) {
        this.logger.warn(
          `[TRINITY][${symbol}] 🛑 STOP LOSS JÁ ATINGIDO (pré-entrada)! Perda: -$${Math.abs(lucroAtual).toFixed(2)} >= Limite: $${Math.abs(stopLossValue).toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
        );
        this.saveTrinityLog(state.userId, symbol, 'alerta', 
          `🛑 STOP LOSS JÁ ATINGIDO (pré-entrada)! Perda: -$${Math.abs(lucroAtual).toFixed(2)} | Limite: $${Math.abs(stopLossValue).toFixed(2)} - Operação BLOQUEADA`);
        
        state.isStopped = true;
        asset.isOperationActive = false;
        state.globalOperationActive = false;

        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
           WHERE user_id = ? AND is_active = 1`,
          [`Stop loss atingido: -$${Math.abs(lucroAtual).toFixed(2)} (Limite: $${Math.abs(stopLossValue).toFixed(2)})`, state.userId],
        );
        this.trinityUsers.delete(state.userId);
        return;
      }
    }

    // Stop-loss blindado antes da entrada (se ativado e em lucro)
    if (state.stopLossBlindado && lucroAtual > 0) {
      try {
        const configResult = await this.dataSource.query(
          `SELECT COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent
           FROM ai_user_config 
           WHERE user_id = ? AND is_active = 1
           LIMIT 1`,
          [state.userId],
        );

        const stopBlindadoPercent = configResult && configResult.length > 0 
          ? parseFloat(configResult[0].stopBlindadoPercent) || 50.0 
          : 50.0;

        const fatorProtecao = stopBlindadoPercent / 100;
        const stopBlindado = state.capitalInicial + (lucroAtual * fatorProtecao);

        if (state.capital <= stopBlindado) {
          const lucroProtegido = state.capital - state.capitalInicial;
          this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
            `STOP-LOSS BLINDADO ATIVADO (pré-entrada)! 🛡️ | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%) | Lucro protegido: $${lucroProtegido.toFixed(2)} | Parando sistema...`, {
              capital: state.capital,
              stopBlindado,
              stopBlindadoPercent,
              lucroProtegido,
            });
          this.logger.log(`[TRINITY][${symbol}] 🛡️ STOP BLINDADO (pré-entrada) | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%)`);

          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop loss blindado ativado: Capital $${state.capital.toFixed(2)} <= Stop $${stopBlindado.toFixed(2)} (protegendo ${stopBlindadoPercent}% do lucro)`, state.userId],
          );

          state.isStopped = true;
          asset.isOperationActive = false;
          state.globalOperationActive = false;
          this.trinityUsers.delete(state.userId);
          return;
        }
      } catch (error) {
        this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao verificar stop-loss blindado (pré-entrada):`, error);
        // Em caso de erro, continuar para não travar operação
      }
    }

    // ✅ VERIFICAR STOP LOSS ANTES DE QUALQUER OPERAÇÃO
    if (state.stopLoss && state.stopLoss < 0) {
      const stopLossValue = -Math.abs(state.stopLoss);
      
      // Se já atingiu o stop loss, bloquear operação
      if (lucroAtual < 0 && lucroAtual <= stopLossValue) {
        this.logger.warn(
          `[TRINITY][${symbol}] 🛑 STOP LOSS JÁ ATINGIDO! Perda: -$${Math.abs(lucroAtual).toFixed(2)} >= Limite: $${Math.abs(stopLossValue).toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
        );
        this.saveTrinityLog(state.userId, symbol, 'alerta', 
          `🛑 STOP LOSS JÁ ATINGIDO! Perda: -$${Math.abs(lucroAtual).toFixed(2)} | Limite: $${Math.abs(stopLossValue).toFixed(2)} - Operação BLOQUEADA`);
        
        state.isStopped = true;
        asset.isOperationActive = false;
        state.globalOperationActive = false;
        return; // NÃO EXECUTAR OPERAÇÃO
      }
      
      // ✅ Verificar se a próxima aposta do martingale ultrapassaria o stop loss
      if (asset.martingaleStep > 0) {
        const modeConfig = this.getModeConfig(state.mode);
        if (modeConfig) {
          const proximaAposta = calcularProximaAposta(
            asset.perdaAcumulada,
            state.modoMartingale,
            modeConfig.payout * 100,
            state.modoMartingale === 'agressivo' ? asset.ultimaApostaUsada : 0,
          );
          
          const perdaTotalPotencial = Math.abs(lucroAtual) + proximaAposta;
          const limiteStopLoss = Math.abs(stopLossValue);
          
          if (perdaTotalPotencial > limiteStopLoss) {
            this.logger.warn(
              `[TRINITY][${symbol}] ⚠️ Martingale bloqueado! Próxima: $${proximaAposta.toFixed(2)} | Perda atual: $${Math.abs(lucroAtual).toFixed(2)} | Total: $${perdaTotalPotencial.toFixed(2)} > Limite: $${limiteStopLoss.toFixed(2)}`,
            );
            this.saveTrinityLog(state.userId, symbol, 'alerta', 
              `⚠️ Martingale bloqueado! Próxima aposta ($${proximaAposta.toFixed(2)}) ultrapassaria stop loss de $${limiteStopLoss.toFixed(2)}`);
            
            // Resetar martingale do ativo
            asset.perdaAcumulada = 0;
            asset.martingaleStep = 0;
            
            // Avançar para próximo ativo
            this.advanceToNextAsset(state);
            asset.isOperationActive = false;
            state.globalOperationActive = false;
            return;
          }
        }
      }
    }
    
    // Marcar como operação ativa
    asset.isOperationActive = true;
    state.globalOperationActive = true;
    
    // Resetar contador de ticks
    asset.ticksDesdeUltimaOp = 0;
    // Limpar logs de intervalo para permitir novo aviso se necessário
    this.intervaloLogsEnviados.delete(`${symbol}_${state.userId}_intervalo_ticks`);
    this.intervaloLogsEnviados.delete(`${symbol}_${state.userId}_intervalo_segundos`);
    
    // Calcular stake (considerar martingale isolado do ativo)
    const modeConfig = this.getModeConfig(state.mode);
    if (!modeConfig) {
      asset.isOperationActive = false;
      return;
    }

    let stakeAmount = asset.apostaInicial;
    
    // ✅ Se está em martingale, verificar limite ANTES de calcular próxima aposta
    if (asset.martingaleStep > 0) {
      // Fórmulas da documentação (Conservador: reset após 5 perdas; Moderado: perda/0.95; Agressivo: (perda+última)/0.95)
      const payoutCliente = modeConfig.payout; // ex: 0.95

      // Limite conservador: resetar após 5 perdas consecutivas
      // Se martingaleStep >= 5, já teve 5 perdas, reseta antes de tentar a 6ª
      if (state.modoMartingale === 'conservador' && asset.martingaleStep >= 5) {
        this.saveTrinityLog(state.userId, symbol, 'alerta',
          `🛑 MARTINGALE RESETADO (CONSERVADOR) | 5 perdas consecutivas alcançadas | Perdendo: $${asset.perdaAcumulada.toFixed(2)} | Voltando para aposta inicial`);
        this.logger.warn(`[TRINITY][${symbol}] ⚠️ Conservador: resetando martingale após 5 perdas consecutivas`);
        asset.martingaleStep = 0;
        asset.perdaAcumulada = 0;
        asset.apostaInicial = asset.apostaBase;
        stakeAmount = asset.apostaBase;
      } else {
        // Calcular próxima aposta conforme modo
        const perdas = asset.perdaAcumulada;
        if (state.modoMartingale === 'conservador') {
          stakeAmount = perdas / payoutCliente;
        } else if (state.modoMartingale === 'moderado') {
          stakeAmount = perdas / payoutCliente; // break-even
        } else {
          // agressivo
          const ultima = asset.ultimaApostaUsada || asset.apostaInicial || 0.35;
          stakeAmount = (perdas + ultima) / payoutCliente;
        }
      }

      // Stop-loss global: se ultrapassar, reduzir para não estourar (mantém aposta base)
      const stopLossDisponivel = this.calculateAvailableStopLoss(state);
      if (stopLossDisponivel > 0 && stakeAmount > stopLossDisponivel) {
        const ajustada = Math.max(0.35, Math.min(asset.apostaBase, stopLossDisponivel));
        this.logger.warn(`[TRINITY][${symbol}] ⚠️ Aposta ajustada para respeitar stop-loss global: $${ajustada.toFixed(2)} (antes: $${stakeAmount.toFixed(2)})`);
        this.saveTrinityLog(state.userId, symbol, 'alerta',
          `⚠️ Aposta reduzida para respeitar stop-loss global | De: $${stakeAmount.toFixed(2)} Para: $${ajustada.toFixed(2)} | Stop disponível: $${stopLossDisponivel.toFixed(2)}`);
        stakeAmount = ajustada;
      }
    }

    // ✅ Ajuste final: limitar a 2 casas decimais e mínimo 0.35 (erro da Deriv se >2 casas)
    stakeAmount = Math.max(0.35, Number(stakeAmount.toFixed(2)));

    const contractType = operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
    
    // ✅ VALIDAÇÕES IGUAL ORION (antes de criar WebSocket)
    
    // 1. Validar valor mínimo ($0.35)
    if (stakeAmount < 0.35) {
      this.logger.warn(`[TRINITY][${symbol}] ⚠️ Stake abaixo do mínimo, ajustando para $0.35`);
      stakeAmount = 0.35;
    }
    
    // 2. Validar saldo mínimo (com margem de 10%)
    const saldoNecessario = stakeAmount * 1.1;
    if (state.capital < saldoNecessario) {
      this.logger.warn(`[TRINITY][${symbol}] ❌ Saldo insuficiente | Capital: $${state.capital.toFixed(2)} | Necessário: $${saldoNecessario.toFixed(2)}`);
      this.saveTrinityLog(state.userId, symbol, 'erro', `❌ Saldo insuficiente | Capital: $${state.capital.toFixed(2)} | Necessário: $${saldoNecessario.toFixed(2)}`);
      asset.isOperationActive = false;
      state.globalOperationActive = false;
      this.advanceToNextAsset(state);
      return;
    }
    
    // 3. Validar token
    if (!state.derivToken || state.derivToken.trim() === '') {
      this.logger.error(`[TRINITY][${symbol}] ❌ Token Deriv inválido ou ausente`);
      this.saveTrinityLog(state.userId, symbol, 'erro', `❌ Token Deriv inválido ou ausente - Não é possível criar contrato`);
      asset.isOperationActive = false;
      state.globalOperationActive = false;
      this.advanceToNextAsset(state);
      return;
    }
    
    // Salvar aposta usada para cálculo agressivo
    asset.ultimaApostaUsada = stakeAmount;
    
    this.logger.log(
      `[TRINITY][${symbol}] 🎲 EXECUTANDO | User: ${state.userId} | ` +
      `Operação: ${operation} | Stake: $${stakeAmount.toFixed(2)} | ` +
      `Martingale: ${asset.martingaleStep > 0 ? `Nível ${asset.martingaleStep}` : 'Não'}`,
    );

    try {
      // ✅ PREVISÃO: Armazenar informações do trade para previsão no próximo tick
      const entryPrice = this.trinityTicks[symbol].length > 0 
        ? this.trinityTicks[symbol][this.trinityTicks[symbol].length - 1].value 
        : 0;
      
      // Criar registro de trade ANTES de executar (para ter o ID)
      const tradeId = await this.saveTrinityTrade({
        userId: state.userId,
        contractId: null, // Será preenchido depois
        symbol,
        contractType,
        entryPrice,
        stakeAmount,
        operation,
        mode: state.mode,
      });

      // ✅ Executar trade E monitorar no MESMO WebSocket (mais rápido para contratos de 1 tick)
      const result = await this.executeTrinityTradeDirect(
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

      if (!result) {
        asset.isOperationActive = false;
        state.globalOperationActive = false;
        state.creationCooldownUntil = Date.now() + 5000;
        this.saveTrinityLog(state.userId, symbol, 'erro', `Erro ao executar operação | Não foi possível criar contrato`);
        this.advanceToNextAsset(state);
        return;
      }

      // ✅ Resultado já veio do mesmo WebSocket - processar diretamente
      const { contractId, profit, exitSpot } = result;
      const exitPrice = Number(exitSpot || 0);
      const confirmedStatus = profit > 0 ? 'WON' : 'LOST';

      // ✅ Atualizar trade com contractId
      await this.updateTrinityTrade(tradeId, state.userId, {
        contractId,
      });

      // Atualizar trade com resultado
      await this.updateTrinityTrade(tradeId, state.userId, {
        status: confirmedStatus,
        profitLoss: profit,
        exitPrice,
      });

      this.logger.log(`[TRINITY][${symbol}] ${confirmedStatus} | User: ${state.userId} | P&L: $${profit.toFixed(2)}`);
      
      // ✅ Processar resultado (Martingale)
      await this.processTrinityResult(state, symbol, confirmedStatus === 'WON', stakeAmount, operation, profit, exitPrice, tradeId);
      
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] Erro ao executar operação:`, error);
      asset.isOperationActive = false;
      state.globalOperationActive = false;
      state.creationCooldownUntil = Date.now() + 5000; // 5s cooldown após erro
      this.advanceToNextAsset(state);
    }
  }

  /**
   * ✅ TRINITY: Executa trade via WebSocket E monitora resultado no MESMO WebSocket
   * Retorna o resultado completo (contractId, profit, exitSpot) ou null se falhar
   */
  private async executeTrinityTradeDirect(
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_50',
    token: string,
    contractParams: any,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    const tokenPreview = token ? `${token.substring(0, 10)}...${token.substring(token.length - 5)}` : 'NULL';
    this.logger.log(`[TRINITY][${symbol}] 🔄 Iniciando criação de contrato (pool) | Token: ${tokenPreview} | Tipo: ${contractParams.contract_type}`);

    try {
      const connection = await this.getOrCreateWebSocketConnection(token, userId, symbol);

      const proposalStartTime = Date.now();
      this.logger.debug(`[TRINITY][${symbol}] 📤 [${userId}] Solicitando proposta | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);

      const proposalResponse: any = await connection.sendRequest({
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: contractParams.symbol,
      }, 60000);

      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        const errorCode = errorObj?.code || '';
        const errorMessage = errorObj?.message || JSON.stringify(errorObj);
        this.logger.error(`[TRINITY][${symbol}] ❌ Erro na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);
        this.saveTrinityLog(userId, symbol, 'erro', `❌ Erro na proposta da Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`);
        if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
          this.saveTrinityLog(userId, symbol, 'alerta', `💡 Saldo insuficiente na Deriv.`);
        } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
          this.saveTrinityLog(userId, symbol, 'alerta', `💡 Rate limit atingido na Deriv.`);
        }
        return null;
      }

      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);
      if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
        this.logger.error(`[TRINITY][${symbol}] ❌ Proposta inválida recebida: ${JSON.stringify(proposalResponse)}`);
        this.saveTrinityLog(userId, symbol, 'erro', `❌ Proposta inválida da Deriv | Resposta: ${JSON.stringify(proposalResponse)}`);
        return null;
      }

      const proposalDuration = Date.now() - proposalStartTime;
      this.logger.debug(`[TRINITY][${symbol}] 📊 [${userId}] Proposta em ${proposalDuration}ms | ID=${proposalId}, Preço=${proposalPrice} | Comprando...`);

      const buyStartTime = Date.now();
      let buyResponse: any;
      try {
        buyResponse = await connection.sendRequest({
          buy: proposalId,
          price: proposalPrice,
        }, 60000);
      } catch (error: any) {
        const errorMessage = error?.message || JSON.stringify(error);
        this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao comprar contrato: ${errorMessage} | ProposalId: ${proposalId}`);
        this.saveTrinityLog(userId, symbol, 'erro', `❌ Erro ao comprar contrato: ${errorMessage}`);
        return null;
      }

      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        const errorCode = buyErrorObj?.code || '';
        const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);
        this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao comprar contrato: ${JSON.stringify(buyErrorObj)} | ProposalId: ${proposalId}`);
        this.saveTrinityLog(userId, symbol, 'erro', `❌ Erro ao comprar contrato | Código: ${errorCode} | Mensagem: ${errorMessage}`);
        if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
          this.saveTrinityLog(userId, symbol, 'alerta', `💡 Saldo insuficiente na Deriv.`);
        } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
          this.saveTrinityLog(userId, symbol, 'alerta', `💡 Rate limit atingido na Deriv.`);
        }
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[TRINITY][${symbol}] ❌ Contrato criado mas sem contract_id: ${JSON.stringify(buyResponse)}`);
        this.saveTrinityLog(userId, symbol, 'erro', `❌ Contrato criado mas sem contract_id | Resposta: ${JSON.stringify(buyResponse)}`);
        return null;
      }

      const buyDuration = Date.now() - buyStartTime;
      this.logger.log(`[TRINITY][${symbol}] ✅ Contrato criado | Proposal: ${proposalDuration}ms | Compra: ${buyDuration}ms | ContractId: ${contractId}`);
      this.saveTrinityLog(userId, symbol, 'operacao', `✅ Contrato criado: ${contractId} | Proposta: ${proposalDuration}ms | Compra: ${buyDuration}ms`);

      const monitorStartTime = Date.now();
      let firstUpdateTime: number | null = null;
      let lastUpdateTime: number | null = null;
      let updateCount = 0;

      return await new Promise((resolve) => {
        let hasResolved = false;
        let contractMonitorTimeout: NodeJS.Timeout | null = null;

        contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[TRINITY][${symbol}] ⏱️ Timeout ao monitorar contrato (90s) | ContractId: ${contractId}`);
            this.saveTrinityLog(userId, symbol, 'erro', `⏱️ Contrato ${contractId} não finalizou em 90 segundos`);
            connection.removeSubscription(contractId);
            resolve(null);
          }
        }, 90000);

        connection.subscribe(
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          (msg: any) => {
            try {
              if (msg.error) {
                this.logger.error(`[TRINITY][${symbol}] ❌ Erro na subscription do contrato ${contractId}: ${JSON.stringify(msg.error)}`);
                if (!hasResolved) {
                  hasResolved = true;
                  if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                  connection.removeSubscription(contractId);
                  resolve(null);
                }
                return;
              }

              const contract = msg.proposal_open_contract;
              if (!contract) return;

              const now = Date.now();
              updateCount++;

              if (!firstUpdateTime) {
                firstUpdateTime = now;
                const timeToFirstUpdate = firstUpdateTime - monitorStartTime;
                this.logger.log(`[TRINITY][${symbol}] ⚡ Primeira atualização em ${timeToFirstUpdate}ms | Contrato: ${contractId}`);
              }

              if (lastUpdateTime) {
                const timeSinceLastUpdate = now - lastUpdateTime;
                this.logger.debug(`[TRINITY][${symbol}] ⏱️ Update #${updateCount} | Δt=${timeSinceLastUpdate}ms | Total=${now - monitorStartTime}ms`);
              }
              lastUpdateTime = now;

              const isFinalized =
                contract.is_sold === 1 ||
                contract.is_sold === true ||
                contract.status === 'won' ||
                contract.status === 'lost' ||
                contract.status === 'sold';

              if (isFinalized && !hasResolved) {
                hasResolved = true;
                if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);

                const profit = Number(contract.profit || 0);
                const exitSpot = contract.exit_spot || contract.current_spot;
                const monitorDuration = Date.now() - monitorStartTime;
                const timeToFirstUpdate = firstUpdateTime ? firstUpdateTime - monitorStartTime : 0;
                const avgUpdateInterval = lastUpdateTime && updateCount > 1
                  ? (lastUpdateTime - (firstUpdateTime || monitorStartTime)) / (updateCount - 1)
                  : 0;

                this.logger.log(`[TRINITY][${symbol}] ✅ Contrato ${contractId} finalizado em ${monitorDuration}ms | Profit: $${profit.toFixed(2)} | Status: ${contract.status}`);
                this.logger.log(`[TRINITY][${symbol}] 📈 Performance: Primeira atualização: ${timeToFirstUpdate}ms | Total updates: ${updateCount} | Intervalo médio: ${avgUpdateInterval.toFixed(0)}ms`);
                this.saveTrinityLog(userId, symbol, 'resultado', `✅ Contrato finalizado em ${monitorDuration}ms | Primeira atualização: ${timeToFirstUpdate}ms | Total: ${updateCount} atualizações`);

                connection.removeSubscription(contractId);
                resolve({ contractId, profit, exitSpot });
              }
            } catch (error) {
              if (!hasResolved) {
                hasResolved = true;
                if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao processar atualização do contrato:`, error);
                this.saveTrinityLog(userId, symbol, 'erro', `Erro ao processar atualização do contrato ${contractId} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
                connection.removeSubscription(contractId);
                resolve(null);
              }
            }
          },
          contractId,
          90000,
        ).catch((error) => {
          if (!hasResolved) {
            hasResolved = true;
            if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
            this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao inscrever no contrato ${contractId}:`, error);
            this.saveTrinityLog(userId, symbol, 'erro', `Erro ao inscrever no contrato ${contractId} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            resolve(null);
          }
        });
      });
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao executar trade via WebSocket (pool):`, error);
      this.saveTrinityLog(userId, symbol, 'erro', `Erro ao executar trade | Tipo: ${contractParams.contract_type} | Valor: ${contractParams.amount} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      return null;
    }
  }

  // ✅ REMOVIDO: monitorTrinityContract - agora o monitoramento é feito no mesmo WebSocket em executeTrinityTradeDirect

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
      // Resetar loss virtual
      if (state.lossVirtualActive || state.lossVirtualCount > 0) {
        this.saveTrinityLog(state.userId, symbol, 'info',
          `✅ LOSS VIRTUAL DESATIVADO | Vitórias após ${state.lossVirtualCount} derrotas seguidas | Voltando ao modo normal`);
      }
      state.lossVirtualActive = false;
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = null;
      
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
        // Loss virtual: contar perdas seguidas para acionar modo de segurança virtual
        state.lossVirtualCount = (state.lossVirtualCount || 0) + 1;
        state.lossVirtualOperation = operation;
        if (!state.lossVirtualActive && state.lossVirtualCount >= 2) {
          state.lossVirtualActive = true;
          this.saveTrinityLog(state.userId, symbol, 'alerta',
            `⚠️ LOSS VIRTUAL ATIVADO | ${state.lossVirtualCount} derrotas seguidas | Operação virtual até recuperar confiança`);
        }
        
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
        // Já estava em martingale: verificar limite ANTES de incrementar
        const nivelAntes = asset.martingaleStep;
        const perdaAntes = asset.perdaAcumulada;
        const config = CONFIGS_MARTINGALE[state.modoMartingale];
        
        // ✅ ZENIX v2.0: Verificar limite de entradas ANTES de incrementar
        // Conservador: máximo 5 perdas consecutivas (permite até nível 5, reseta quando nivelAntes >= 5 para evitar a 6ª)
        // Moderado/Agressivo: infinito (maxEntradas = Infinity)
        // Documentação: "Reseta após 5 perdas consecutivas" = permite até 5 perdas (nível 5),
        // quando nivelAntes >= 5 (já teve 5 perdas), reseta antes de tentar a 6ª
        if (state.modoMartingale === 'conservador' && nivelAntes >= 5) {
          // Limite conservador (doc): resetar após 5 perdas consecutivas
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `MARTINGALE RESETADO (CONSERVADOR) | 5 perdas consecutivas alcançadas (limite atingido) | Perdendo: $${(asset.perdaAcumulada + perda).toFixed(2)} | Voltando para aposta inicial`, {
              evento: 'reset',
              motivo: 'limite_conservador_5',
              nivelAntes,
              nivelDepois: 0,
              perdaAceita: asset.perdaAcumulada + perda,
            });
          
          this.logger.warn(`[TRINITY][${symbol}] ⚠️ CONSERVADOR: Resetando martingale após 5 perdas consecutivas`);
          asset.martingaleStep = 0;
          asset.perdaAcumulada = 0;
          asset.apostaInicial = asset.apostaBase;
          return;
        }
        if (config.maxEntradas !== Infinity && nivelAntes >= config.maxEntradas) {
          // Limite atingido: resetar martingale
          this.saveTrinityLog(state.userId, symbol, 'info', 
            `MARTINGALE RESETADO (${state.modoMartingale.toUpperCase()}) | Limite de ${config.maxEntradas} entradas atingido`, {
              evento: 'reset',
              motivo: 'limite_entradas',
              nivelAntes,
              nivelDepois: 0,
              perdaAceita: asset.perdaAcumulada + perda,
            });
          
          this.logger.warn(
            `[TRINITY][${symbol}] ⚠️ ${state.modoMartingale.toUpperCase()}: Resetando após ${config.maxEntradas} entradas (limite atingido)`,
          );
          asset.martingaleStep = 0;
          asset.perdaAcumulada = 0;
          asset.apostaInicial = asset.apostaBase;
          return; // Não incrementar, já resetou
        }
        
        // Incrementar nível (ainda dentro do limite)
        asset.martingaleStep += 1;
        asset.perdaAcumulada += perda;
        state.lossVirtualCount = (state.lossVirtualCount || 0) + 1;
        state.lossVirtualOperation = operation;
        if (!state.lossVirtualActive && state.lossVirtualCount >= 2) {
          state.lossVirtualActive = true;
          this.saveTrinityLog(state.userId, symbol, 'alerta',
            `⚠️ LOSS VIRTUAL ATIVADO | ${state.lossVirtualCount} derrotas seguidas | Operação virtual até recuperar confiança`);
        }
        
        // Calcular próxima aposta
        const proximaAposta = calcularProximaAposta(
          asset.perdaAcumulada,
          state.modoMartingale,
          modeConfig.payout * 100,
          state.modoMartingale === 'agressivo' ? asset.ultimaApostaUsada : 0,
        );
        
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
      
      // ✅ Desativar sessão no banco de dados
      try {
        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
           WHERE user_id = ? AND is_active = 1`,
          [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} (Meta: +$${state.profitTarget.toFixed(2)})`, state.userId],
        );
        this.logger.log(`[TRINITY] ✅ Sessão desativada para usuário ${state.userId} devido à meta de lucro atingida`);
      } catch (error) {
        this.logger.error(`[TRINITY] ❌ Erro ao desativar sessão:`, error);
      }
      
      // Remover usuário do monitoramento
      this.trinityUsers.delete(state.userId);
      
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
      
      // ✅ Desativar sessão no banco de dados
      try {
        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
           WHERE user_id = ? AND is_active = 1`,
          [`Stop loss atingido: -$${Math.abs(lucroAtual).toFixed(2)} (Limite: $${Math.abs(stopLossValue).toFixed(2)})`, state.userId],
        );
        this.logger.log(`[TRINITY] ✅ Sessão desativada para usuário ${state.userId} devido ao stop loss`);
      } catch (error) {
        this.logger.error(`[TRINITY] ❌ Erro ao desativar sessão:`, error);
      }
      
      // Remover usuário do monitoramento
      this.trinityUsers.delete(state.userId);
      
      return;
    }

    // ✅ Verificar STOP-LOSS BLINDADO (protege X% do lucro conforme configurado)
    if (state.stopLossBlindado && lucroAtual > 0) {
      // ✅ ZENIX v2.0: Buscar percentual do banco (padrão 50% se não configurado)
      try {
        const configResult = await this.dataSource.query(
          `SELECT COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent
           FROM ai_user_config 
           WHERE user_id = ? AND is_active = 1
           LIMIT 1`,
          [state.userId],
        );
        
        const stopBlindadoPercent = configResult && configResult.length > 0 
          ? parseFloat(configResult[0].stopBlindadoPercent) || 50.0 
          : 50.0; // Padrão 50% se não encontrar
        
        const fatorProtecao = stopBlindadoPercent / 100; // 50% → 0.5
        const stopBlindado = state.capitalInicial + (lucroAtual * fatorProtecao);
        
        if (state.capital <= stopBlindado) {
          const lucroProtegido = state.capital - state.capitalInicial;
          state.isStopped = true;
          this.saveTrinityLog(state.userId, 'SISTEMA', 'info', 
            `STOP-LOSS BLINDADO ATIVADO! 🛡️ | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%) | Lucro protegido: $${lucroProtegido.toFixed(2)} | Parando sistema...`, {
              capital: state.capital,
              stopBlindado,
              stopBlindadoPercent,
              lucroProtegido,
            });
          this.logger.log(
            `[TRINITY] 🛡️ STOP-LOSS BLINDADO ATIVADO! | Capital: $${state.capital.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%)`,
          );
          
          // ✅ Desativar sessão no banco de dados
          try {
            await this.dataSource.query(
              `UPDATE ai_user_config 
               SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
               WHERE user_id = ? AND is_active = 1`,
              [`Stop loss blindado ativado: Capital $${state.capital.toFixed(2)} <= Stop $${stopBlindado.toFixed(2)} (protegendo ${stopBlindadoPercent}% do lucro)`, state.userId],
            );
            this.logger.log(`[TRINITY] ✅ Sessão desativada para usuário ${state.userId} devido ao stop loss blindado`);
          } catch (error) {
            this.logger.error(`[TRINITY] ❌ Erro ao desativar sessão:`, error);
          }
          
          // Remover usuário do monitoramento
          this.trinityUsers.delete(state.userId);
          
          return;
        }
      } catch (error) {
        this.logger.error(`[TRINITY] ❌ Erro ao verificar stop-loss blindado:`, error);
        // Continuar operação se houver erro ao buscar configuração
      }
    }
  }

  /**
   * ✅ TRINITY: Salva trade no banco de dados (status PENDING)
   */
  private async saveTrinityTrade(trade: {
    userId: string;
    contractId: string | null;
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
    tradeId: number | null,
    userId: string,
    update: {
      contractId?: string | null;
      status?: 'WON' | 'LOST' | 'PENDING';
      profitLoss?: number;
      exitPrice?: number;
    }
  ): Promise<void> {
    if (!tradeId) {
      this.logger.warn(`[TRINITY] ⚠️ Tentativa de atualizar trade com ID null`);
      return;
    }
    try {
      // Construir query dinamicamente baseado nos campos fornecidos
      const updates: string[] = [];
      const values: any[] = [];

      if (update.contractId !== undefined) {
        updates.push('contract_id = ?');
        values.push(update.contractId);
      }
      if (update.status !== undefined) {
        updates.push('status = ?');
        values.push(update.status);
      }
      if (update.profitLoss !== undefined) {
        updates.push('profit_loss = ?');
        values.push(update.profitLoss);
      }
      if (update.exitPrice !== undefined) {
        updates.push('exit_price = ?');
        values.push(update.exitPrice);
      }
      
      // Se status foi atualizado para WON ou LOST, adicionar closed_at
      if (update.status === 'WON' || update.status === 'LOST') {
        updates.push('closed_at = NOW()');
      }

      if (updates.length === 0) {
        this.logger.warn(`[TRINITY] ⚠️ Nenhum campo para atualizar no trade ID=${tradeId}`);
        return;
      }

      values.push(tradeId);

      await this.dataSource.query(
        `UPDATE ai_trades 
         SET ${updates.join(', ')}
         WHERE id = ?`,
        values
      );
      
      const logMsg = `[TRINITY] ✅ Trade atualizado no banco: ID=${tradeId}`;
      if (update.status) {
        this.logger.log(`${logMsg}, Status=${update.status}`);
      } else {
        this.logger.log(logMsg);
      }

      // Emitir evento apenas se houver status ou profitLoss
      if (update.status || update.profitLoss !== undefined) {
        this.tradeEvents.emit({
          userId,
          type: 'updated',
          tradeId,
          status: update.status,
          strategy: 'trinity',
          profitLoss: update.profitLoss,
          exitPrice: update.exitPrice,
        });
      }
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

      // ✅ Emitir evento SSE para atualizar front (qualquer novo log)
      this.tradeEvents.emit({
        userId,
        type: 'updated',
        strategy: 'trinity',
        status: 'LOG',
      });
    } catch (error) {
      this.logger.error(`[TRINITY][SaveLogsBatch][${userId}] Erro ao salvar logs em batch:`, error);
      // ✅ Log detalhado do erro
      if (error instanceof Error) {
        this.logger.error(`[TRINITY][SaveLogsBatch][${userId}] Erro detalhado: ${error.message}`);
        this.logger.error(`[TRINITY][SaveLogsBatch][${userId}] Stack: ${error.stack}`);
      }
    }
  }

  /**
   * ✅ Obtém ou cria conexão WebSocket reutilizável por token (com keep-alive)
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string, symbol?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    const existing = this.wsConnections.get(token);
    if (existing && existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
      return {
        ws: existing.ws,
        sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
        subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
          this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
        removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
      };
    }

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.logger.log(`[TRINITY][${symbol || 'POOL'}] 🔌 Abrindo WebSocket reutilizável: ${endpoint}`);

    const socket = new WebSocket(endpoint, {
      headers: { Origin: 'https://app.deriv.com' },
    });

    let authResolved = false;
    let connectionTimeout: NodeJS.Timeout | null = null;

    // Registrar conexão imediatamente para evitar accesso undefined antes do 'open'
    const connInit = {
      ws: socket,
      authorized: false,
      keepAliveInterval: null as NodeJS.Timeout | null,
      requestIdCounter: 0,
      pendingRequests: new Map(),
      subscriptions: new Map(),
    };
    this.wsConnections.set(token, connInit);

    connectionTimeout = setTimeout(() => {
      if (!authResolved) {
        authResolved = true;
        socket.close();
        this.wsConnections.delete(token);
      }
    }, 30000);

    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const conn = this.wsConnections.get(token);
        if (!conn) {
          this.logger.warn(`[TRINITY][${symbol || 'POOL'}] ⚠️ Mensagem recebida sem conexão no pool para token ${token.substring(0, 8)}`);
          return;
        }

        if (msg.msg_type === 'authorize' && !authResolved) {
          authResolved = true;
          if (connectionTimeout) clearTimeout(connectionTimeout);

          if (msg.error || (msg.authorize && msg.authorize.error)) {
            const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autorização';
            this.logger.error(`[TRINITY][${symbol || 'POOL'}] ❌ Erro na autorização: ${errorMsg}`);
            socket.close();
            this.wsConnections.delete(token);
            return;
          }

          conn.authorized = true;
          this.logger.log(`[TRINITY][${symbol || 'POOL'}] ✅ Autorizado | LoginID: ${msg.authorize?.loginid || 'N/A'}`);

          conn.keepAliveInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              try {
                socket.send(JSON.stringify({ ping: 1 }));
                this.logger.debug(`[TRINITY][KeepAlive][${token.substring(0, 8)}] Ping enviado`);
              } catch {
                // ignorar
              }
            }
          }, 90000);
          return;
        }

        if (msg.proposal_open_contract) {
          const contractId = msg.proposal_open_contract.contract_id;
          if (contractId && conn.subscriptions.has(contractId)) {
            const callback = conn.subscriptions.get(contractId)!;
            callback(msg);
            return;
          }
        }

        if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
          const firstKey = conn.pendingRequests.keys().next().value;
          if (firstKey) {
            const pending = conn.pendingRequests.get(firstKey);
            if (pending) {
              clearTimeout(pending.timeout);
              conn.pendingRequests.delete(firstKey);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                pending.resolve(msg);
              }
            }
          }
          return;
        }
      } catch {
        // Ignorar erros de parse
      }
    });

    socket.on('open', () => {
      this.logger.log(`[TRINITY][${symbol || 'POOL'}] ✅ WebSocket conectado, enviando autorização...`);
      const conn = this.wsConnections.get(token)!;
      socket.send(JSON.stringify({ authorize: token }));
    });

    socket.on('error', () => {
      if (!authResolved) {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        authResolved = true;
        this.wsConnections.delete(token);
      }
    });

    socket.on('close', () => {
      const conn = this.wsConnections.get(token);
      if (conn) {
        if (conn.keepAliveInterval) clearInterval(conn.keepAliveInterval);
        conn.pendingRequests.forEach((pending) => {
          clearTimeout(pending.timeout);
          pending.reject(new Error('WebSocket fechado'));
        });
        conn.subscriptions.clear();
      }
      this.wsConnections.delete(token);
      if (!authResolved) {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        authResolved = true;
      }
    });

    const conn = this.wsConnections.get(token)!;
    return {
      ws: conn.ws,
      sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
      subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) =>
        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
      removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
    };
  }

  /**
   * ✅ Envia requisição via conexão existente
   */
  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    return new Promise((resolve, reject) => {
      const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });
      conn.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * ✅ Inscreve-se para atualizações via conexão existente
   */
  private async subscribeViaConnection(
    token: string,
    payload: any,
    callback: (msg: any) => void,
    subId: string,
    timeoutMs: number,
  ): Promise<void> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível ou autorizada');
    }

    const timeout = setTimeout(() => {
      conn.subscriptions.delete(subId);
    }, timeoutMs);

    conn.subscriptions.set(subId, (msg: any) => {
      clearTimeout(timeout);
      callback(msg);
    });

    conn.ws.send(JSON.stringify(payload));
  }

  /**
   * ✅ Remove subscription da conexão
   */
  private removeSubscriptionFromConnection(token: string, subId: string): void {
    const conn = this.wsConnections.get(token);
    if (conn) {
      conn.subscriptions.delete(subId);
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

