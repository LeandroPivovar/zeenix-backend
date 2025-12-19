import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
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
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
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

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
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
        const proximaEntrada = state.martingaleStep + 1;
        this.logger.log(
          `[ORION][Veloz][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
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
        const proximaEntrada = state.martingaleStep + 1;
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
        const proximaEntrada = state.martingaleStep + 1;
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
    if (state.isOperationActive) {
      this.logger.warn(`[ORION][${mode}] Usuário ${state.userId} já possui operação ativa`);
      return;
    }

    state.isOperationActive = true;
    state.martingaleStep = entry - 1; // entry começa em 1, martingaleStep em 0

    // Resetar contador de ticks
    if ('ticksDesdeUltimaOp' in state) {
      state.ticksDesdeUltimaOp = 0;
    }

    // Atualizar timestamp da última operação (Moderado)
    if ('lastOperationTimestamp' in state) {
      state.lastOperationTimestamp = new Date();
    }

    // Calcular stake baseado no martingale
    let stakeAmount: number;
    if (entry === 1) {
      // Primeira entrada: usar aposta inicial
      stakeAmount = state.apostaInicial || state.capital || 0.35;
    } else {
      // Martingale: calcular próxima aposta
      const payoutCliente = 92; // Payout padrão (95 - 3)
      stakeAmount = calcularProximaAposta(state.perdaAcumulada, state.modoMartingale, payoutCliente);
      
      // Garantir valor mínimo
      if (stakeAmount < 0.35) {
        stakeAmount = 0.35;
      }
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
    }

    try {
      // Criar registro de trade
      const tradeId = await this.createOrionTradeRecord(
        state.userId,
        operation,
        stakeAmount,
        currentPrice,
        mode,
      );

      // Executar trade via WebSocket
      const contractId = await this.executeOrionTradeViaWebSocket(
        state.derivToken,
        {
          contract_type: operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
          amount: stakeAmount,
          currency: state.currency || 'USD',
        },
      );

      if (!contractId) {
        state.isOperationActive = false;
        this.saveOrionLog(state.userId, 'R_10', 'erro', `Erro ao executar operação | Não foi possível criar contrato`);
        return;
      }

      // Atualizar trade com contractId
      await this.dataSource.query(
        `UPDATE ai_trades SET contract_id = ?, status = 'ACTIVE', started_at = NOW() WHERE id = ?`,
        [contractId, tradeId],
      );

      // Monitorar contrato
      await this.monitorOrionContract(contractId, state, stakeAmount, operation, tradeId, mode);
    } catch (error) {
      this.logger.error(`[ORION][${mode}] Erro ao executar operação:`, error);
      state.isOperationActive = false;
      this.saveOrionLog(state.userId, 'R_10', 'erro', `Erro ao executar operação: ${error.message}`);
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
    return result?.insertId || null;
  }

  /**
   * ✅ ORION: Executa trade via WebSocket
   */
  private async executeOrionTradeViaWebSocket(
    token: string,
    contractParams: {
      contract_type: 'DIGITEVEN' | 'DIGITODD';
      amount: number;
      currency: string;
    },
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      let proposalId: string | null = null;
      
      const timeout = setTimeout(() => {
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
              duration: 1,
              duration_unit: 't',
              symbol: this.symbol,
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
            
            ws.send(JSON.stringify({
              buy: proposalId,
              price: proposalPrice,
            }));
            return;
          }

          if (msg.buy) {
            clearTimeout(timeout);
            ws.close();
            
            if (msg.buy.error) {
              resolve(null);
              return;
            }
            
            resolve(msg.buy.contract_id);
            return;
          }
        } catch (error) {
          this.logger.error(`[ORION] Erro ao processar mensagem WebSocket:`, error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error(`[ORION] Erro no WebSocket:`, error);
        resolve(null);
      });
    });
  }

  /**
   * ✅ ORION: Monitora contrato e processa resultado
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

      const timeout = setTimeout(() => {
        ws.close();
        state.isOperationActive = false;
        this.logger.warn(`[ORION][${mode}] ⏱️ Timeout ao monitorar contrato ${contractId}`);
        resolve();
      }, 120000); // 2 minutos

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

              // Atualizar estado do usuário
              state.isOperationActive = false;
              state.capital += profit;
              
              if (profit > 0) {
                // ✅ VITÓRIA: Resetar martingale
                if ('vitoriasConsecutivas' in state) {
                  state.vitoriasConsecutivas = (state.vitoriasConsecutivas || 0) + 1;
                }
                if ('ultimoLucro' in state) {
                  state.ultimoLucro = profit;
                }
                if ('perdaAcumulada' in state) {
                  state.perdaAcumulada = 0;
                }
                if ('ultimaDirecaoMartingale' in state) {
                  state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale
                }
                if ('martingaleStep' in state) {
                  state.martingaleStep = 0;
                }
              } else {
                // ❌ PERDA: Ativar martingale
                if ('vitoriasConsecutivas' in state) {
                  state.vitoriasConsecutivas = 0;
                }
                if ('perdaAcumulada' in state) {
                  state.perdaAcumulada = (state.perdaAcumulada || 0) + Math.abs(profit);
                }
                if ('ultimaDirecaoMartingale' in state) {
                  state.ultimaDirecaoMartingale = operation; // ✅ CORREÇÃO: Salvar direção para continuar martingale
                }
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
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error(`[ORION][${mode}] ❌ Erro no WebSocket de monitoramento do contrato ${contractId}:`, error);
        state.isOperationActive = false;
        resolve();
      });

      ws.on('close', () => {
        this.logger.debug(`[ORION][${mode}] 🔌 WebSocket fechado para contrato ${contractId}`);
      });
    });
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
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
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
        apostaInicial: params.stakeAmount,
        ticksDesdeUltimaOp: 0,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
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
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
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
        apostaInicial: params.stakeAmount,
        lastOperationTimestamp: null,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
        ultimoLucro: 0,
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
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
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
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
        apostaInicial: params.stakeAmount,
        vitoriasConsecutivas: 0,
        apostaBase: params.stakeAmount,
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

