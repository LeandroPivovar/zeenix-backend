import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { TradeEventsService } from '../trade-events.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, ModoMartingale } from './common.types';
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
  // ✅ PREVISÃO: Campos para rastrear trade pendente e fazer previsão
  pendingTradeId?: number | null;
  pendingTradeOperation?: DigitParity | null; // PAR ou IMPAR
  pendingTradeEntryPrice?: number | null;
  pendingTradeStakeAmount?: number | null;
  predictedStatus?: 'WON' | 'LOST' | null;
  ticksReceivedAfterBuy?: number;
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
  
  // ✅ REMOVIDO: WebSockets próprios - agora recebe ticks do AIService (igual Orion)
  // Os WebSockets para ticks são gerenciados pelo AIService
  
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

      // ✅ PREVISÃO: Verificar se há trade pendente e fazer previsão no próximo tick
      if (asset.pendingTradeId && asset.pendingTradeOperation && !asset.predictedStatus) {
        if (asset.ticksReceivedAfterBuy === undefined) {
          asset.ticksReceivedAfterBuy = 0;
        }
        asset.ticksReceivedAfterBuy++;
        
        // Se já recebemos pelo menos 1 tick após a compra, fazer previsão
        if (asset.ticksReceivedAfterBuy >= 1) {
          await this.predictTrinityTradeResult(asset, state.userId, symbol, latestTick);
        }
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
    
    // ✅ VERIFICAR STOP LOSS ANTES DE QUALQUER OPERAÇÃO
    if (state.stopLoss && state.stopLoss < 0) {
      const lucroAtual = state.capital - state.capitalInicial;
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

      // ✅ PREVISÃO: Armazenar informações do trade para previsão no próximo tick
      asset.pendingTradeId = tradeId;
      asset.pendingTradeOperation = operation;
      asset.pendingTradeEntryPrice = entryPrice;
      asset.pendingTradeStakeAmount = stakeAmount;
      asset.ticksReceivedAfterBuy = 0;
      asset.predictedStatus = null;

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
        // ✅ Limpar campos de previsão em caso de erro
        asset.pendingTradeId = null;
        asset.pendingTradeOperation = null;
        asset.pendingTradeEntryPrice = null;
        asset.pendingTradeStakeAmount = null;
        asset.predictedStatus = null;
        asset.ticksReceivedAfterBuy = 0;
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

      // ✅ VERIFICAÇÃO: Se já tínhamos uma previsão, verificar se bateu
      if (asset.predictedStatus && asset.predictedStatus !== confirmedStatus) {
        this.logger.warn(
          `[TRINITY][${symbol}] ⚠️ Previsão não bateu! Revertendo... | ` +
          `Previsto: ${asset.predictedStatus} | Confirmado: ${confirmedStatus} | TradeId: ${tradeId}`
        );
        // Reverter previsão e aplicar resultado correto (só se tradeId não for null)
        if (tradeId) {
          await this.revertTrinityPredictionAndApplyCorrect(
            asset,
            state.userId,
            symbol,
            tradeId,
            confirmedStatus,
            profit,
            exitPrice,
            contractId
          );
        }
      } else {
        // Se previsão bateu ou não havia previsão, aplicar resultado normalmente
        if (asset.predictedStatus) {
          this.logger.log(
            `[TRINITY][${symbol}] ✅ Previsão confirmada! | ` +
            `Status: ${confirmedStatus} | Profit: $${profit.toFixed(2)} | TradeId: ${tradeId}`
          );
        }

        // Atualizar trade com resultado
        await this.updateTrinityTrade(tradeId, state.userId, {
          status: confirmedStatus,
          profitLoss: profit,
          exitPrice,
        });
      }

      // ✅ Limpar campos de previsão
      asset.pendingTradeId = null;
      asset.pendingTradeOperation = null;
      asset.pendingTradeEntryPrice = null;
      asset.pendingTradeStakeAmount = null;
      asset.predictedStatus = null;
      asset.ticksReceivedAfterBuy = 0;

      this.logger.log(`[TRINITY][${symbol}] ${confirmedStatus} | User: ${state.userId} | P&L: $${profit.toFixed(2)}`);
      
      // ✅ Processar resultado (Martingale)
      await this.processTrinityResult(state, symbol, confirmedStatus === 'WON', stakeAmount, operation, profit, exitPrice, tradeId);
      
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] Erro ao executar operação:`, error);
      asset.isOperationActive = false;
      state.globalOperationActive = false;
      state.creationCooldownUntil = Date.now() + 5000; // 5s cooldown após erro
      // ✅ Limpar campos de previsão em caso de erro
      asset.pendingTradeId = null;
      asset.pendingTradeOperation = null;
      asset.pendingTradeEntryPrice = null;
      asset.pendingTradeStakeAmount = null;
      asset.predictedStatus = null;
      asset.ticksReceivedAfterBuy = 0;
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
    // ✅ Log antes de criar WebSocket para confirmar que método foi chamado
    const tokenPreview = token ? `${token.substring(0, 10)}...${token.substring(token.length - 5)}` : 'NULL';
    this.logger.log(`[TRINITY][${symbol}] 🔄 Iniciando criação de contrato | Token: ${tokenPreview} | Tipo: ${contractParams.contract_type}`);
    
    return new Promise((resolve) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      
      this.logger.log(`[TRINITY][${symbol}] 🔌 Conectando ao WebSocket: ${endpoint}`);
      
      const ws = new WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      let proposalId: string | null = null;
      let hasResolved = false;
      let contractCreated = false;
      let createdContractId: string | null = null;
      let contractMonitorTimeout: NodeJS.Timeout | null = null;
      
      // ✅ Timeout de 30 segundos para CRIAR o contrato
      const timeout = setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true;
          this.logger.warn(`[TRINITY][${symbol}] ⏱️ Timeout ao criar contrato (30s) | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | WS readyState: ${ws.readyState}`);
          this.saveTrinityLog(userId, symbol, 'erro',
            `⏱️ Timeout ao criar contrato após 30s | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount.toFixed(2)}`);
          ws.close();
          resolve(null);
        }
      }, 30000);
      
      // ✅ Função para iniciar timeout de monitoramento (60 segundos máximo após contrato criado)
      const startContractMonitorTimeout = (contractId: string) => {
        contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[TRINITY][${symbol}] ⏱️ Timeout ao monitorar contrato (60s) | ContractId: ${contractId}`);
            this.saveTrinityLog(userId, symbol, 'erro',
              `⏱️ Contrato ${contractId} não finalizou em 60 segundos - forçando fechamento`);
            ws.close();
            // ✅ Retorna null para que a IA possa continuar operando
            resolve(null);
          }
        }, 60000); // 60 segundos = 1 minuto máximo para contrato aberto
      };

      ws.on('open', () => {
        // ✅ EXATAMENTE IGUAL ORION: envia authorize imediatamente
        this.logger.log(`[TRINITY][${symbol}] ✅ WebSocket ABERTO, enviando authorize...`);
        ws.send(JSON.stringify({ authorize: token }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // ✅ LOG para ver mensagens recebidas
          this.logger.log(`[TRINITY][${symbol}] 📩 Mensagem WS: msg_type=${msg.msg_type || 'unknown'}`);

          // ✅ Tratamento para erro de nível superior (quando a API retorna error sem authorize)
          if (msg.error) {
            if (!hasResolved) {
              hasResolved = true;
              clearTimeout(timeout);
              const err = msg.error;
              this.logger.error(`[TRINITY][${symbol}] ❌ Erro da API Deriv | ${err.code} - ${err.message}`);
              this.saveTrinityLog(userId, symbol, 'erro',
                `❌ Erro da API Deriv | ${err.code} - ${err.message}`, {
                  etapa: msg.msg_type || 'unknown',
                  error: err,
                });
              ws.close();
              resolve(null);
            }
            return;
          }

          if (msg.authorize) {
            if (msg.authorize.error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                const err = msg.authorize.error;
                this.logger.error(`[TRINITY][${symbol}] ❌ Erro na autorização Deriv | ${err.code} - ${err.message}`);
                this.saveTrinityLog(userId, symbol, 'erro',
                  `❌ Erro na autorização Deriv | ${err.code} - ${err.message}`, {
                    etapa: 'authorize',
                    error: err,
                  });
                ws.close();
                resolve(null);
              }
              return;
            }
            
            this.logger.log(`[TRINITY][${symbol}] ✅ Autorizado! Solicitando proposta...`);

            // ✅ Payload igual ao da Orion (sem subscribe: 0)
            const proposalPayload = {
              proposal: 1,
              amount: contractParams.amount,
              basis: 'stake',
              contract_type: contractParams.contract_type,
              currency: contractParams.currency || 'USD',
              duration: 1,
              duration_unit: 't',
              symbol: contractParams.symbol,
            };
            
            this.logger.log(`[TRINITY][${symbol}] 📤 Enviando proposta: ${JSON.stringify(proposalPayload)}`);
            ws.send(JSON.stringify(proposalPayload));
            return;
          }

          if (msg.proposal) {
            if (msg.proposal.error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                const err = msg.proposal.error;
                const errorCode = err.code || '';
                const errorMessage = err.message || JSON.stringify(err);
                
                this.logger.error(`[TRINITY][${symbol}] ❌ Erro na proposta Deriv | ${errorCode} - ${errorMessage}`);
                this.saveTrinityLog(userId, symbol, 'erro',
                  `❌ Erro na proposta Deriv | ${errorCode} - ${errorMessage}`, {
                    etapa: 'proposal',
                    error: err,
                  });
                
                // ✅ Igual Orion: identificar erros comuns
                if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
                  this.logger.warn(`[TRINITY][${symbol}] 💡 Saldo insuficiente detectado.`);
                } else if (errorMessage.toLowerCase().includes('invalid') && errorMessage.toLowerCase().includes('amount')) {
                  this.logger.warn(`[TRINITY][${symbol}] 💡 Valor inválido (mínimo: $0.35).`);
                } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
                  this.logger.warn(`[TRINITY][${symbol}] 💡 Rate limit atingido.`);
                }
                
                ws.close();
                resolve(null);
              }
              return;
            }

            proposalId = msg.proposal.id;
            const proposalPrice = Number(msg.proposal.ask_price);
            
            // ✅ LOG ao invés de DEBUG
            this.logger.log(`[TRINITY][${symbol}] 📊 Proposta recebida: ID=${proposalId}, Preço=${proposalPrice}`);
            
            if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                this.logger.error(`[TRINITY][${symbol}] ❌ Proposta inválida | ID=${proposalId}, Preço=${proposalPrice}`);
                this.saveTrinityLog(userId, symbol, 'erro',
                  `❌ Proposta inválida recebida da Deriv | ID=${proposalId}, Preço=${proposalPrice}`, {
                    etapa: 'proposal',
                    response: msg.proposal,
                  });
                ws.close();
                resolve(null);
              }
              return;
            }

            this.logger.log(`[TRINITY][${symbol}] 💰 Executando compra | ProposalId=${proposalId} | Price=${proposalPrice}`);
            ws.send(JSON.stringify({
              buy: proposalId,
              price: proposalPrice,
            }));
            return;
          }

          if (msg.buy) {
            if (msg.buy.error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                ws.close();
                
                const err = msg.buy.error;
                const errorCode = err.code || '';
                const errorMessage = err.message || JSON.stringify(err);
                
                this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao comprar contrato | ${errorCode} - ${errorMessage}`);
                this.saveTrinityLog(userId, symbol, 'erro', `❌ Erro ao comprar contrato | ${errorCode} - ${errorMessage}`);
                
                if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
                  this.saveTrinityLog(userId, symbol, 'alerta', `💡 Saldo insuficiente na Deriv.`);
                }
                
                resolve(null);
              }
              return;
            }

            // ✅ Contrato criado com sucesso - NÃO fechar WS, iniciar monitoramento no mesmo WS
            const contractId = msg.buy.contract_id;
            if (!contractId) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                ws.close();
                this.logger.error(`[TRINITY][${symbol}] ❌ Compra sem contract_id`);
                resolve(null);
              }
              return;
            }

            contractCreated = true;
            createdContractId = contractId;
            
            // ✅ Cancelar timeout de criação e iniciar timeout de monitoramento (60s)
            clearTimeout(timeout);
            startContractMonitorTimeout(contractId);
            
            this.logger.log(`[TRINITY][${symbol}] ✅ Contrato criado: ${contractId} | Monitorando no mesmo WS (max 60s)...`);
            
            // ✅ Inscrever para atualizações do contrato no MESMO WebSocket
            ws.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: contractId,
              subscribe: 1,
            }));
            return;
          }
          
          // ✅ MONITORAMENTO NO MESMO WS: Receber atualizações do contrato
          if (msg.proposal_open_contract) {
            const contract = msg.proposal_open_contract;
            
            // Verificar se contrato finalizou
            const isFinalized = contract.is_sold === 1 || contract.is_sold === true || 
                               contract.status === 'won' || contract.status === 'lost' || contract.status === 'sold';
            
            if (isFinalized && !hasResolved) {
              hasResolved = true;
              clearTimeout(timeout);
              if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
              
              const profit = Number(contract.profit || 0);
              const contractIdResult = contract.contract_id;
              
              this.logger.log(`[TRINITY][${symbol}] ✅ Contrato ${contractIdResult} finalizado | Profit: $${profit.toFixed(2)}`);
              
              ws.close();
              resolve({ contractId: contractIdResult, profit, exitSpot: contract.exit_spot || contract.current_spot });
            }
            return;
          }
        } catch (err) {
          if (!hasResolved) {
            hasResolved = true;
            clearTimeout(timeout);
            if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
            this.logger.error(`[TRINITY][${symbol}] ❌ Erro ao processar mensagem WS: ${err instanceof Error ? err.message : String(err)}`);
            this.saveTrinityLog(userId, symbol, 'erro',
              `❌ Erro ao processar mensagem WS (criação de contrato) | ${err instanceof Error ? err.message : String(err)}`, {
                etapa: 'ws_message',
                error: err instanceof Error ? err.message : String(err),
              });
            ws.close();
            resolve(null);
          }
        }
      });

      ws.on('error', (error) => {
        if (!hasResolved) {
          hasResolved = true;
          clearTimeout(timeout);
          if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
          this.logger.error(`[TRINITY][${symbol}] ❌ Erro no WebSocket: ${error.message}`);
          this.saveTrinityLog(userId, symbol, 'erro',
            `❌ Erro no WebSocket ao criar contrato | ${error.message}`, {
              etapa: 'ws_error',
              error: error.message,
            });
          ws.close();
          resolve(null);
        }
      });

      ws.on('close', (code, reason) => {
        // ✅ Detectar fechamento prematuro do WebSocket (igual Orion)
        if (!hasResolved) {
          hasResolved = true;
          clearTimeout(timeout);
          if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
          this.logger.warn(`[TRINITY][${symbol}] ⚠️ WebSocket fechado antes de completar | Code: ${code} | Reason: ${reason?.toString()}`);
          this.saveTrinityLog(userId, symbol, 'erro',
            `⚠️ WebSocket fechado antes de completar | Code: ${code} | Reason: ${reason?.toString()}`, {
              etapa: 'ws_close',
              code,
              reason: reason?.toString(),
            });
          resolve(null);
        }
      });
    });
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
        
        // ✅ Desativar sessão no banco de dados
        try {
          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop loss blindado ativado: Capital $${state.capital.toFixed(2)} <= Stop $${stopBlindado.toFixed(2)}`, state.userId],
          );
          this.logger.log(`[TRINITY] ✅ Sessão desativada para usuário ${state.userId} devido ao stop loss blindado`);
        } catch (error) {
          this.logger.error(`[TRINITY] ❌ Erro ao desativar sessão:`, error);
        }
        
        // Remover usuário do monitoramento
        this.trinityUsers.delete(state.userId);
        
        return;
      }
    }
  }

  /**
   * ✅ PREVISÃO: Calcula o resultado previsto baseado no próximo tick
   */
  private async predictTrinityTradeResult(
    asset: TrinityAssetState,
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_50',
    tick: Tick,
  ): Promise<void> {
    if (!asset.pendingTradeId || !asset.pendingTradeOperation) {
      return;
    }

    // Extrair último dígito do tick
    const tickValue = tick.value || 0;
    const lastDigit = this.extractLastDigit(tickValue);
    const isEven = lastDigit % 2 === 0;

    // Verificar se corresponde à aposta
    const betType = asset.pendingTradeOperation;
    let predictedWon = false;

    if (betType === 'PAR') {
      predictedWon = isEven;
    } else if (betType === 'IMPAR') {
      predictedWon = !isEven;
    }

    // Calcular profit previsto (aproximado)
    const stakeAmount = asset.pendingTradeStakeAmount || 0;
    const payout = 0.95; // Payout aproximado (95%)
    const predictedProfit = predictedWon 
      ? (stakeAmount * payout) - stakeAmount 
      : -stakeAmount;

    const predictedStatus: 'WON' | 'LOST' = predictedWon ? 'WON' : 'LOST';

    // Atualizar status previsto no estado
    asset.predictedStatus = predictedStatus;

    this.logger.log(
      `[TRINITY][${symbol}] 🔮 PREVISÃO | TradeId: ${asset.pendingTradeId} | ` +
      `Tick: ${tickValue} | Dígito: ${lastDigit} (${isEven ? 'PAR' : 'ÍMPAR'}) | ` +
      `Aposta: ${betType} | Previsto: ${predictedStatus} | Profit: $${predictedProfit.toFixed(2)}`
    );

    // Atualizar banco de dados com previsão
    try {
      await this.dataSource.query(
        `UPDATE ai_trades
         SET exit_price = ?, profit_loss = ?, status = ?
         WHERE id = ? AND status = 'PENDING'`,
        [tickValue, predictedProfit, predictedStatus, asset.pendingTradeId],
      );

      // Emitir evento de atualização (previsão)
      this.tradeEvents.emit({
        userId,
        type: 'updated',
        tradeId: asset.pendingTradeId,
        status: predictedStatus,
        strategy: 'trinity',
        profitLoss: predictedProfit,
        exitPrice: tickValue,
        isPredicted: true, // Marcar como previsão
        symbol,
      });

      // ✅ Log de previsão removido - apenas atualização visual no frontend
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] Erro ao atualizar previsão no banco:`, error);
    }
  }

  /**
   * ✅ REVERSÃO: Reverte previsão incorreta e aplica resultado correto
   */
  private async revertTrinityPredictionAndApplyCorrect(
    asset: TrinityAssetState,
    userId: string,
    symbol: 'R_10' | 'R_25' | 'R_50',
    tradeId: number,
    confirmedStatus: 'WON' | 'LOST',
    confirmedProfit: number,
    exitPrice: number,
    contractId: string,
  ): Promise<void> {
    const previousPrediction = asset.predictedStatus;

    this.logger.warn(
      `[TRINITY][${symbol}] 🔄 REVERTENDO PREVISÃO | TradeId: ${tradeId} | ` +
      `Previsão anterior: ${previousPrediction} | Resultado correto: ${confirmedStatus} | ` +
      `Profit anterior: $${(asset.pendingTradeStakeAmount || 0) * 0.95 - (asset.pendingTradeStakeAmount || 0)} | ` +
      `Profit correto: $${confirmedProfit.toFixed(2)}`
    );

    // Atualizar banco com resultado correto
    try {
      await this.dataSource.query(
        `UPDATE ai_trades
         SET contract_id = ?, exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
         WHERE id = ?`,
        [contractId, exitPrice, confirmedProfit, confirmedStatus, tradeId],
      );

      // Emitir evento de correção
      this.tradeEvents.emit({
        userId,
        type: 'corrected',
        tradeId,
        previousPrediction,
        confirmedStatus,
        previousProfit: (asset.pendingTradeStakeAmount || 0) * 0.95 - (asset.pendingTradeStakeAmount || 0),
        confirmedProfit,
        strategy: 'trinity',
        exitPrice,
        symbol,
      });

      this.saveTrinityLog(
        userId,
        symbol,
        'resultado',
        `🔄 PREVISÃO CORRIGIDA | Anterior: ${previousPrediction} | Correto: ${confirmedStatus} | Profit: $${confirmedProfit.toFixed(2)}`
      );
    } catch (error) {
      this.logger.error(`[TRINITY][${symbol}] Erro ao reverter previsão no banco:`, error);
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

  // Getters para acesso externo
  getTicks(symbol: 'R_10' | 'R_25' | 'R_50'): Tick[] {
    return this.trinityTicks[symbol];
  }

  getUsers(): Map<string, TrinityUserState> {
    return this.trinityUsers;
  }
}

