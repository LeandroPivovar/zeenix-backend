import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, ModoMartingale } from './common.types';
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

  constructor(
    private dataSource: DataSource,
  ) {}

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
    const { mode, stakeAmount, derivToken, currency, modoMartingale } = config;
    const modeLower = (mode || 'veloz').toLowerCase();

    if (modeLower === 'veloz') {
      this.upsertVelozUserState({
        userId,
        stakeAmount,
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
        stakeAmount,
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
        stakeAmount,
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

      // ✅ TODO: Executar operação (placeholder - por enquanto só salva logs)
      this.saveOrionLog(userId, 'R_10', 'operacao', `⚠️ Execução de trade ainda não implementada`);
    }
  }

  private async processModeradoStrategies(latestTick: Tick): Promise<void> {
    if (this.moderadoUsers.size === 0) return;
    if (this.ticks.length < MODERADO_CONFIG.amostraInicial) return;

    // Processar cada usuário
    for (const [userId, state] of this.moderadoUsers.entries()) {
      if (state.isOperationActive) continue;

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

      // ✅ TODO: Executar operação (placeholder - por enquanto só salva logs)
      this.saveOrionLog(userId, 'R_10', 'operacao', `⚠️ Execução de trade ainda não implementada`);
    }
  }

  private async processPrecisoStrategies(latestTick: Tick): Promise<void> {
    if (this.precisoUsers.size === 0) return;
    if (this.ticks.length < PRECISO_CONFIG.amostraInicial) return;

    // Processar cada usuário
    for (const [userId, state] of this.precisoUsers.entries()) {
      if (state.isOperationActive) continue;

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

      // ✅ TODO: Executar operação (placeholder - por enquanto só salva logs)
      this.saveOrionLog(userId, 'R_10', 'operacao', `⚠️ Execução de trade ainda não implementada`);
    }
  }

  private upsertVelozUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const existing = this.velozUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || 'conservador',
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
        apostaInicial: params.stakeAmount,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
      });
    }
  }

  private upsertModeradoUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const existing = this.moderadoUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || 'conservador',
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
        apostaInicial: params.stakeAmount,
        lastOperationTimestamp: null,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
      });
    }
  }

  private upsertPrecisoUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const existing = this.precisoUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || 'conservador',
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
        apostaInicial: params.stakeAmount,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
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

