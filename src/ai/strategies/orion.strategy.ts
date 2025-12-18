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
    } else if (modeLower === 'moderado') {
      this.upsertModeradoUserState({
        userId,
        stakeAmount,
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
      });
    } else if (modeLower === 'preciso') {
      this.upsertPrecisoUserState({
        userId,
        stakeAmount,
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
      });
    }
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

      // TODO: Executar operação
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

      // TODO: Executar operação
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

      // TODO: Executar operação
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
}

