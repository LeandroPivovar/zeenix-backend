import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';
import { gerarSinalZenix } from './signal-generator';

// Estados ORION
export interface VelozUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
  modoMartingale: ModoMartingale;
  perdaAcumulada: number;
  apostaInicial: number;
  ticksDesdeUltimaOp: number;
  vitoriasConsecutivas: number;
  apostaBase: number;
  ultimoLucro: number;
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number; // Cooldown pós erro/timeout para mitigar rate limit
}

export interface ModeradoUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
  modoMartingale: ModoMartingale;
  perdaAcumulada: number;
  apostaInicial: number;
  lastOperationTimestamp: Date | null;
  vitoriasConsecutivas: number;
  apostaBase: number;
  ultimoLucro: number;
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number;
}

export interface PrecisoUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
  modoMartingale: ModoMartingale;
  perdaAcumulada: number;
  apostaInicial: number;
  vitoriasConsecutivas: number;
  apostaBase: number;
  ultimoLucro: number;
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number;
}

// ============================================
// ESTRATÉGIA SOROS - ZENIX v2.0
// ============================================
const SOROS_MAX_NIVEL = 2; // Soros tem apenas 2 níveis (entrada 1, 2, 3)

/**
 * Calcula aposta com estratégia Soros aplicada
 * Soros funciona apenas até o nível 2 (3 entradas):
 * - Entrada 1: valor inicial
 * - Entrada 2 (Soros Nível 1): entrada anterior + lucro da entrada anterior
 * - Entrada 3 (Soros Nível 2): entrada anterior + lucro da entrada anterior
 * 
 * @param entradaAnterior - Valor da entrada anterior
 * @param lucroAnterior - Lucro obtido na entrada anterior
 * @param vitoriasConsecutivas - Número de vitórias consecutivas (0, 1, ou 2)
 * @returns Valor da aposta com Soros aplicado, ou null se Soros não deve ser aplicado
 */
function calcularApostaComSoros(
  entradaAnterior: number,
  lucroAnterior: number,
  vitoriasConsecutivas: number,
): number | null {
  // Soros só funciona até o nível 2 (vitoriasConsecutivas = 0, 1, ou 2)
  if (vitoriasConsecutivas <= 0 || vitoriasConsecutivas > SOROS_MAX_NIVEL) {
    return null; // Não está no Soros ou já passou do limite
  }
  
  // Soros: entrada anterior + lucro anterior
  const apostaComSoros = entradaAnterior + lucroAnterior;
  
  // Arredondar para 2 casas decimais
  return Math.round(apostaComSoros * 100) / 100;
}

/**
 * Calcula a próxima aposta baseado no modo de martingale - ZENIX v2.0
 * 
 * Fórmula geral: entrada_próxima = meta_de_recuperação × 100 / payout_cliente
 * 
 * CONSERVADOR: meta = perdas_totais (break-even)
 * MODERADO:    meta = perdas_totais × 1,25 (100% das perdas + 25% de lucro)
 * AGRESSIVO:   meta = perdas_totais × 1,50 (100% das perdas + 50% de lucro)
 * 
 * @param perdasTotais - Total de perdas acumuladas no martingale
 * @param modo - Modo de martingale (conservador/moderado/agressivo)
 * @param payoutCliente - Payout do cliente (payout_original - 3)
 * @returns Valor da próxima aposta calculada
 */
function calcularProximaAposta(
  perdasTotais: number,
  modo: ModoMartingale,
  payoutCliente: number,
): number {
  let metaRecuperacao = 0;
  
  switch (modo) {
    case 'conservador':
      // Meta: recuperar 100% das perdas (break-even)
      metaRecuperacao = perdasTotais;
      break;
    case 'moderado':
      // Meta: recuperar 100% das perdas + 25% de lucro
      metaRecuperacao = perdasTotais * 1.25;
      break;
    case 'agressivo':
      // Meta: recuperar 100% das perdas + 50% de lucro
      metaRecuperacao = perdasTotais * 1.50;
      break;
  }
  
  // Fórmula: entrada_próxima = meta_de_recuperação × 100 / payout_cliente
  const aposta = (metaRecuperacao * 100) / payoutCliente;
  
  return Math.round(aposta * 100) / 100; // 2 casas decimais
}

@Injectable()
export class OrionStrategy implements IStrategy {
  name = 'orion';
  private readonly logger = new Logger(OrionStrategy.name);
  
  private ticks: Tick[] = [];
  private velozUsers = new Map<string, VelozUserState>();
  private moderadoUsers = new Map<string, ModeradoUserState>();
  private precisoUsers = new Map<string, PrecisoUserState>();

  // ✅ Sistema de logs (similar à Trinity)
  private logQueue: Array<{
    userId: string;
    symbol: string;
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;
  private appId: string;
  private symbol = 'R_10';

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[ORION] Estratégia ORION inicializada');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    this.ticks.push(tick);
    if (this.ticks.length > 2000) {
      this.ticks.shift();
    }

    // Processar cada modo
    await this.processVelozStrategies(tick);
    await this.processModeradoStrategies(tick);
    await this.processPrecisoStrategies(tick);
  }

  async activateUser(userId: string, config: any): Promise<void> {
    const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue } = config;
    const modeLower = (mode || 'veloz').toLowerCase();
    
    // ✅ entryValue é o valor de entrada por operação (ex: R$ 1.00)
    // ✅ stakeAmount é o capital total da conta (ex: $8953.20)
    const apostaInicial = entryValue || 0.35; // Usar entryValue se fornecido, senão 0.35 (mínimo)

    if (modeLower === 'veloz') {
      this.upsertVelozUserState({
        userId,
        stakeAmount, // Capital total
        apostaInicial, // Valor de entrada por operação
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
      });
      
      // ✅ Log: Usuário ativado
      this.saveOrionLog(userId, 'SISTEMA', 'info', 
        `Usuário ATIVADO | Modo: ${mode || 'veloz'} | Capital: $${stakeAmount.toFixed(2)} | Martingale: ${modoMartingale || 'conservador'}`);
    } else if (modeLower === 'moderado') {
      this.upsertModeradoUserState({
        userId,
        stakeAmount, // Capital total
        apostaInicial, // Valor de entrada por operação
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
      });
      
      // ✅ Log: Usuário ativado
      this.saveOrionLog(userId, 'SISTEMA', 'info', 
        `Usuário ATIVADO | Modo: ${mode || 'moderado'} | Capital: $${stakeAmount.toFixed(2)} | Martingale: ${modoMartingale || 'conservador'}`);
    } else if (modeLower === 'preciso') {
      this.upsertPrecisoUserState({
        userId,
        stakeAmount, // Capital total
        apostaInicial, // Valor de entrada por operação
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
      });
      
      // ✅ Log: Usuário ativado
      this.saveOrionLog(userId, 'SISTEMA', 'info', 
        `Usuário ATIVADO | Modo: ${mode || 'preciso'} | Capital: $${stakeAmount.toFixed(2)} | Martingale: ${modoMartingale || 'conservador'}`);
    }
    
    this.logger.log(`[ORION] ✅ Usuário ${userId} ativado no modo ${modeLower}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.velozUsers.delete(userId);
    this.moderadoUsers.delete(userId);
    this.precisoUsers.delete(userId);
    this.logger.log(`[ORION] Usuário ${userId} desativado`);
  }

  getUserState(userId: string): VelozUserState | ModeradoUserState | PrecisoUserState | null {
    return this.velozUsers.get(userId) || 
           this.moderadoUsers.get(userId) || 
           this.precisoUsers.get(userId) || 
           null;
  }

  // Métodos privados para processamento
  private async processVelozStrategies(latestTick: Tick): Promise<void> {
    if (this.velozUsers.size === 0) return;
    if (this.ticks.length < VELOZ_CONFIG.amostraInicial) return;

    // Incrementar contador de ticks
    for (const [userId, state] of this.velozUsers.entries()) {
      if (state.ticksDesdeUltimaOp !== undefined && state.ticksDesdeUltimaOp >= 0) {
        state.ticksDesdeUltimaOp += 1;
      }
    }

    // Processar cada usuário
    for (const [userId, state] of this.velozUsers.entries()) {
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        this.logger.debug(
          `[ORION][Veloz][${userId}] 🔍 Verificando martingale: perdaAcumulada=$${state.perdaAcumulada.toFixed(2)}, direcao=${state.ultimaDirecaoMartingale}, martingaleStep=${state.martingaleStep || 0}`,
        );
        
        // Verificar intervalo entre operações (3 ticks)
        if (state.ticksDesdeUltimaOp !== undefined && state.ticksDesdeUltimaOp >= 0) {
          if (state.ticksDesdeUltimaOp < VELOZ_CONFIG.intervaloTicks!) {
            this.logger.debug(
              `[ORION][Veloz][${userId}] ⏱️ Aguardando intervalo (martingale): ${state.ticksDesdeUltimaOp}/${VELOZ_CONFIG.intervaloTicks} ticks`,
            );
            continue;
          }
        }

        // Continuar com martingale usando a mesma direção
        // ✅ CORREÇÃO: martingaleStep já foi incrementado após a perda anterior
        const proximaEntrada = (state.martingaleStep || 0) + 1;
        this.logger.log(
          `[ORION][Veloz][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)} | MartingaleStep: ${state.martingaleStep || 0}`,
        );
        
        await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'veloz', proximaEntrada);
        continue;
      }

      // Verificar intervalo entre operações (3 ticks)
      if (state.ticksDesdeUltimaOp < VELOZ_CONFIG.intervaloTicks!) continue;

      const sinal = gerarSinalZenix(this.ticks, VELOZ_CONFIG, 'VELOZ');
      if (!sinal || !sinal.sinal) continue;

      this.logger.log(
        `[ORION][Veloz] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal.sinal}`);
      this.saveOrionLog(userId, 'R_10', 'sinal', `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`);
      
      // ✅ Salvar logs da análise
      this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0`);
      const deseq = sinal.detalhes?.desequilibrio;
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        this.saveOrionLog(userId, 'R_10', 'analise', `Distribuição: PAR ${percPar}% | ÍMPAR ${percImpar}%`);
        this.saveOrionLog(userId, 'R_10', 'analise', `Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `🎯 CONFIANÇA FINAL: ${sinal.confianca.toFixed(1)}%`);

      // ✅ Executar operação (entrada 1)
      await this.executeOrionOperation(state, sinal.sinal, 'veloz', 1);
    }
  }

  private async processModeradoStrategies(latestTick: Tick): Promise<void> {
    if (this.moderadoUsers.size === 0) return;
    if (this.ticks.length < MODERADO_CONFIG.amostraInicial) return;

    // Processar cada usuário
    for (const [userId, state] of this.moderadoUsers.entries()) {
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        const now = new Date();
        if (state.lastOperationTimestamp) {
          const secondsSinceLastOp = (now.getTime() - state.lastOperationTimestamp.getTime()) / 1000;
          if (secondsSinceLastOp < MODERADO_CONFIG.intervaloSegundos!) {
            this.logger.debug(
              `[ORION][Moderado][${userId}] ⏱️ Aguardando intervalo (martingale): ${secondsSinceLastOp.toFixed(1)}/${MODERADO_CONFIG.intervaloSegundos} segundos`,
            );
            continue;
          }
        }

        // Continuar com martingale usando a mesma direção
        // ✅ CORREÇÃO: martingaleStep já foi incrementado após a perda anterior
        const proximaEntrada = (state.martingaleStep || 0) + 1;
        this.logger.log(
          `[ORION][Moderado][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );
        
        await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'moderado', proximaEntrada);
        continue;
      }

      const now = new Date();
      if (state.lastOperationTimestamp) {
        const secondsSinceLastOp = (now.getTime() - state.lastOperationTimestamp.getTime()) / 1000;
        if (secondsSinceLastOp < MODERADO_CONFIG.intervaloSegundos!) continue;
      }

      const sinal = gerarSinalZenix(this.ticks, MODERADO_CONFIG, 'MODERADO');
      if (!sinal || !sinal.sinal) continue;

      this.logger.log(
        `[ORION][Moderado] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal.sinal}`);
      this.saveOrionLog(userId, 'R_10', 'sinal', `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`);
      
      // ✅ Salvar logs da análise
      this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0`);
      const deseq = sinal.detalhes?.desequilibrio;
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        this.saveOrionLog(userId, 'R_10', 'analise', `Distribuição: PAR ${percPar}% | ÍMPAR ${percImpar}%`);
        this.saveOrionLog(userId, 'R_10', 'analise', `Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `🎯 CONFIANÇA FINAL: ${sinal.confianca.toFixed(1)}%`);

      // ✅ Executar operação (entrada 1)
      await this.executeOrionOperation(state, sinal.sinal, 'moderado', 1);
    }
  }

  private async processPrecisoStrategies(latestTick: Tick): Promise<void> {
    if (this.precisoUsers.size === 0) return;
    if (this.ticks.length < PRECISO_CONFIG.amostraInicial) return;

    // Processar cada usuário
    for (const [userId, state] of this.precisoUsers.entries()) {
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        // Continuar com martingale usando a mesma direção
        // ✅ CORREÇÃO: martingaleStep já foi incrementado após a perda anterior
        const proximaEntrada = (state.martingaleStep || 0) + 1;
        this.logger.log(
          `[ORION][Preciso][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );
        
        await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'preciso', proximaEntrada);
        continue;
      }

      const sinal = gerarSinalZenix(this.ticks, PRECISO_CONFIG, 'PRECISO');
      if (!sinal || !sinal.sinal) continue;

      this.logger.log(
        `[ORION][Preciso] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal.sinal}`);
      this.saveOrionLog(userId, 'R_10', 'sinal', `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`);
      
      // ✅ Salvar logs da análise
      this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0`);
      const deseq = sinal.detalhes?.desequilibrio;
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        this.saveOrionLog(userId, 'R_10', 'analise', `Distribuição: PAR ${percPar}% | ÍMPAR ${percImpar}%`);
        this.saveOrionLog(userId, 'R_10', 'analise', `Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `🎯 CONFIANÇA FINAL: ${sinal.confianca.toFixed(1)}%`);

      // ✅ Executar operação (entrada 1)
      await this.executeOrionOperation(state, sinal.sinal, 'preciso', 1);
    }
  }

  /**
   * ✅ ORION: Executa operação completa
   */
  private async executeOrionOperation(
    state: VelozUserState | ModeradoUserState | PrecisoUserState,
    operation: DigitParity,
    mode: 'veloz' | 'moderado' | 'preciso',
    entry: number = 1,
  ): Promise<void> {
    // ✅ Declarar tradeId no escopo da função para ser acessível no catch
    let tradeId: number | null = null;
    
    if (state.isOperationActive) {
      this.logger.warn(`[ORION][${mode}] Usuário ${state.userId} já possui operação ativa`);
      return;
    }

    // ✅ VALIDAÇÕES PREVENTIVAS serão feitas APÓS calcular o stakeAmount
    state.isOperationActive = true;
    // ✅ CORREÇÃO: martingaleStep é gerenciado após perda/vitória, não aqui
    // entry é apenas para logs e cálculo do stake

    // Resetar contador de ticks
    if ('ticksDesdeUltimaOp' in state) {
      state.ticksDesdeUltimaOp = 0;
    }

    // Atualizar timestamp da última operação (Moderado)
    if ('lastOperationTimestamp' in state) {
      state.lastOperationTimestamp = new Date();
    }

    // ✅ ZENIX v2.0: Calcular stake baseado em Soros ou Martingale
    let stakeAmount: number;
    
    if (entry === 1) {
      // Primeira entrada: verificar se está no Soros
      const vitoriasAtuais = state.vitoriasConsecutivas || 0;
      this.logger.debug(
        `[ORION][${mode}][${state.userId}] 🔍 Verificando Soros | Vitórias consecutivas: ${vitoriasAtuais} | ApostaBase: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)} | UltimoLucro: $${(state.ultimoLucro || 0).toFixed(2)}`,
      );
      
      if (vitoriasAtuais > 0 && vitoriasAtuais <= SOROS_MAX_NIVEL) {
        // ✅ SOROS: Entrada anterior + lucro anterior
        const apostaAnterior = state.apostaBase || state.apostaInicial || 0.35;
        const lucroAnterior = state.ultimoLucro || 0;
        const apostaSoros = calcularApostaComSoros(apostaAnterior, lucroAnterior, vitoriasAtuais);
        
        this.logger.debug(
          `[ORION][${mode}][${state.userId}] 🔍 Cálculo Soros | Aposta anterior: $${apostaAnterior.toFixed(2)} | Lucro anterior: $${lucroAnterior.toFixed(2)} | Resultado: ${apostaSoros !== null ? '$' + apostaSoros.toFixed(2) : 'null'}`,
        );
        
        if (apostaSoros !== null) {
          stakeAmount = apostaSoros;
          this.logger.log(
            `[ORION][${mode}][${state.userId}] 💰 SOROS Nível ${vitoriasAtuais} | Aposta anterior: $${apostaAnterior.toFixed(2)} | Lucro anterior: $${lucroAnterior.toFixed(2)} | Nova aposta: $${stakeAmount.toFixed(2)}`,
          );
        } else {
          // Fallback: usar aposta inicial
          this.logger.warn(
            `[ORION][${mode}][${state.userId}] ⚠️ Soros retornou null, usando aposta inicial`,
          );
          stakeAmount = state.apostaInicial || state.capital || 0.35;
        }
      } else {
        // Primeira entrada normal: usar aposta inicial
        stakeAmount = state.apostaInicial || state.capital || 0.35;
      }
      
      // ✅ Garantir que martingaleStep está em 0 para primeira entrada
      if ('martingaleStep' in state) {
        state.martingaleStep = 0;
      }
    } else {
      // Martingale: calcular próxima aposta
      const payoutCliente = 92; // Payout padrão (95 - 3)
      stakeAmount = calcularProximaAposta(state.perdaAcumulada, state.modoMartingale, payoutCliente);
      
      // Garantir valor mínimo
      if (stakeAmount < 0.35) {
        stakeAmount = 0.35;
      }
      
      // ✅ Log do cálculo do martingale
      this.logger.log(
        `[ORION][${mode}][${state.userId}] 🔄 MARTINGALE | Entrada ${entry} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)} | Stake calculado: $${stakeAmount.toFixed(2)}`,
      );
    }
    
    // ✅ VALIDAÇÕES PREVENTIVAS após calcular stakeAmount
    // 0. Cooldown para mitigar rate limit (se houve erro/timeout recente)
    if (state.creationCooldownUntil && Date.now() < state.creationCooldownUntil) {
      this.logger.warn(`[ORION][${mode}][${state.userId}] ⏸️ Cooldown ativo para criação de contrato. Aguardando antes de nova tentativa.`);
      state.isOperationActive = false;
      return;
    }

    // 1. Validar valor mínimo da Deriv ($0.35)
    if (stakeAmount < 0.35) {
      this.logger.warn(
        `[ORION][${mode}][${state.userId}] ❌ Valor abaixo do mínimo | Stake: $${stakeAmount.toFixed(2)} | Mínimo: $0.35 | Ajustando para mínimo`,
      );
      stakeAmount = 0.35; // Ajustar para o mínimo
      this.saveOrionLog(state.userId, 'R_10', 'alerta', `⚠️ Valor da aposta ajustado para o mínimo permitido: $0.35`);
    }

    // 2. Validar saldo mínimo (com margem de segurança de 10%)
    const saldoNecessario = stakeAmount * 1.1; // 10% de margem
    if (state.capital < saldoNecessario) {
      this.logger.warn(
        `[ORION][${mode}][${state.userId}] ❌ Saldo insuficiente | Capital: $${state.capital.toFixed(2)} | Necessário: $${saldoNecessario.toFixed(2)} (stake: $${stakeAmount.toFixed(2)} + margem)`,
      );
      state.isOperationActive = false;
      this.saveOrionLog(state.userId, 'R_10', 'erro', `❌ Saldo insuficiente para operação | Capital: $${state.capital.toFixed(2)} | Necessário: $${saldoNecessario.toFixed(2)}`);
      return; // Não tentar criar contrato se não tiver saldo suficiente
    }

    // 3. Validar token
    if (!state.derivToken || state.derivToken.trim() === '') {
      this.logger.error(`[ORION][${mode}][${state.userId}] ❌ Token Deriv inválido ou ausente`);
      state.isOperationActive = false;
      this.saveOrionLog(state.userId, 'R_10', 'erro', `❌ Token Deriv inválido ou ausente - Não é possível criar contrato`);
      return; // Não tentar criar contrato sem token
    }
    
    const currentPrice = this.ticks.length > 0 ? this.ticks[this.ticks.length - 1].value : 0;

    // ✅ Logs da operação
    this.saveOrionLog(state.userId, 'R_10', 'operacao', `🎯 EXECUTANDO OPERAÇÃO #${entry}`);
    this.saveOrionLog(state.userId, 'R_10', 'operacao', `Ativo: R_10`);
    this.saveOrionLog(state.userId, 'R_10', 'operacao', `Direção: ${operation}`);
    this.saveOrionLog(state.userId, 'R_10', 'operacao', `Valor: $${stakeAmount.toFixed(2)}`);
    this.saveOrionLog(state.userId, 'R_10', 'operacao', `Payout: 0.95 (95%)`);
    if (entry > 1) {
      this.saveOrionLog(state.userId, 'R_10', 'operacao', `🔄 MARTINGALE (${state.modoMartingale.toUpperCase()}) | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
    } else if (state.vitoriasConsecutivas > 0 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL) {
      this.saveOrionLog(state.userId, 'R_10', 'operacao', `💰 SOROS Nível ${state.vitoriasConsecutivas} | Aposta anterior: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)} | Lucro anterior: $${(state.ultimoLucro || 0).toFixed(2)}`);
    }

    try {
      // Criar registro de trade
      tradeId = await this.createOrionTradeRecord(
        state.userId,
        operation,
        stakeAmount,
        currentPrice,
        mode,
      );

      // ✅ Executar trade E monitorar no MESMO WebSocket (mais rápido para contratos de 1 tick)
      const result = await this.executeOrionTradeViaWebSocket(
        state.derivToken,
        {
          contract_type: operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
          amount: stakeAmount,
          currency: state.currency || 'USD',
        },
        state.userId,
      );

      if (!result) {
        state.isOperationActive = false;
        if ('ticksDesdeUltimaOp' in state) {
          state.ticksDesdeUltimaOp = 0;
        }
        state.creationCooldownUntil = Date.now() + 5000;
        await this.dataSource.query(
          `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
          ['Não foi possível criar/monitorar contrato', tradeId],
        );
        this.saveOrionLog(state.userId, 'R_10', 'erro', `Erro ao executar operação | Não foi possível criar contrato`);
        return;
      }

      // ✅ Resultado já veio do mesmo WebSocket - processar diretamente
      const { contractId, profit, exitSpot } = result;
      const exitPrice = Number(exitSpot || 0);
      const status = profit >= 0 ? 'WON' : 'LOST';

      // Atualizar trade no banco
      await this.dataSource.query(
        `UPDATE ai_trades
         SET contract_id = ?, exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
         WHERE id = ?`,
        [contractId, exitPrice, profit, status, tradeId],
      );

      // Emitir evento de atualização
      this.tradeEvents.emit({
        userId: state.userId,
        type: 'updated',
        tradeId,
        status,
        strategy: 'orion',
        profitLoss: profit,
        exitPrice,
      });

      this.logger.log(`[ORION][${mode}] ${status} | User: ${state.userId} | P&L: $${profit.toFixed(2)}`);
      
      // ✅ Processar resultado (Soros/Martingale)
      await this.processOrionResult(state, stakeAmount, operation, profit, mode);
    } catch (error) {
      this.logger.error(`[ORION][${mode}] Erro ao executar operação:`, error);
      state.isOperationActive = false;
      state.creationCooldownUntil = Date.now() + 5000; // cooldown após erro
      
      const errorResponse = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
      
      // ✅ Marcar trade como ERROR no banco de dados
      if (tradeId) {
        await this.dataSource.query(
          `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [error.message || 'Erro ao executar operação', tradeId],
        ).catch(err => {
          this.logger.error(`[ORION] Erro ao atualizar trade com status ERROR:`, err);
        });
      }
      // ✅ Log de erro com detalhes completos
      this.saveOrionLog(state.userId, 'R_10', 'erro', `Erro ao executar operação: ${error.message || 'Erro desconhecido'} | Detalhes: ${errorResponse}`);
    }
  }

  /**
   * ✅ ORION: Cria registro de trade no banco
   */
  private async createOrionTradeRecord(
    userId: string,
    operation: DigitParity,
    stakeAmount: number,
    entryPrice: number,
    mode: string,
  ): Promise<number> {
    const analysisData = {
      strategy: 'orion',
      mode,
      operation,
      timestamp: new Date().toISOString(),
    };

    let insertResult: any;
    try {
      insertResult = await this.dataSource.query(
        `INSERT INTO ai_trades 
         (user_id, gemini_signal, entry_price, stake_amount, status, 
          gemini_duration, contract_type, created_at, analysis_data, symbol)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          userId,
          operation,
          entryPrice,
          stakeAmount,
          'PENDING',
          1,
          operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
          JSON.stringify(analysisData),
          this.symbol,
        ],
      );
    } catch (error: any) {
      // Se o campo symbol não existir, inserir sem ele
      if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
        insertResult = await this.dataSource.query(
          `INSERT INTO ai_trades 
           (user_id, gemini_signal, entry_price, stake_amount, status, 
            gemini_duration, contract_type, created_at, analysis_data)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
          [
            userId,
            operation,
            entryPrice,
            stakeAmount,
            'PENDING',
            1,
            operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
            JSON.stringify(analysisData),
          ],
        );
      } else {
        throw error;
      }
    }

    const result = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    const tradeId = result?.insertId || null;

    if (tradeId) {
      this.tradeEvents.emit({
        userId,
        type: 'created',
        tradeId,
        status: 'PENDING',
        strategy: 'orion',
        symbol: this.symbol as any,
        contractType: operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
      });
    }

    return tradeId;
  }

  /**
   * ✅ ORION: Executa trade via WebSocket E monitora resultado no MESMO WebSocket
   * Retorna o resultado completo (contractId, profit, exitSpot) ou null se falhar
   */
  private async executeOrionTradeViaWebSocket(
    token: string,
    contractParams: {
      contract_type: 'DIGITEVEN' | 'DIGITODD';
      amount: number;
      currency: string;
    },
    userId?: string,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    return new Promise((resolve) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
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
          this.logger.warn(`[ORION] ⏱️ Timeout ao criar contrato (30s) | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);
          // ✅ Log de timeout na criação do contrato (apenas se tiver userId)
          if (userId) {
            this.saveOrionLog(userId, 'R_10', 'erro', `⏱️ Timeout ao criar contrato após 30 segundos | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);
          }
          ws.close();
          resolve(null);
        }
      }, 30000);
      
      // ✅ Função para iniciar timeout de monitoramento (60 segundos máximo após contrato criado)
      const startContractMonitorTimeout = (contractId: string) => {
        contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[ORION] ⏱️ Timeout ao monitorar contrato (60s) | ContractId: ${contractId} | Tipo: ${contractParams.contract_type}`);
            if (userId) {
              this.saveOrionLog(userId, 'R_10', 'erro', `⏱️ Contrato ${contractId} não finalizou em 60 segundos - forçando fechamento | Tipo: ${contractParams.contract_type}`);
            }
            ws.close();
            // ✅ Retorna null para que a IA possa continuar operando
            resolve(null);
          }
        }, 60000); // 60 segundos = 1 minuto máximo para contrato aberto
      };

      ws.on('open', () => {
        this.logger.debug(`[ORION] 🔌 WebSocket aberto, autorizando...`);
        ws.send(JSON.stringify({ authorize: token }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.authorize) {
            if (msg.authorize.error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                const errorResponse = JSON.stringify(msg.authorize);
                this.logger.error(
                  `[ORION] ❌ Erro na autorização: ${JSON.stringify(msg.authorize.error)} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`,
                );
                // ✅ Salvar resposta completa da API nos logs (apenas se tiver userId)
                if (userId) {
                  this.saveOrionLog(userId, 'R_10', 'erro', `❌ Erro na autorização da Deriv | Resposta: ${errorResponse}`);
                }
                ws.close();
                resolve(null);
              }
              return;
            }
            
            this.logger.debug(`[ORION] ✅ Autorizado, solicitando proposta...`);
            const proposalPayload = {
              proposal: 1,
              amount: contractParams.amount,
              basis: 'stake',
              contract_type: contractParams.contract_type,
              currency: contractParams.currency || 'USD',
              duration: 1,
              duration_unit: 't',
              symbol: this.symbol,
            };
            
            ws.send(JSON.stringify(proposalPayload));
            return;
          }

          if (msg.proposal) {
            if (msg.proposal.error) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                const errorResponse = JSON.stringify(msg.proposal);
                const errorCode = msg.proposal.error?.code || '';
                const errorMessage = msg.proposal.error?.message || JSON.stringify(msg.proposal.error);
                
                this.logger.error(
                  `[ORION] ❌ Erro na proposta: ${JSON.stringify(msg.proposal.error)} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`,
                );
                
                // ✅ Salvar resposta completa da API nos logs (apenas se tiver userId)
                if (userId) {
                  this.saveOrionLog(userId, 'R_10', 'erro', `❌ Erro na proposta da Deriv | Código: ${errorCode} | Mensagem: ${errorMessage} | Resposta completa: ${errorResponse}`);
                }
                
                // ✅ Tentar identificar e sugerir solução para erros comuns
                if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
                  this.logger.warn(`[ORION] 💡 Saldo insuficiente detectado. Verifique o saldo da conta.`);
                } else if (errorMessage.toLowerCase().includes('invalid') && errorMessage.toLowerCase().includes('amount')) {
                  this.logger.warn(`[ORION] 💡 Valor inválido. Verifique se o valor está dentro dos limites permitidos (mínimo: $0.35).`);
                } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
                  this.logger.warn(`[ORION] 💡 Rate limit atingido. Aguarde alguns segundos antes de tentar novamente.`);
                }
                
                ws.close();
                resolve(null);
              }
              return;
            }
            
            proposalId = msg.proposal.id;
            const proposalPrice = Number(msg.proposal.ask_price);
            
            // ✅ Validar se a proposta foi recebida corretamente
            if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(timeout);
                const errorResponse = JSON.stringify(msg.proposal);
                this.logger.error(`[ORION] ❌ Proposta inválida recebida: ${errorResponse}`);
                if (userId) {
                  this.saveOrionLog(userId, 'R_10', 'erro', `❌ Proposta inválida da Deriv | Resposta: ${errorResponse}`);
                }
                ws.close();
                resolve(null);
              }
              return;
            }
            
            this.logger.debug(`[ORION] 📊 Proposta recebida: ID=${proposalId}, Preço=${proposalPrice}, Executando compra...`);
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
                
                const errorResponse = JSON.stringify(msg.buy);
                const errorCode = msg.buy.error?.code || '';
                const errorMessage = msg.buy.error?.message || JSON.stringify(msg.buy.error);
                
                this.logger.error(
                  `[ORION] ❌ Erro ao comprar contrato: ${JSON.stringify(msg.buy.error)} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | ProposalId: ${proposalId}`,
                );
                
                if (userId) {
                  this.saveOrionLog(userId, 'R_10', 'erro', `❌ Erro ao comprar contrato na Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`);
                  
                  if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
                    this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Saldo insuficiente na Deriv.`);
                  } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
                    this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Rate limit atingido na Deriv.`);
                  }
                }
                
                resolve(null);
              }
              return;
            }
            
            // ✅ Contrato criado com sucesso - NÃO fechar WS, iniciar monitoramento no mesmo WS
            const contractId = msg.buy.contract_id;
            contractCreated = true;
            createdContractId = contractId;
            
            // ✅ Cancelar timeout de criação e iniciar timeout de monitoramento (60s)
            clearTimeout(timeout);
            startContractMonitorTimeout(contractId);
            
            this.logger.log(`[ORION] ✅ Contrato criado: ${contractId} | Monitorando no mesmo WS (max 60s)...`);
            
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
              const contractId = contract.contract_id;
              
              this.logger.log(`[ORION] ✅ Contrato ${contractId} finalizado | Profit: $${profit.toFixed(2)} | Status: ${contract.status}`);
              
              ws.close();
              resolve({ contractId, profit, exitSpot: contract.exit_spot || contract.current_spot });
            }
            return;
          }
        } catch (error) {
          if (!hasResolved) {
            hasResolved = true;
            clearTimeout(timeout);
            if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
            this.logger.error(`[ORION] ❌ Erro ao processar mensagem WebSocket:`, error);
            if (userId) {
              this.saveOrionLog(userId, 'R_10', 'erro',
                `Erro ao processar mensagem WebSocket na criação do contrato | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            }
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
          this.logger.error(
            `[ORION] ❌ Erro no WebSocket: ${error.message} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`,
          );
          if (userId) {
            this.saveOrionLog(userId, 'R_10', 'erro',
              `Erro de conexão ao criar contrato | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
          }
          resolve(null);
        }
      });

      ws.on('close', (code, reason) => {
        if (!hasResolved) {
          hasResolved = true;
          clearTimeout(timeout);
          if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
          this.logger.warn(
            `[ORION] ⚠️ WebSocket fechado antes de completar | Code: ${code} | Reason: ${reason?.toString()} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`,
          );
          if (userId) {
            this.saveOrionLog(userId, 'R_10', 'erro',
              `WebSocket fechado antes de completar | Code: ${code} | Reason: ${reason?.toString()} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);
          }
          resolve(null);
        }
      });
    });
  }

  /**
   * ✅ ORION: Processa resultado da operação (Soros/Martingale)
   */
  private async processOrionResult(
    state: VelozUserState | ModeradoUserState | PrecisoUserState,
    stakeAmount: number,
    operation: DigitParity,
    profit: number,
    mode: string,
  ): Promise<void> {
    // Atualizar estado do usuário
    state.isOperationActive = false;
    state.capital += profit;
    
    if (profit > 0) {
      // ✅ VITÓRIA: Verificar se estava em martingale ANTES de processar Soros
      const estavaEmMartingale = (state.perdaAcumulada || 0) > 0;
      
      // Resetar martingale primeiro
      if ('perdaAcumulada' in state) state.perdaAcumulada = 0;
      if ('ultimaDirecaoMartingale' in state) state.ultimaDirecaoMartingale = null;
      if ('martingaleStep' in state) state.martingaleStep = 0;
      
      if (estavaEmMartingale) {
        // Se estava em martingale, NÃO aplicar Soros
        if ('vitoriasConsecutivas' in state) state.vitoriasConsecutivas = 0;
        if ('ultimoLucro' in state) state.ultimoLucro = 0;
        if ('apostaBase' in state) state.apostaBase = state.apostaInicial || 0.35;
        
        this.logger.log(`[ORION][${mode}][${state.userId}] ✅ Recuperou perdas do martingale!`);
        this.saveOrionLog(state.userId, 'R_10', 'resultado', `✅ Recuperou perdas do martingale!`);
      } else {
        // NÃO estava em martingale: aplicar Soros
        if ('vitoriasConsecutivas' in state) {
          state.vitoriasConsecutivas = (state.vitoriasConsecutivas || 0) + 1;
        }
        
        if (state.vitoriasConsecutivas === 3) {
          // Ciclo Soros completo
          this.logger.log(`[ORION][${mode}][${state.userId}] 🎉 SOROS CICLO PERFEITO!`);
          this.saveOrionLog(state.userId, 'R_10', 'resultado', `🎉 SOROS CICLO PERFEITO! 3 vitórias consecutivas`);
          state.vitoriasConsecutivas = 0;
          state.ultimoLucro = 0;
          state.apostaBase = state.apostaInicial || 0.35;
        } else {
          if ('ultimoLucro' in state) state.ultimoLucro = profit;
          if ('apostaBase' in state) state.apostaBase = stakeAmount;
          
          if (state.vitoriasConsecutivas <= SOROS_MAX_NIVEL) {
            const proximaApostaSoros = calcularApostaComSoros(stakeAmount, profit, state.vitoriasConsecutivas);
            if (proximaApostaSoros !== null) {
              this.saveOrionLog(state.userId, 'R_10', 'resultado', `💰 SOROS Nível ${state.vitoriasConsecutivas} | Próxima: $${proximaApostaSoros.toFixed(2)}`);
            }
          }
        }
      }
      
      this.saveOrionLog(state.userId, 'R_10', 'resultado', `✅ GANHOU | ${operation} | P&L: +$${profit.toFixed(2)}`);
    } else {
      // ❌ PERDA: Resetar Soros e ativar martingale
      if ('vitoriasConsecutivas' in state) state.vitoriasConsecutivas = 0;
      if ('ultimoLucro' in state) state.ultimoLucro = 0;
      
      // Ativar martingale
      if ('perdaAcumulada' in state) {
        state.perdaAcumulada = (state.perdaAcumulada || 0) + stakeAmount;
      }
      if ('ultimaDirecaoMartingale' in state) {
        state.ultimaDirecaoMartingale = operation;
      }
      if ('martingaleStep' in state) {
        state.martingaleStep = (state.martingaleStep || 0) + 1;
      }
      
      this.logger.log(`[ORION][${mode}][${state.userId}] ❌ PERDA | Perda acumulada: $${state.perdaAcumulada?.toFixed(2)}`);
      this.saveOrionLog(state.userId, 'R_10', 'resultado', `❌ PERDEU | ${operation} | P&L: -$${Math.abs(profit).toFixed(2)}`);
    }
  }

  /**
   * ✅ ORION: Monitora contrato e processa resultado (LEGADO - não mais usado)
   */
  private async monitorOrionContract(
    contractId: string,
    state: VelozUserState | ModeradoUserState | PrecisoUserState,
    stakeAmount: number,
    operation: DigitParity,
    tradeId: number,
    mode: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.logger.log(`[ORION][${mode}] 🔍 Iniciando monitoramento do contrato ${contractId} (tradeId: ${tradeId})`);
      
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      const timeout = setTimeout(async () => {
        ws.close();
        state.isOperationActive = false;
        this.logger.warn(`[ORION][${mode}] ⏱️ Timeout ao monitorar contrato ${contractId}`);
        
        // ✅ Marcar trade como ERROR no banco de dados
        await this.dataSource.query(
          `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [`Timeout ao monitorar contrato ${contractId} (15s)`, tradeId],
        ).catch(err => {
          this.logger.error(`[ORION] Erro ao atualizar trade com status ERROR (timeout):`, err);
        });
        
        // ✅ Log de erro com informações do timeout
        this.saveOrionLog(state.userId, 'R_10', 'erro', `⏱️ Timeout ao monitorar contrato ${contractId} após 15 segundos - Operação cancelada | Contrato não finalizou no tempo esperado`);
        
        // ✅ NÃO incrementar perdaAcumulada quando for erro
        // ✅ Resetar contador de ticks para permitir nova tentativa
        if ('ticksDesdeUltimaOp' in state) {
          state.ticksDesdeUltimaOp = 0;
        }
        
        resolve();
      }, 15000); // ✅ 15 segundos (contrato dura apenas 1 segundo, então 15s é mais que suficiente)

      ws.on('open', () => {
        this.logger.debug(`[ORION][${mode}] 🔌 WebSocket aberto para monitoramento do contrato ${contractId}`);
        ws.send(JSON.stringify({ authorize: state.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.authorize) {
            this.logger.debug(`[ORION][${mode}] ✅ Autorizado, inscrevendo no contrato ${contractId}`);
            ws.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: contractId,
              subscribe: 1,
            }));
            return;
          }

          if (msg.proposal_open_contract) {
            const contract = msg.proposal_open_contract;
            this.logger.debug(`[ORION][${mode}] 📊 Atualização do contrato ${contractId}: is_sold=${contract.is_sold} (tipo: ${typeof contract.is_sold}), status=${contract.status}, profit=${contract.profit}`);
            
            // ✅ Verificar se contrato foi rejeitado, cancelado ou expirado
            if (contract.status === 'rejected' || contract.status === 'cancelled' || contract.status === 'expired') {
              clearTimeout(timeout);
              ws.close();
              state.isOperationActive = false;
              
              const errorMsg = `Contrato ${contract.status}: ${contract.error_message || 'Sem mensagem de erro'}`;
              const errorResponse = JSON.stringify(contract);
              this.logger.error(`[ORION][${mode}] ❌ Contrato ${contractId} foi ${contract.status}:`, errorMsg);
              
              // ✅ Marcar trade como ERROR no banco de dados
              await this.dataSource.query(
                `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
                [errorMsg, tradeId],
              ).catch(err => {
                this.logger.error(`[ORION] Erro ao atualizar trade com status ERROR (${contract.status}):`, err);
              });
              
              // ✅ Log de erro com resposta completa da API
              this.saveOrionLog(state.userId, 'R_10', 'erro', `❌ Contrato ${contractId} foi ${contract.status} - Operação cancelada | Resposta Deriv: ${errorResponse}`);
              
              // ✅ NÃO incrementar perdaAcumulada quando for erro
              // ✅ Resetar contador de ticks para permitir nova tentativa
              if ('ticksDesdeUltimaOp' in state) {
                state.ticksDesdeUltimaOp = 0;
              }
              
              resolve();
              return;
            }
            
            // Verificar se contrato foi finalizado
            // Aceitar tanto is_sold (1 ou true) quanto status ('won', 'lost', 'sold')
            const isFinalized = contract.is_sold === 1 || contract.is_sold === true || 
                               contract.status === 'won' || contract.status === 'lost' || contract.status === 'sold';
            
            if (isFinalized) {
              clearTimeout(timeout);
              ws.close();
              
              const profit = Number(contract.profit || 0);
              const exitPrice = Number(contract.exit_spot || contract.current_spot || contract.exit_tick || 0);
              const status = profit >= 0 ? 'WON' : 'LOST';

              this.logger.log(`[ORION][${mode}] ✅ Contrato ${contractId} finalizado: ${status} | P&L: $${profit.toFixed(2)} | Exit: ${exitPrice}`);

              // Atualizar trade no banco
              await this.dataSource.query(
                `UPDATE ai_trades
                 SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
                 WHERE id = ?`,
                [exitPrice, profit, status, tradeId],
              );

              // Emitir evento de atualização
              this.tradeEvents.emit({
                userId: state.userId,
                type: 'updated',
                tradeId,
                status,
                strategy: 'orion',
                profitLoss: profit,
                exitPrice,
              });

              // Atualizar estado do usuário
              state.isOperationActive = false;
              state.capital += profit;
              
              if (profit > 0) {
                // ✅ CORREÇÃO: Verificar se estava em martingale ANTES de processar Soros
                const estavaEmMartingale = (state.perdaAcumulada || 0) > 0;
                
                // ✅ Resetar martingale primeiro (antes de qualquer processamento de Soros)
                if ('perdaAcumulada' in state) {
                  state.perdaAcumulada = 0;
                }
                if ('ultimaDirecaoMartingale' in state) {
                  state.ultimaDirecaoMartingale = null;
                }
                if ('martingaleStep' in state) {
                  state.martingaleStep = 0;
                }
                
                if (estavaEmMartingale) {
                  // ✅ Se estava em martingale, NÃO aplicar Soros
                  // Resetar tudo e aguardar próxima vitória (sem martingale) para iniciar Soros
                  if ('vitoriasConsecutivas' in state) {
                    state.vitoriasConsecutivas = 0; // Resetar contador de vitórias
                  }
                  if ('ultimoLucro' in state) {
                    state.ultimoLucro = 0; // Resetar lucro anterior
                  }
                  if ('apostaBase' in state) {
                    state.apostaBase = state.apostaInicial || state.capital || 0.35; // Resetar para aposta inicial
                  }
                  
                  this.logger.log(
                    `[ORION][${mode}][${state.userId}] ✅ Recuperou perdas do martingale! Resetando tudo. Próxima vitória (sem martingale) iniciará Soros.`,
                  );
                  this.saveOrionLog(state.userId, 'R_10', 'resultado', `✅ Recuperou perdas do martingale! Resetando aposta para: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)}`);
                  this.saveOrionLog(state.userId, 'R_10', 'resultado', `Próxima aposta: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)} (entrada inicial - aguardando próxima vitória para iniciar Soros)`);
                } else {
                  // ✅ NÃO estava em martingale: aplicar Soros normalmente
                  // Incrementar vitórias consecutivas
                  const vitoriasAntes = state.vitoriasConsecutivas || 0;
                  if ('vitoriasConsecutivas' in state) {
                    state.vitoriasConsecutivas = vitoriasAntes + 1;
                  }
                  
                  // ✅ DEBUG: Log do estado antes de processar Soros
                  this.logger.debug(
                    `[ORION][${mode}][${state.userId}] ✅ VITÓRIA | Stake: $${stakeAmount.toFixed(2)} | Lucro: $${profit.toFixed(2)} | Vitórias consecutivas: ${state.vitoriasConsecutivas} | ApostaBase: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)}`,
                  );
                  
                  // ✅ ZENIX v2.0: Se completou Soros nível 2 (3 vitórias consecutivas), reiniciar tudo
                  if (state.vitoriasConsecutivas === 3) {
                    this.logger.log(
                      `[ORION][${mode}][${state.userId}] 🎉 SOROS CICLO PERFEITO! 3 vitórias consecutivas. Reiniciando para entrada inicial.`,
                    );
                    this.saveOrionLog(state.userId, 'R_10', 'resultado', `🎉 SOROS CICLO PERFEITO! 3 vitórias consecutivas`);
                    this.saveOrionLog(state.userId, 'R_10', 'resultado', `Reiniciando para entrada inicial: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)}`);
                    
                    // Resetar tudo
                    state.vitoriasConsecutivas = 0;
                    state.ultimoLucro = 0;
                    state.apostaBase = state.apostaInicial || state.capital || 0.35;
                  } else {
                    // Atualizar lucro e aposta base para próximo Soros
                    if ('ultimoLucro' in state) {
                      state.ultimoLucro = profit;
                    }
                    if ('apostaBase' in state) {
                      // Atualizar apostaBase com o valor da aposta atual para próximo Soros
                      state.apostaBase = stakeAmount;
                    }
                    
                    // ✅ DEBUG: Log do estado após vitória
                    this.logger.debug(
                      `[ORION][${mode}][${state.userId}] ✅ Estado após vitória | Vitórias consecutivas: ${state.vitoriasConsecutivas} | ApostaBase: $${state.apostaBase.toFixed(2)} | UltimoLucro: $${state.ultimoLucro.toFixed(2)}`,
                    );
                    
                    // Log do Soros
                    if (state.vitoriasConsecutivas > 0 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL) {
                      const proximaApostaSoros = calcularApostaComSoros(stakeAmount, profit, state.vitoriasConsecutivas);
                      if (proximaApostaSoros !== null) {
                        this.logger.log(
                          `[ORION][${mode}][${state.userId}] 💰 SOROS Nível ${state.vitoriasConsecutivas} | Próxima aposta: $${proximaApostaSoros.toFixed(2)}`,
                        );
                        this.saveOrionLog(state.userId, 'R_10', 'resultado', `💰 SOROS Nível ${state.vitoriasConsecutivas} | Próxima aposta: $${proximaApostaSoros.toFixed(2)}`);
                      } else {
                        this.logger.warn(
                          `[ORION][${mode}][${state.userId}] ⚠️ calcularApostaComSoros retornou null | Vitórias: ${state.vitoriasConsecutivas} | Stake: $${stakeAmount.toFixed(2)} | Lucro: $${profit.toFixed(2)}`,
                        );
                      }
                    } else {
                      // Se não está mais no Soros, logar próxima aposta inicial
                      this.saveOrionLog(state.userId, 'R_10', 'resultado', `Próxima aposta: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)} (entrada inicial)`);
                    }
                  }
                }
              } else {
                // ❌ PERDA: Resetar Soros e ativar martingale
                const entryNumber = (state.martingaleStep || 0) + 1;
                
                // ✅ ZENIX v2.0: Se perder em qualquer entrada do Soros (1, 2 ou 3), resetar Soros
                if (entryNumber <= 3 && state.perdaAcumulada === stakeAmount) {
                  // Perdeu no Soros: resetar Soros e entrar em recuperação
                  if (state.vitoriasConsecutivas > 0) {
                    this.logger.log(
                      `[ORION][${mode}][${state.userId}] ❌ Soros Nível ${state.vitoriasConsecutivas} falhou! Entrando em recuperação (martingale)`,
                    );
                    this.saveOrionLog(state.userId, 'R_10', 'resultado', `❌ Soros Nível ${state.vitoriasConsecutivas} falhou! Entrando em recuperação`);
                  } else {
                    this.logger.log(
                      `[ORION][${mode}][${state.userId}] ❌ Entrada 1 falhou! Entrando em recuperação (martingale)`,
                    );
                  }
                  state.vitoriasConsecutivas = 0;
                  state.ultimoLucro = 0;
                  // perdaAcumulada já será incrementada abaixo
                } else if (entryNumber === 1) {
                  // Perda na primeira entrada (não estava no Soros)
                  state.vitoriasConsecutivas = 0;
                  state.ultimoLucro = 0;
                }
                
                // Ativar martingale
                if ('perdaAcumulada' in state) {
                  // ✅ CORREÇÃO: Somar o stakeAmount (valor apostado), não o profit
                  state.perdaAcumulada = (state.perdaAcumulada || 0) + stakeAmount;
                }
                if ('ultimaDirecaoMartingale' in state) {
                  state.ultimaDirecaoMartingale = operation; // ✅ CORREÇÃO: Salvar direção para continuar martingale
                }
                // ✅ CORREÇÃO: Incrementar martingaleStep após perda
                if ('martingaleStep' in state) {
                  state.martingaleStep = (state.martingaleStep || 0) + 1;
                }
                
                // ✅ Log do martingale
                this.logger.log(
                  `[ORION][${mode}][${state.userId}] ❌ PERDA | Stake: $${stakeAmount.toFixed(2)} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)} | Próxima entrada: ${(state.martingaleStep || 0) + 1}`,
                );
              }

              // Logs do resultado
              this.saveOrionLog(state.userId, 'R_10', 'resultado', 
                `${status === 'WON' ? '✅ GANHOU' : '❌ PERDEU'} | ${operation} | P&L: $${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`);
              
              this.logger.log(
                `[ORION][${mode}] ${status} | User: ${state.userId} | P&L: $${profit.toFixed(2)}`,
              );

              resolve();
            }
          }
        } catch (error) {
          this.logger.error(`[ORION][${mode}] Erro ao monitorar contrato:`, error);
          
          // ✅ Se houver erro no processamento, marcar trade como ERROR
          clearTimeout(timeout);
          ws.close();
          state.isOperationActive = false;
          
          const errorResponse = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
          
          // ✅ Marcar trade como ERROR no banco de dados
          await this.dataSource.query(
            `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
            [`Erro ao processar mensagem: ${error.message || 'Erro desconhecido'}`, tradeId],
          ).catch(err => {
            this.logger.error(`[ORION] Erro ao atualizar trade com status ERROR (catch):`, err);
          });
          
          // ✅ Log de erro com resposta completa
          this.saveOrionLog(state.userId, 'R_10', 'erro', `❌ Erro ao processar contrato ${contractId}: ${error.message || 'Erro desconhecido'} - Operação cancelada | Detalhes: ${errorResponse}`);
          
          // ✅ NÃO incrementar perdaAcumulada quando for erro
          // ✅ Resetar contador de ticks para permitir nova tentativa
          if ('ticksDesdeUltimaOp' in state) {
            state.ticksDesdeUltimaOp = 0;
          }
          
          resolve();
        }
      });

      ws.on('error', async (error) => {
        clearTimeout(timeout);
        this.logger.error(`[ORION][${mode}] ❌ Erro no WebSocket de monitoramento do contrato ${contractId}:`, error);
        state.isOperationActive = false;
        
        const errorResponse = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
        
        // ✅ Marcar trade como ERROR no banco de dados
        await this.dataSource.query(
          `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [`Erro no WebSocket: ${error.message || 'Erro desconhecido'}`, tradeId],
        ).catch(err => {
          this.logger.error(`[ORION] Erro ao atualizar trade com status ERROR (websocket):`, err);
        });
        
        // ✅ Log de erro com detalhes completos
        this.saveOrionLog(state.userId, 'R_10', 'erro', `❌ Erro no WebSocket ao monitorar contrato ${contractId} - Operação cancelada | Detalhes: ${errorResponse}`);
        
        // ✅ NÃO incrementar perdaAcumulada quando for erro
        // ✅ Resetar contador de ticks para permitir nova tentativa
        if ('ticksDesdeUltimaOp' in state) {
          state.ticksDesdeUltimaOp = 0;
        }
        
        resolve();
      });

      ws.on('close', () => {
        this.logger.debug(`[ORION][${mode}] 🔌 WebSocket fechado para contrato ${contractId}`);
      });
    });
  }

  private upsertVelozUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const apostaInicial = params.apostaInicial || 0.35; // Usar apostaInicial se fornecido, senão 0.35
    const existing = this.velozUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
        // ✅ Atualizar aposta inicial se fornecido
        apostaInicial: params.apostaInicial || existing.apostaInicial,
        apostaBase: params.apostaInicial || existing.apostaBase,
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
      });
    } else {
      this.velozUsers.set(params.userId, {
        userId: params.userId,
        derivToken: params.derivToken,
        currency: params.currency,
        capital: params.stakeAmount,
        virtualCapital: params.stakeAmount,
        lossVirtualActive: false,
        lossVirtualCount: 0,
        lossVirtualOperation: null,
        isOperationActive: false,
        martingaleStep: 0,
        modoMartingale: params.modoMartingale || 'conservador',
        perdaAcumulada: 0,
        apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: apostaInicial, // ✅ Base para cálculos
        ultimoLucro: 0,
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
      });
    }
  }

  private upsertModeradoUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const apostaInicial = params.apostaInicial || 0.35; // Usar apostaInicial se fornecido, senão 0.35
    const existing = this.moderadoUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
        // ✅ Atualizar aposta inicial se fornecido
        apostaInicial: params.apostaInicial || existing.apostaInicial,
        apostaBase: params.apostaInicial || existing.apostaBase,
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
      });
    } else {
      this.moderadoUsers.set(params.userId, {
        userId: params.userId,
        derivToken: params.derivToken,
        currency: params.currency,
        capital: params.stakeAmount,
        virtualCapital: params.stakeAmount,
        lossVirtualActive: false,
        lossVirtualCount: 0,
        lossVirtualOperation: null,
        isOperationActive: false,
        martingaleStep: 0,
        modoMartingale: params.modoMartingale || 'conservador',
        perdaAcumulada: 0,
        apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
        lastOperationTimestamp: null,
        vitoriasConsecutivas: 0,
        apostaBase: apostaInicial, // ✅ Base para cálculos
        ultimoLucro: 0,
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
      });
    }
  }

  private upsertPrecisoUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const apostaInicial = params.apostaInicial || 0.35; // Usar apostaInicial se fornecido, senão 0.35
    const existing = this.precisoUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
        // ✅ Atualizar aposta inicial se fornecido
        apostaInicial: params.apostaInicial || existing.apostaInicial,
        apostaBase: params.apostaInicial || existing.apostaBase,
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
      });
    } else {
      this.precisoUsers.set(params.userId, {
        userId: params.userId,
        derivToken: params.derivToken,
        currency: params.currency,
        capital: params.stakeAmount,
        virtualCapital: params.stakeAmount,
        lossVirtualActive: false,
        lossVirtualCount: 0,
        lossVirtualOperation: null,
        isOperationActive: false,
        martingaleStep: 0,
        modoMartingale: params.modoMartingale || 'conservador',
        perdaAcumulada: 0,
        apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
        vitoriasConsecutivas: 0,
        apostaBase: apostaInicial, // ✅ Base para cálculos
        ultimoLucro: 0,
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
      });
    }
  }

  // Getters para acesso externo
  getTicks(): Tick[] {
    return this.ticks;
  }

  getVelozUsers(): Map<string, VelozUserState> {
    return this.velozUsers;
  }

  getModeradoUsers(): Map<string, ModeradoUserState> {
    return this.moderadoUsers;
  }

  getPrecisoUsers(): Map<string, PrecisoUserState> {
    return this.precisoUsers;
  }

  /**
   * ✅ ORION: Sistema de Logs Detalhados
   * Salva log de forma assíncrona (não bloqueia execução)
   */
  private saveOrionLog(
    userId: string,
    symbol: string,
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

    // Processar fila em background (não bloqueia)
    this.processOrionLogQueue().catch(error => {
      this.logger.error(`[ORION][SaveLog] Erro ao processar fila de logs:`, error);
    });
  }

  /**
   * ✅ ORION: Processa fila de logs em batch (otimizado)
   */
  private async processOrionLogQueue(): Promise<void> {
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

      // Agrupar por userId para otimizar
      const logsByUser = new Map<string, typeof batch>();
      for (const log of batch) {
        if (!logsByUser.has(log.userId)) {
          logsByUser.set(log.userId, []);
        }
        logsByUser.get(log.userId)!.push(log);
      }

      // Salvar logs por usuário
      for (const [userId, logs] of logsByUser.entries()) {
        await this.saveOrionLogsBatch(userId, logs);
      }
    } catch (error) {
      this.logger.error(`[ORION][ProcessLogQueue] Erro ao processar logs:`, error);
    } finally {
      this.logProcessing = false;

      // Se ainda há logs na fila, processar novamente
      if (this.logQueue.length > 0) {
        setImmediate(() => this.processOrionLogQueue());
      }
    }
  }

  /**
   * ✅ ORION: Salva batch de logs no banco
   */
  private async saveOrionLogsBatch(userId: string, logs: typeof this.logQueue): Promise<void> {
    if (logs.length === 0) return;

    try {
      const icons: Record<string, string> = {
        'info': 'ℹ️',
        'tick': '📊',
        'analise': '🔍',
        'sinal': '🎯',
        'operacao': '⚡',
        'resultado': '💰',
        'alerta': '⚠️',
        'erro': '❌',
      };

      const placeholders = logs.map(() => '(?, ?, ?, ?, ?, NOW())').join(', ');
      const flatValues: any[] = [];

      for (const log of logs) {
        const icon = icons[log.type] || 'ℹ️';
        const detailsJson = log.details ? JSON.stringify(log.details) : JSON.stringify({ symbol: log.symbol });
        
        flatValues.push(
          userId,
          log.type,
          icon,
          log.message,
          detailsJson,
        );
      }

      await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, type, icon, message, details, timestamp)
         VALUES ${placeholders}`,
        flatValues,
      );
      
      this.logger.debug(`[ORION][SaveLogsBatch][${userId}] ✅ ${logs.length} logs salvos com sucesso`);
    } catch (error) {
      this.logger.error(`[ORION][SaveLogsBatch][${userId}] Erro ao salvar logs:`, error);
    }
  }
}

