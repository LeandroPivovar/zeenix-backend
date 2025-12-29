import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, LENTA_CONFIG, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';
import { gerarSinalZenix } from './signal-generator';
// ✅ REMOVIDO: DerivWebSocketPoolService - usando WebSocket direto conforme documentação Deriv

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
  ultimaApostaUsada: number; // ✅ Última aposta usada (necessário para cálculo do martingale agressivo)
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number; // Cooldown pós erro/timeout para mitigar rate limit
  consecutive_losses: number; // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
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
  ultimaApostaUsada: number; // ✅ Última aposta usada (necessário para cálculo do martingale agressivo)
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number;
  consecutive_losses: number; // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
  // ✅ PREVISÃO: Campos para rastrear trade pendente e fazer previsão
  pendingTradeId?: number | null;
  pendingTradeOperation?: DigitParity | null; // PAR ou IMPAR
  pendingTradeEntryPrice?: number | null;
  pendingTradeStakeAmount?: number | null;
  predictedStatus?: 'WON' | 'LOST' | null;
  ticksReceivedAfterBuy?: number;
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
  ultimaApostaUsada: number; // ✅ Última aposta usada (necessário para cálculo do martingale agressivo)
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number;
  consecutive_losses: number; // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
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
 * Conforme documentação completa da estratégia ZENIX v2.0
 * 
 * CONSERVADOR: Próxima Aposta = Perda Acumulada / payout (break-even)
 * MODERADO:    Próxima Aposta = (Perda Acumulada × 1.25) / payout (recuperar 100% das perdas + 25% de lucro)
 * AGRESSIVO:   Próxima Aposta = (Perda Acumulada × 1.50) / payout (recuperar 100% das perdas + 50% de lucro)
 * 
 * @param perdasTotais - Total de perdas acumuladas no martingale
 * @param modo - Modo de martingale (conservador/moderado/agressivo)
 * @param payoutCliente - Payout do cliente (0.95 = 95% ou 92 = 92%)
 * @param ultimaAposta - Última aposta feita (não usado mais, mantido para compatibilidade)
 * @returns Valor da próxima aposta calculada
 */
function calcularProximaAposta(
  perdasTotais: number,
  modo: ModoMartingale,
  payoutCliente: number,
  ultimaAposta: number = 0,
): number {
  const PAYOUT = typeof payoutCliente === 'number' && payoutCliente > 1 
    ? payoutCliente / 100  // Se for 92, converter para 0.92
    : payoutCliente;       // Se já for 0.95, usar direto
  
  let aposta = 0;
  
  switch (modo) {
    case 'conservador':
      // Meta: recuperar 100% das perdas (break-even)
      // Fórmula: entrada_próxima = perdas_totais / payout
      aposta = perdasTotais / PAYOUT;
      break;
    case 'moderado':
      // Meta: recuperar 100% das perdas + 25% de lucro
      // Fórmula: entrada_próxima = (perdas_totais × 1.25) / payout
      aposta = (perdasTotais * 1.25) / PAYOUT;
      break;
    case 'agressivo':
      // Meta: recuperar 100% das perdas + 50% de lucro
      // Fórmula: entrada_próxima = (perdas_totais × 1.50) / payout
      aposta = (perdasTotais * 1.50) / PAYOUT;
      break;
  }
  
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
  private lentaUsers = new Map<string, PrecisoUserState>(); // ✅ Modo lenta usa a mesma estrutura de preciso
  
  // ✅ Rastreamento de logs de coleta de dados (para evitar logs duplicados)
  private coletaLogsEnviados = new Map<string, Set<number>>(); // userId -> Set de marcos já logados
  
  // ✅ Rastreamento de logs de intervalo entre operações (para evitar logs duplicados)
  private intervaloLogsEnviados = new Map<string, boolean>(); // userId -> se já logou que está aguardando intervalo

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
  private symbol = 'R_100';

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
    this.logger.log('[ORION] Estratégia ORION inicializada');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    this.ticks.push(tick);
    // ✅ Limitar a 100 ticks para evitar consumo excessivo de memória
    if (this.ticks.length > 100) {
      this.ticks.shift();
    }

    // Log de diagnóstico a cada 50 ticks
    if (this.ticks.length % 50 === 0) {
      this.logger.debug(
        `[ORION] 📊 Ticks: ${this.ticks.length} | Veloz: ${this.velozUsers.size} | Moderado: ${this.moderadoUsers.size} | Preciso: ${this.precisoUsers.size} | Lenta: ${this.lentaUsers.size}`,
      );
    }

    // Processar cada modo
    await this.processVelozStrategies(tick);
    await this.processModeradoStrategies(tick);
    await this.processPrecisoStrategies(tick);
    await this.processLentaStrategies(tick);
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
      
      // ✅ Log imediato: Status de coleta de ticks
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = VELOZ_CONFIG.amostraInicial;
      const ticksFaltando = Math.max(0, amostraNecessaria - ticksAtuais);
      if (ticksFaltando > 0) {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Veloz | Ticks coletados: ${ticksAtuais}/${amostraNecessaria} | Faltam: ${ticksFaltando}`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `✅ Dados suficientes coletados | Modo: Veloz | Ticks disponíveis: ${ticksAtuais} (necessário: ${amostraNecessaria}) | Iniciando operações...`);
      }
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
      
      // ✅ Log imediato: Status de coleta de ticks
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = MODERADO_CONFIG.amostraInicial;
      const ticksFaltando = Math.max(0, amostraNecessaria - ticksAtuais);
      if (ticksFaltando > 0) {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Moderado | Ticks coletados: ${ticksAtuais}/${amostraNecessaria} | Faltam: ${ticksFaltando}`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `✅ Dados suficientes coletados | Modo: Moderado | Ticks disponíveis: ${ticksAtuais} (necessário: ${amostraNecessaria}) | Iniciando operações...`);
      }
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
      
      // ✅ Log imediato: Status de coleta de ticks
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = PRECISO_CONFIG.amostraInicial;
      const ticksFaltando = Math.max(0, amostraNecessaria - ticksAtuais);
      if (ticksFaltando > 0) {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Preciso | Ticks coletados: ${ticksAtuais}/${amostraNecessaria} | Faltam: ${ticksFaltando}`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `✅ Dados suficientes coletados | Modo: Preciso | Ticks disponíveis: ${ticksAtuais} (necessário: ${amostraNecessaria}) | Iniciando operações...`);
      }
    } else if (modeLower === 'lenta' || modeLower === 'lento') {
      // ✅ Suporta tanto "lenta" quanto "lento" (ambos usam a mesma configuração)
      this.logger.log(`[ORION] 🔵 Adicionando usuário ${userId} ao modo lenta/lento`);
      this.upsertLentaUserState({
        userId,
        stakeAmount, // Capital total
        apostaInicial, // Valor de entrada por operação
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
      });
      
      // ✅ Verificar se foi adicionado corretamente
      const userAdded = this.lentaUsers.has(userId);
      this.logger.log(`[ORION] ✅ Usuário ${userId} ${userAdded ? 'adicionado' : 'NÃO FOI ADICIONADO'} ao lentaUsers | Total: ${this.lentaUsers.size}`);
      
      // ✅ Log: Usuário ativado
      this.saveOrionLog(userId, 'SISTEMA', 'info', 
        `Usuário ATIVADO | Modo: ${mode || 'lenta'} | Capital: $${stakeAmount.toFixed(2)} | Martingale: ${modoMartingale || 'conservador'}`);
      
      // ✅ Log imediato: Status de coleta de ticks
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = LENTA_CONFIG.amostraInicial;
      const ticksFaltando = Math.max(0, amostraNecessaria - ticksAtuais);
      if (ticksFaltando > 0) {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Lenta | Ticks coletados: ${ticksAtuais}/${amostraNecessaria} | Faltam: ${ticksFaltando}`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'info', 
          `✅ Dados suficientes coletados | Modo: Lenta | Ticks disponíveis: ${ticksAtuais} (necessário: ${amostraNecessaria}) | Iniciando operações...`);
      }
    } else {
      this.logger.warn(`[ORION] ⚠️ Modo desconhecido: ${modeLower} | Usuário ${userId} não foi ativado`);
    }
    
    this.logger.log(`[ORION] ✅ Usuário ${userId} ativado no modo ${modeLower}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.velozUsers.delete(userId);
    this.moderadoUsers.delete(userId);
    this.precisoUsers.delete(userId);
    this.lentaUsers.delete(userId);
    this.logger.log(`[ORION] Usuário ${userId} desativado`);
  }

  getUserState(userId: string): VelozUserState | ModeradoUserState | PrecisoUserState | null {
    return this.velozUsers.get(userId) || 
           this.moderadoUsers.get(userId) || 
           this.precisoUsers.get(userId) || 
           this.lentaUsers.get(userId) || 
           null;
  }

  /**
   * ✅ NOVO: Detector de Ruído de Mercado (Anti-Ping-Pong)
   * Retorna true se os últimos 4 ticks alternaram perfeitamente (ex: P, I, P, I)
   */
  private isPingPong(lastDigits: number[]): boolean {
    if (lastDigits.length < 4) return false;
    const last4 = lastDigits.slice(-4);
    // Converte para 0 (Par) e 1 (Ímpar)
    const types = last4.map(d => d % 2);
    // Padrões de alternância perfeita (0=Par, 1=Ímpar)
    // Verifica se [0,1,0,1] ou [1,0,1,0]
    if ((types[0] === 0 && types[1] === 1 && types[2] === 0 && types[3] === 1) ||
        (types[0] === 1 && types[1] === 0 && types[2] === 1 && types[3] === 0)) {
      return true;
    }
    return false;
  }

  /**
   * ✅ NOVO: Check Signal - Estratégia Híbrida Dual-Core
   * Substitui gerarSinalZenix para os modos Veloz, Normal e Preciso
   * Implementa decisão adaptativa entre Reversão e Sequência baseada em aceleração
   */
  private check_signal(
    state: VelozUserState | ModeradoUserState | PrecisoUserState,
    currentMode: 'veloz' | 'moderado' | 'preciso',
  ): DigitParity | null {
    // Precisa de histórico mínimo para calcular aceleração
    if (this.ticks.length < 20) return null;

    // =================================================================
    // 🚨 MODO DEFENSIVO AUTOMÁTICO
    // Lógica: Se tiver 3 ou mais losses seguidos, força o modo PRECISO.
    // Reversão: Ao ganhar, 'consecutive_losses' vira 0 e o 'else' restaura o modo.
    // =================================================================
    const consecutiveLosses = state.consecutive_losses || 0;
    let effectiveMode: 'veloz' | 'moderado' | 'preciso' = currentMode;
    
    if (consecutiveLosses >= 3) {
      this.logger.log(`🚨 [DEFESA ATIVA] ${consecutiveLosses} Losses seguidos. Forçando filtros de alta precisão.`);
      this.saveOrionLog(state.userId, 'R_10', 'alerta', `🚨 [DEFESA ATIVA] ${consecutiveLosses} Losses seguidos. Forçando modo PRECISO temporariamente.`);
      effectiveMode = 'preciso'; // Sobrescreve temporariamente para Sniper
    }

    // 1. Configuração dos Modos (A "Calibragem")
    let THRESHOLD_PCT: number;
    let THRESHOLD_ACCEL: number;
    let ALLOW_REVERSAL: boolean;
    let USE_PING_PONG: boolean;

    if (effectiveMode === 'veloz') {
      THRESHOLD_PCT = 0.55; // 55% (Agressivo)
      THRESHOLD_ACCEL = -0.10; // Aceita desaceleração leve
      ALLOW_REVERSAL = true;
      USE_PING_PONG = true; // [ATIVO] Proteção contra ruído necessária aqui
    } else if (effectiveMode === 'moderado') {
      THRESHOLD_PCT = 0.60; // 60% (Padrão)
      THRESHOLD_ACCEL = 0.0; // Estável ou subindo
      ALLOW_REVERSAL = true;
      USE_PING_PONG = false; // Desnecessário (filtro de % já resolve)
    } else { // preciso
      THRESHOLD_PCT = 0.70; // 70% (Exigente)
      THRESHOLD_ACCEL = 0.05; // Aceleração forte (+5%)
      ALLOW_REVERSAL = false; // [DESATIVADO] Só surfa a favor (Segurança máx)
      USE_PING_PONG = false;
    }

    // 2. Preparação dos Dados
    const lastDigits = this.ticks.map(t => t.digit);
    
    // [NOVO] Filtro Anti-Ping-Pong (Só roda se ativado pelo modo)
    if (USE_PING_PONG && this.isPingPong(lastDigits)) {
      this.logger.log(`⚠️ [${effectiveMode.toUpperCase()}] Ping-Pong detectado. Entrada bloqueada.`);
      this.saveOrionLog(state.userId, 'R_10', 'info', `⚠️ [${effectiveMode.toUpperCase()}] Ping-Pong detectado. Entrada bloqueada para evitar ruído.`);
      return null;
    }

    // Análises Estatísticas (4 Pilares)
    const last10 = lastDigits.slice(-10);
    const last20 = lastDigits.slice(-20);
    const evens = last10.filter(d => d % 2 === 0);
    const evenPct = evens.length / 10;
    const last20Evens = last20.filter(d => d % 2 === 0);
    const evenAccel = evenPct - (last20Evens.length / 20);

    // 3. Decisão Híbrida (Dual-Core)
    // --- CENÁRIO: PAR DOMINANDO ---
    if (evenPct >= THRESHOLD_PCT) {
      // Modo Sequência (Surfando a Onda)
      if (evenAccel >= THRESHOLD_ACCEL) {
        this.logger.log(`🌊 [${effectiveMode.toUpperCase()}] Tendência PAR (${(evenPct * 100).toFixed(0)}%). Surfando.`);
        this.saveOrionLog(state.userId, 'R_10', 'sinal', `🌊 [${effectiveMode.toUpperCase()}] Tendência PAR (${(evenPct * 100).toFixed(0)}%). Modo Sequência - Surfando.`);
        return 'PAR';
      }
      // Modo Reversão (Aposta Contra)
      else if (ALLOW_REVERSAL && evenAccel < 0) {
        this.logger.log(`🔄 [${effectiveMode.toUpperCase()}] Saturação PAR. Revertendo.`);
        this.saveOrionLog(state.userId, 'R_10', 'sinal', `🔄 [${effectiveMode.toUpperCase()}] Saturação PAR. Modo Reversão - Apostando contra.`);
        return 'IMPAR';
      }
    }
    // --- CENÁRIO: ÍMPAR DOMINANDO ---
    else if (evenPct <= (1.0 - THRESHOLD_PCT)) {
      const oddPct = 1.0 - evenPct;
      const oddAccel = -evenAccel;
      // Modo Sequência
      if (oddAccel >= THRESHOLD_ACCEL) {
        this.logger.log(`🌊 [${effectiveMode.toUpperCase()}] Tendência ÍMPAR (${(oddPct * 100).toFixed(0)}%). Surfando.`);
        this.saveOrionLog(state.userId, 'R_10', 'sinal', `🌊 [${effectiveMode.toUpperCase()}] Tendência ÍMPAR (${(oddPct * 100).toFixed(0)}%). Modo Sequência - Surfando.`);
        return 'IMPAR';
      }
      // Modo Reversão
      else if (ALLOW_REVERSAL && oddAccel < 0) {
        this.logger.log(`🔄 [${effectiveMode.toUpperCase()}] Saturação ÍMPAR. Revertendo.`);
        this.saveOrionLog(state.userId, 'R_10', 'sinal', `🔄 [${effectiveMode.toUpperCase()}] Saturação ÍMPAR. Modo Reversão - Apostando contra.`);
        return 'PAR';
      }
    }

    return null;
  }

  // Métodos privados para processamento
  private async processVelozStrategies(latestTick: Tick): Promise<void> {
    if (this.velozUsers.size === 0) {
      this.logger.debug(`[ORION][Veloz] Nenhum usuário ativo (total: ${this.velozUsers.size})`);
      return;
    }
    
    if (this.ticks.length < VELOZ_CONFIG.amostraInicial) {
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = VELOZ_CONFIG.amostraInicial;
      const ticksFaltando = amostraNecessaria - ticksAtuais;
      
      // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
      for (const [userId] of this.velozUsers.entries()) {
        const key = `veloz_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          // Log inicial apenas uma vez
          this.saveOrionLog(userId, 'R_10', 'info', `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Veloz`);
        }
      }
      
      this.logger.debug(`[ORION][Veloz] Coletando amostra inicial (${ticksAtuais}/${amostraNecessaria})`);
      return;
    }
    
    // ✅ Logar quando completar a coleta (apenas uma vez)
    if (this.ticks.length === VELOZ_CONFIG.amostraInicial) {
      for (const [userId] of this.velozUsers.entries()) {
        const key = `veloz_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          // Se ainda não logou que completou, logar agora
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            this.saveOrionLog(userId, 'R_10', 'info', `✅ DADOS COLETADOS | Modo: Veloz | Amostra completa: ${VELOZ_CONFIG.amostraInicial} ticks | Iniciando operações...`);
            // Limpar após um tempo para permitir novo ciclo se necessário
            setTimeout(() => {
              this.coletaLogsEnviados.delete(key);
            }, 60000); // Limpar após 60 segundos
          }
        }
      }
    }

    // Incrementar contador de ticks
    for (const [userId, state] of this.velozUsers.entries()) {
      // ✅ Garantir que ticksDesdeUltimaOp está inicializado
      if (state.ticksDesdeUltimaOp === undefined) {
        state.ticksDesdeUltimaOp = 0;
      }
      state.ticksDesdeUltimaOp += 1;
    }

    // Log de diagnóstico a cada 10 ticks
    if (this.ticks.length % 10 === 0) {
      this.logger.debug(`[ORION][Veloz] 🔄 Processando ${this.velozUsers.size} usuário(s) | Ticks: ${this.ticks.length}`);
    }

    // Processar cada usuário
    for (const [userId, state] of this.velozUsers.entries()) {
      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) {
        this.logger.debug(`[ORION][Veloz][${userId.substring(0, 8)}] Operação ativa, pulando`);
        continue;
      }

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        // Verificar intervalo entre operações (3 ticks)
        if (state.ticksDesdeUltimaOp !== undefined && state.ticksDesdeUltimaOp >= 0) {
          if (state.ticksDesdeUltimaOp < VELOZ_CONFIG.intervaloTicks!) {
            const key = `veloz_intervalo_${userId}`;
            if (!this.intervaloLogsEnviados.has(key)) {
              this.intervaloLogsEnviados.set(key, true);
              const ticksFaltando = VELOZ_CONFIG.intervaloTicks! - state.ticksDesdeUltimaOp;
              this.saveOrionLog(userId, 'R_10', 'info', `⏱️ Aguardando intervalo entre operações | Modo: Veloz | Faltam ${ticksFaltando} tick(s) (${VELOZ_CONFIG.intervaloTicks} ticks mínimo)`);
            }
            this.logger.debug(
              `[ORION][Veloz][${userId}] ⏱️ Aguardando intervalo (martingale): ${state.ticksDesdeUltimaOp}/${VELOZ_CONFIG.intervaloTicks} ticks`,
            );
            continue;
          } else {
            // Limpar flag quando intervalo for completado
            const key = `veloz_intervalo_${userId}`;
            this.intervaloLogsEnviados.delete(key);
          }
        }

        // ✅ Se defesa está ativa, validar a direção do martingale com filtros do modo PRECISO
        if (defesaAtiva) {
          // Validar se a direção do martingale ainda é válida com filtros do modo PRECISO
          const sinalPreciso = this.check_signal(state, 'preciso');
          if (sinalPreciso && sinalPreciso === state.ultimaDirecaoMartingale) {
            // Direção do martingale é válida com filtros do modo PRECISO - continuar martingale
            const proximaEntrada = (state.martingaleStep || 0) + 1;
            this.logger.log(
              `[ORION][Veloz][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
            );
            this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO`);
            
            await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'veloz', proximaEntrada);
            continue;
          } else {
            // Direção do martingale não é válida com filtros do modo PRECISO - gerar novo sinal
            // ✅ CORREÇÃO: Manter perda acumulada e continuar martingale com nova direção
            this.logger.log(
              `[ORION][Veloz][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida em modo PRECISO. Recalculando sinal mas mantendo martingale.`,
            );
            this.saveOrionLog(userId, 'R_10', 'alerta', `🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida. Recalculando sinal em modo PRECISO mas mantendo perda acumulada.`);
            // ✅ NÃO resetar martingale - manter perda acumulada e continuar com nova direção
            // A direção será atualizada quando o novo sinal for gerado
          }
        } else {
          // Defesa não está ativa - continuar martingale normalmente
          this.logger.debug(
            `[ORION][Veloz][${userId}] 🔍 Verificando martingale: perdaAcumulada=$${state.perdaAcumulada.toFixed(2)}, direcao=${state.ultimaDirecaoMartingale}, martingaleStep=${state.martingaleStep || 0}`,
          );
          
          const proximaEntrada = (state.martingaleStep || 0) + 1;
          this.logger.log(
            `[ORION][Veloz][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)} | MartingaleStep: ${state.martingaleStep || 0}`,
          );
          
          await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'veloz', proximaEntrada);
          continue;
        }
      }

      // ✅ Garantir que ticksDesdeUltimaOp está inicializado
      if (state.ticksDesdeUltimaOp === undefined) {
        state.ticksDesdeUltimaOp = 0;
      }
      
      // Verificar intervalo entre operações (3 ticks)
      if (state.ticksDesdeUltimaOp < VELOZ_CONFIG.intervaloTicks!) {
        const key = `veloz_intervalo_${userId}`;
        if (!this.intervaloLogsEnviados.has(key)) {
          this.intervaloLogsEnviados.set(key, true);
          const ticksFaltando = VELOZ_CONFIG.intervaloTicks! - state.ticksDesdeUltimaOp;
          this.saveOrionLog(userId, 'R_10', 'info', `⏱️ Aguardando intervalo entre operações | Modo: Veloz | Faltam ${ticksFaltando} tick(s) (${VELOZ_CONFIG.intervaloTicks} ticks mínimo)`);
        }
        // Log a cada 20 ticks para diagnóstico
        if (this.ticks.length % 20 === 0) {
          this.logger.debug(
            `[ORION][Veloz][${userId.substring(0, 8)}] ⏱️ Aguardando intervalo: ${state.ticksDesdeUltimaOp}/${VELOZ_CONFIG.intervaloTicks} ticks`,
          );
        }
        continue;
      } else {
        // Limpar flag quando intervalo for completado
        const key = `veloz_intervalo_${userId}`;
        this.intervaloLogsEnviados.delete(key);
      }

      // ✅ NOVO: Usar check_signal (Estratégia Híbrida Dual-Core)
      // Se defesa está ativa, usar filtros do modo PRECISO mesmo no modo veloz
      const modoSinal = defesaAtiva ? 'preciso' : 'veloz';
      const sinal = this.check_signal(state, modoSinal);
      if (!sinal) {
        // Log quando não gera sinal (a cada 50 ticks para não poluir)
        if (this.ticks.length % 50 === 0) {
          this.logger.debug(
            `[ORION][Veloz][${userId.substring(0, 8)}] ⚠️ Nenhum sinal gerado`,
          );
        }
        continue;
      }

      this.logger.log(
        `[ORION][Veloz] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal}`);
      
      // ✅ Logs detalhados das 4 análises ZENIX (mantidos para referência/debug)
      // Gerar análise ZENIX apenas para logs (não usada na decisão)
      const sinalZenix = gerarSinalZenix(this.ticks, VELOZ_CONFIG, 'VELOZ');
      
      // ✅ Logs detalhados das 4 análises (conforme documentação) - apenas para referência
      if (sinalZenix) {
        this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0 (referência)`);
        
        const detalhes = sinalZenix.detalhes;
      const deseq = detalhes?.desequilibrio;
      const sequencias = detalhes?.sequencias;
      const microTendencias = detalhes?.microTendencias;
      const forca = detalhes?.forca;
      const confiancaBase = detalhes?.confiancaBase || 0;
      
      // Histórico (últimos 20 ticks)
      const ultimosTicks = this.ticks.slice(-20).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ Histórico (últimos 20): [${ultimosTicks}]`);
      
      // Distribuição
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        const pares = Math.round(deseq.percentualPar * VELOZ_CONFIG.amostraInicial);
        const impares = VELOZ_CONFIG.amostraInicial - pares;
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Distribuição: PAR: ${percPar}% (${pares}/${VELOZ_CONFIG.amostraInicial}) | ÍMPAR: ${percImpar}% (${impares}/${VELOZ_CONFIG.amostraInicial})`);
        
        // Desequilíbrio
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const simboloCheck = deseq.desequilibrio >= VELOZ_CONFIG.desequilibrioMin ? '✅' : '❌';
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}% ${direcaoDeseq} ${simboloCheck} (≥ ${(VELOZ_CONFIG.desequilibrioMin * 100).toFixed(1)}% requerido)`);
      }
      
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 1: Desequilíbrio Base
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 1: Desequilíbrio Base`);
      if (deseq) {
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const direcaoOperar = deseq.operacao || 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${direcaoDeseq}: ${(deseq.desequilibrio * 100).toFixed(1)}% → Operar ${direcaoOperar}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Confiança base: ${confiancaBase.toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 2: Sequências Repetidas
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 2: Sequências Repetidas`);
      const ultimos10Ticks = this.ticks.slice(-10).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos ${Math.min(10, this.ticks.length)} ticks: [${ultimos10Ticks}]`);
      if (sequencias) {
        const atendeRequerido = sequencias.tamanho >= 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Maior sequência: ${sequencias.tamanho} ticks ${sequencias.paridade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${sequencias.bonus > 0 ? '+' : ''}${sequencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 3: Micro-Tendências
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 3: Micro-Tendências`);
      if (microTendencias) {
        const perc10 = microTendencias.curtoPrazoPercPar ? (microTendencias.curtoPrazoPercPar * 100).toFixed(1) : 'N/A';
        const perc20 = microTendencias.medioPrazoPercPar ? (microTendencias.medioPrazoPercPar * 100).toFixed(1) : 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10 vs 20 ticks`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10: PAR ${perc10}% | Últimos 20: PAR ${perc20}%`);
        const aceleracao = microTendencias.aceleracao * 100;
        const direcaoAcel = aceleracao > 0 ? 'PAR acelerando' : 'ÍMPAR acelerando';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Aceleração: ${aceleracao > 0 ? '+' : ''}${aceleracao.toFixed(1)}% (${direcaoAcel})`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${microTendencias.bonus > 0 ? '+' : ''}${microTendencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 4: Força do Desequilíbrio
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 4: Força do Desequilíbrio`);
      if (deseq) {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Desequilíbrio atual: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      if (forca) {
        const atendeRequerido = forca.velocidade > 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Ticks consecutivos com desequilíbrio ≥60%: ${forca.velocidade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${forca.bonus > 0 ? '+' : ''}${forca.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // CONFIANÇA FINAL
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 🎯 CONFIANÇA FINAL`);
      const bonusSeq = sequencias?.bonus || 0;
      const bonusMicro = microTendencias?.bonus || 0;
      const bonusForca = forca?.bonus || 0;
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Base: ${confiancaBase.toFixed(1)}% + Sequências: ${bonusSeq}% + Micro: ${bonusMicro}% + Força: ${bonusForca}%`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Total: ${sinalZenix.confianca.toFixed(1)}% (limitado a 95%)`);
        const confiancaOK = sinalZenix.confianca >= (VELOZ_CONFIG.confianciaMin * 100);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${confiancaOK ? '✅' : '❌'} Confiança: ${sinalZenix.confianca.toFixed(1)}% ${confiancaOK ? '≥' : '<'} ${(VELOZ_CONFIG.confianciaMin * 100).toFixed(1)}% (mínimo)`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│`);
        this.saveOrionLog(userId, 'R_10', 'analise', `└─ ✅ SINAL GERADO (ZENIX - referência)`);
        this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Direção: ${sinalZenix.sinal}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Confiança: ${sinalZenix.confianca.toFixed(1)}%`);
      }

      // ✅ CORREÇÃO: Se defesa está ativa e há perda acumulada, continuar martingale
      let entryNumber = 1;
      if (defesaAtiva && state.perdaAcumulada > 0) {
        // Continuar martingale com nova direção
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        this.logger.log(
          `[ORION][Veloz][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );
        this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo PRECISO`);
      } else {
        // Nova operação normal
        state.ultimaDirecaoMartingale = sinal;
      }
      
      // ✅ Executar operação - usando sinal do novo sistema
      await this.executeOrionOperation(state, sinal, 'veloz', entryNumber);
    }
  }

  private async processModeradoStrategies(latestTick: Tick): Promise<void> {
    if (this.moderadoUsers.size === 0) return;
    
    if (this.ticks.length < MODERADO_CONFIG.amostraInicial) {
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = MODERADO_CONFIG.amostraInicial;
      
      // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
      for (const [userId] of this.moderadoUsers.entries()) {
        const key = `moderado_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          // Log inicial apenas uma vez
          this.saveOrionLog(userId, 'R_10', 'info', `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Moderado`);
        }
      }
      
      return;
    }
    
    // ✅ Logar quando completar a coleta (apenas uma vez)
    if (this.ticks.length === MODERADO_CONFIG.amostraInicial) {
      for (const [userId] of this.moderadoUsers.entries()) {
        const key = `moderado_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          // Se ainda não logou que completou, logar agora
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            this.saveOrionLog(userId, 'R_10', 'info', `✅ DADOS COLETADOS | Modo: Moderado | Amostra completa: ${MODERADO_CONFIG.amostraInicial} ticks | Iniciando operações...`);
            // Limpar após um tempo para permitir novo ciclo se necessário
            setTimeout(() => {
              this.coletaLogsEnviados.delete(key);
            }, 60000); // Limpar após 60 segundos
          }
        }
      }
    }

    // Processar cada usuário
    for (const [userId, state] of this.moderadoUsers.entries()) {
      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        const now = new Date();
        if (state.lastOperationTimestamp) {
          const secondsSinceLastOp = (now.getTime() - state.lastOperationTimestamp.getTime()) / 1000;
          if (secondsSinceLastOp < MODERADO_CONFIG.intervaloSegundos!) {
            const key = `moderado_intervalo_${userId}`;
            if (!this.intervaloLogsEnviados.has(key)) {
              this.intervaloLogsEnviados.set(key, true);
              const segundosFaltando = (MODERADO_CONFIG.intervaloSegundos! - secondsSinceLastOp).toFixed(1);
              this.saveOrionLog(userId, 'R_10', 'info', `⏱️ Aguardando intervalo entre operações | Modo: Moderado | Faltam ~${segundosFaltando}s (${MODERADO_CONFIG.intervaloSegundos}s mínimo)`);
            }
            this.logger.debug(
              `[ORION][Moderado][${userId}] ⏱️ Aguardando intervalo (martingale): ${secondsSinceLastOp.toFixed(1)}/${MODERADO_CONFIG.intervaloSegundos} segundos`,
            );
            continue;
          } else {
            // Limpar flag quando intervalo for completado
            const key = `moderado_intervalo_${userId}`;
            this.intervaloLogsEnviados.delete(key);
          }
        }

        // ✅ Se defesa está ativa, validar a direção do martingale com filtros do modo PRECISO
        if (defesaAtiva) {
          const sinalPreciso = this.check_signal(state, 'preciso');
          if (sinalPreciso && sinalPreciso === state.ultimaDirecaoMartingale) {
            // Direção do martingale é válida com filtros do modo PRECISO - continuar martingale
            const proximaEntrada = (state.martingaleStep || 0) + 1;
            this.logger.log(
              `[ORION][Moderado][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
            );
            this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO`);
            
            await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'moderado', proximaEntrada);
            continue;
          } else {
            // Direção do martingale não é válida com filtros do modo PRECISO - gerar novo sinal
            // ✅ CORREÇÃO: Manter perda acumulada e continuar martingale com nova direção
            this.logger.log(
              `[ORION][Moderado][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida em modo PRECISO. Recalculando sinal mas mantendo martingale.`,
            );
            this.saveOrionLog(userId, 'R_10', 'alerta', `🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida. Recalculando sinal em modo PRECISO mas mantendo perda acumulada.`);
            // ✅ NÃO resetar martingale - manter perda acumulada e continuar com nova direção
            // A direção será atualizada quando o novo sinal for gerado
          }
        } else {
          // Defesa não está ativa - continuar martingale normalmente
          const proximaEntrada = (state.martingaleStep || 0) + 1;
          this.logger.log(
            `[ORION][Moderado][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
          );
          
          await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'moderado', proximaEntrada);
          continue;
        }
      }

      const now = new Date();
      if (state.lastOperationTimestamp) {
        const secondsSinceLastOp = (now.getTime() - state.lastOperationTimestamp.getTime()) / 1000;
        if (secondsSinceLastOp < MODERADO_CONFIG.intervaloSegundos!) {
          const key = `moderado_intervalo_${userId}`;
          if (!this.intervaloLogsEnviados.has(key)) {
            this.intervaloLogsEnviados.set(key, true);
            const segundosFaltando = (MODERADO_CONFIG.intervaloSegundos! - secondsSinceLastOp).toFixed(1);
            this.saveOrionLog(userId, 'R_10', 'info', `⏱️ Aguardando intervalo entre operações | Modo: Moderado | Faltam ~${segundosFaltando}s (${MODERADO_CONFIG.intervaloSegundos}s mínimo)`);
          }
          continue;
        } else {
          // Limpar flag quando intervalo for completado
          const key = `moderado_intervalo_${userId}`;
          this.intervaloLogsEnviados.delete(key);
        }
      }

      // ✅ NOVO: Usar check_signal (Estratégia Híbrida Dual-Core)
      // Se defesa está ativa, usar filtros do modo PRECISO mesmo no modo moderado
      const modoSinal = defesaAtiva ? 'preciso' : 'moderado';
      const sinal = this.check_signal(state, modoSinal);
      if (!sinal) continue;

      this.logger.log(
        `[ORION][Moderado] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal}`);
      
      // ✅ Logs detalhados das 4 análises ZENIX (mantidos para referência/debug)
      // Gerar análise ZENIX apenas para logs (não usada na decisão)
      const sinalZenix = gerarSinalZenix(this.ticks, MODERADO_CONFIG, 'MODERADO');
      if (sinalZenix) {
        // ✅ Logs detalhados das 4 análises (conforme documentação) - apenas para referência
        this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0 (referência)`);
        
        const detalhes = sinalZenix.detalhes;
      const deseq = detalhes?.desequilibrio;
      const sequencias = detalhes?.sequencias;
      const microTendencias = detalhes?.microTendencias;
      const forca = detalhes?.forca;
      const confiancaBase = detalhes?.confiancaBase || 0;
      
      // Histórico (últimos 20 ticks)
      const ultimosTicks = this.ticks.slice(-20).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ Histórico (últimos 20): [${ultimosTicks}]`);
      
      // Distribuição
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        const pares = Math.round(deseq.percentualPar * MODERADO_CONFIG.amostraInicial);
        const impares = MODERADO_CONFIG.amostraInicial - pares;
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Distribuição: PAR: ${percPar}% (${pares}/${MODERADO_CONFIG.amostraInicial}) | ÍMPAR: ${percImpar}% (${impares}/${MODERADO_CONFIG.amostraInicial})`);
        
        // Desequilíbrio
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const simboloCheck = deseq.desequilibrio >= MODERADO_CONFIG.desequilibrioMin ? '✅' : '❌';
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}% ${direcaoDeseq} ${simboloCheck} (≥ ${(MODERADO_CONFIG.desequilibrioMin * 100).toFixed(1)}% requerido)`);
      }
      
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 1: Desequilíbrio Base
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 1: Desequilíbrio Base`);
      if (deseq) {
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const direcaoOperar = deseq.operacao || 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${direcaoDeseq}: ${(deseq.desequilibrio * 100).toFixed(1)}% → Operar ${direcaoOperar}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Confiança base: ${confiancaBase.toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 2: Sequências Repetidas
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 2: Sequências Repetidas`);
      const ultimos10Ticks = this.ticks.slice(-10).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos ${Math.min(10, this.ticks.length)} ticks: [${ultimos10Ticks}]`);
      if (sequencias) {
        const atendeRequerido = sequencias.tamanho >= 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Maior sequência: ${sequencias.tamanho} ticks ${sequencias.paridade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${sequencias.bonus > 0 ? '+' : ''}${sequencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 3: Micro-Tendências
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 3: Micro-Tendências`);
      if (microTendencias) {
        const perc10 = microTendencias.curtoPrazoPercPar ? (microTendencias.curtoPrazoPercPar * 100).toFixed(1) : 'N/A';
        const perc20 = microTendencias.medioPrazoPercPar ? (microTendencias.medioPrazoPercPar * 100).toFixed(1) : 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10 vs 20 ticks`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10: PAR ${perc10}% | Últimos 20: PAR ${perc20}%`);
        const aceleracao = microTendencias.aceleracao * 100;
        const direcaoAcel = aceleracao > 0 ? 'PAR acelerando' : 'ÍMPAR acelerando';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Aceleração: ${aceleracao > 0 ? '+' : ''}${aceleracao.toFixed(1)}% (${direcaoAcel})`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${microTendencias.bonus > 0 ? '+' : ''}${microTendencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 4: Força do Desequilíbrio
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 4: Força do Desequilíbrio`);
      if (deseq) {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Desequilíbrio atual: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      if (forca) {
        const atendeRequerido = forca.velocidade > 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Ticks consecutivos com desequilíbrio ≥60%: ${forca.velocidade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${forca.bonus > 0 ? '+' : ''}${forca.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // CONFIANÇA FINAL
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 🎯 CONFIANÇA FINAL`);
      const bonusSeq = sequencias?.bonus || 0;
      const bonusMicro = microTendencias?.bonus || 0;
      const bonusForca = forca?.bonus || 0;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Base: ${confiancaBase.toFixed(1)}% + Sequências: ${bonusSeq}% + Micro: ${bonusMicro}% + Força: ${bonusForca}%`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Total: ${sinalZenix.confianca.toFixed(1)}% (limitado a 95%)`);
        const confiancaOK = sinalZenix.confianca >= (MODERADO_CONFIG.confianciaMin * 100);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${confiancaOK ? '✅' : '❌'} Confiança: ${sinalZenix.confianca.toFixed(1)}% ${confiancaOK ? '≥' : '<'} ${(MODERADO_CONFIG.confianciaMin * 100).toFixed(1)}% (mínimo)`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│`);
        this.saveOrionLog(userId, 'R_10', 'analise', `└─ ✅ SINAL GERADO (ZENIX - referência)`);
        this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Direção: ${sinalZenix.sinal}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Confiança: ${sinalZenix.confianca.toFixed(1)}%`);
      }

      // ✅ CORREÇÃO: Se defesa está ativa e há perda acumulada, continuar martingale
      let entryNumber = 1;
      if (defesaAtiva && state.perdaAcumulada > 0) {
        // Continuar martingale com nova direção
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        this.logger.log(
          `[ORION][Moderado][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );
        this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo PRECISO`);
      } else {
        // Nova operação normal
        state.ultimaDirecaoMartingale = sinal;
      }
      
      // ✅ Executar operação - usando sinal do novo sistema
      await this.executeOrionOperation(state, sinal, 'moderado', entryNumber);
    }
  }

  private async processPrecisoStrategies(latestTick: Tick): Promise<void> {
    if (this.precisoUsers.size === 0) return;
    
    if (this.ticks.length < PRECISO_CONFIG.amostraInicial) {
      const ticksAtuais = this.ticks.length;
      const amostraNecessaria = PRECISO_CONFIG.amostraInicial;
      
      // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
      for (const [userId] of this.precisoUsers.entries()) {
        const key = `preciso_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          // Log inicial apenas uma vez
          this.saveOrionLog(userId, 'R_10', 'info', `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Preciso`);
        }
      }
      
      return;
    }
    
    // ✅ Logar quando completar a coleta (apenas uma vez)
    if (this.ticks.length === PRECISO_CONFIG.amostraInicial) {
      for (const [userId] of this.precisoUsers.entries()) {
        const key = `preciso_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          // Se ainda não logou que completou, logar agora
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            this.saveOrionLog(userId, 'R_10', 'info', `✅ DADOS COLETADOS | Modo: Preciso | Amostra completa: ${PRECISO_CONFIG.amostraInicial} ticks | Iniciando operações...`);
            // Limpar após um tempo para permitir novo ciclo se necessário
            setTimeout(() => {
              this.coletaLogsEnviados.delete(key);
            }, 60000); // Limpar após 60 segundos
          }
        }
      }
    }

    // Processar cada usuário
    for (const [userId, state] of this.precisoUsers.entries()) {
      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        // ✅ Se defesa está ativa, validar a direção do martingale com filtros do modo PRECISO
        if (defesaAtiva) {
          const sinalPreciso = this.check_signal(state, 'preciso');
          if (sinalPreciso && sinalPreciso === state.ultimaDirecaoMartingale) {
            // Direção do martingale é válida com filtros do modo PRECISO - continuar martingale
            const proximaEntrada = (state.martingaleStep || 0) + 1;
            this.logger.log(
              `[ORION][Preciso][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
            );
            this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO`);
            
            await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'preciso', proximaEntrada);
            continue;
          } else {
            // Direção do martingale não é válida com filtros do modo PRECISO - gerar novo sinal
            this.logger.log(
              `[ORION][Preciso][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida em modo PRECISO. Recalculando sinal mas mantendo martingale.`,
            );
            this.saveOrionLog(userId, 'R_10', 'alerta', `🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida. Recalculando sinal em modo PRECISO mas mantendo perda acumulada.`);
            // ✅ NÃO resetar martingale - manter perda acumulada e continuar com nova direção
            // A direção será atualizada quando o novo sinal for gerado
          }
        } else {
          // Defesa não está ativa - continuar martingale normalmente
          const proximaEntrada = (state.martingaleStep || 0) + 1;
          this.logger.log(
            `[ORION][Preciso][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
          );
          
          await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'preciso', proximaEntrada);
          continue;
        }
      }

      // ✅ NOVO: Usar check_signal (Estratégia Híbrida Dual-Core)
      const sinal = this.check_signal(state, 'preciso');
      if (!sinal) continue;

      this.logger.log(
        `[ORION][Preciso] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal}`);
      
      // ✅ Logs detalhados das 4 análises ZENIX (mantidos para referência/debug)
      // Gerar análise ZENIX apenas para logs (não usada na decisão)
      const sinalZenix = gerarSinalZenix(this.ticks, PRECISO_CONFIG, 'PRECISO');
      if (sinalZenix) {
        // ✅ Logs detalhados das 4 análises (conforme documentação) - apenas para referência
        this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0 (referência)`);
        
        const detalhes = sinalZenix.detalhes;
      const deseq = detalhes?.desequilibrio;
      const sequencias = detalhes?.sequencias;
      const microTendencias = detalhes?.microTendencias;
      const forca = detalhes?.forca;
      const confiancaBase = detalhes?.confiancaBase || 0;
      
      // Histórico (últimos 20 ticks)
      const ultimosTicks = this.ticks.slice(-20).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ Histórico (últimos 20): [${ultimosTicks}]`);
      
      // Distribuição
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        const pares = Math.round(deseq.percentualPar * PRECISO_CONFIG.amostraInicial);
        const impares = PRECISO_CONFIG.amostraInicial - pares;
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Distribuição: PAR: ${percPar}% (${pares}/${PRECISO_CONFIG.amostraInicial}) | ÍMPAR: ${percImpar}% (${impares}/${PRECISO_CONFIG.amostraInicial})`);
        
        // Desequilíbrio
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const simboloCheck = deseq.desequilibrio >= PRECISO_CONFIG.desequilibrioMin ? '✅' : '❌';
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}% ${direcaoDeseq} ${simboloCheck} (≥ ${(PRECISO_CONFIG.desequilibrioMin * 100).toFixed(1)}% requerido)`);
      }
      
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 1: Desequilíbrio Base
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 1: Desequilíbrio Base`);
      if (deseq) {
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const direcaoOperar = deseq.operacao || 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${direcaoDeseq}: ${(deseq.desequilibrio * 100).toFixed(1)}% → Operar ${direcaoOperar}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Confiança base: ${confiancaBase.toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 2: Sequências Repetidas
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 2: Sequências Repetidas`);
      const ultimos10Ticks = this.ticks.slice(-10).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos ${Math.min(10, this.ticks.length)} ticks: [${ultimos10Ticks}]`);
      if (sequencias) {
        const atendeRequerido = sequencias.tamanho >= 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Maior sequência: ${sequencias.tamanho} ticks ${sequencias.paridade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${sequencias.bonus > 0 ? '+' : ''}${sequencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 3: Micro-Tendências
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 3: Micro-Tendências`);
      if (microTendencias) {
        const perc10 = microTendencias.curtoPrazoPercPar ? (microTendencias.curtoPrazoPercPar * 100).toFixed(1) : 'N/A';
        const perc20 = microTendencias.medioPrazoPercPar ? (microTendencias.medioPrazoPercPar * 100).toFixed(1) : 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10 vs 20 ticks`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10: PAR ${perc10}% | Últimos 20: PAR ${perc20}%`);
        const aceleracao = microTendencias.aceleracao * 100;
        const direcaoAcel = aceleracao > 0 ? 'PAR acelerando' : 'ÍMPAR acelerando';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Aceleração: ${aceleracao > 0 ? '+' : ''}${aceleracao.toFixed(1)}% (${direcaoAcel})`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${microTendencias.bonus > 0 ? '+' : ''}${microTendencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 4: Força do Desequilíbrio
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 4: Força do Desequilíbrio`);
      if (deseq) {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Desequilíbrio atual: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      if (forca) {
        const atendeRequerido = forca.velocidade > 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Ticks consecutivos com desequilíbrio ≥60%: ${forca.velocidade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${forca.bonus > 0 ? '+' : ''}${forca.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // CONFIANÇA FINAL
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 🎯 CONFIANÇA FINAL`);
      const bonusSeq = sequencias?.bonus || 0;
      const bonusMicro = microTendencias?.bonus || 0;
      const bonusForca = forca?.bonus || 0;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Base: ${confiancaBase.toFixed(1)}% + Sequências: ${bonusSeq}% + Micro: ${bonusMicro}% + Força: ${bonusForca}%`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Total: ${sinalZenix.confianca.toFixed(1)}% (limitado a 95%)`);
        const confiancaOK = sinalZenix.confianca >= (PRECISO_CONFIG.confianciaMin * 100);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${confiancaOK ? '✅' : '❌'} Confiança: ${sinalZenix.confianca.toFixed(1)}% ${confiancaOK ? '≥' : '<'} ${(PRECISO_CONFIG.confianciaMin * 100).toFixed(1)}% (mínimo)`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│`);
        this.saveOrionLog(userId, 'R_10', 'analise', `└─ ✅ SINAL GERADO (ZENIX - referência)`);
        this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Direção: ${sinalZenix.sinal}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Confiança: ${sinalZenix.confianca.toFixed(1)}%`);
      }

      // ✅ CORREÇÃO: Se defesa está ativa e há perda acumulada, continuar martingale
      let entryNumber = 1;
      if (defesaAtiva && state.perdaAcumulada > 0) {
        // Continuar martingale com nova direção
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        this.logger.log(
          `[ORION][Preciso][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );
        this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo PRECISO`);
      } else {
        // Nova operação normal
        state.ultimaDirecaoMartingale = sinal;
      }
      
      // ✅ Executar operação - usando sinal do novo sistema
      await this.executeOrionOperation(state, sinal, 'preciso', entryNumber);
    }
  }

  private async processLentaStrategies(latestTick: Tick): Promise<void> {
    if (this.lentaUsers.size === 0) {
      this.logger.debug(`[ORION][Lenta] Nenhum usuário ativo (total: ${this.lentaUsers.size})`);
      return;
    }
    
    const ticksAtuais = this.ticks.length;
    const amostraNecessaria = LENTA_CONFIG.amostraInicial;
    
    // ✅ Log de debug para confirmar que o método está sendo chamado
    if (this.lentaUsers.size > 0 && ticksAtuais % 10 === 0) {
      this.logger.debug(`[ORION][Lenta] 🔄 Método chamado | Usuários: ${this.lentaUsers.size} | Ticks: ${ticksAtuais} (necessário: ${amostraNecessaria})`);
    }
    
    // ✅ CORREÇÃO: Como o sistema mantém 100 ticks, sempre teremos pelo menos 50 se houver 100 ticks
    // Se já temos 100 ticks, podemos processar imediatamente (já temos mais que os 50 necessários)
    // Se temos menos que 50 ticks, precisamos aguardar
    if (ticksAtuais < amostraNecessaria) {
      // ✅ Logar progresso periodicamente (a cada 5 ticks ou quando chegar em marcos importantes)
      for (const [userId] of this.lentaUsers.entries()) {
        const key = `lenta_${userId}`;
        const ticksFaltando = amostraNecessaria - ticksAtuais;
        
        // Log inicial quando começar
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          this.saveOrionLog(userId, 'R_10', 'info', `📊 Aguardando ${amostraNecessaria} ticks para análise | Modo: Lenta | Ticks coletados: ${ticksAtuais}/${amostraNecessaria} | Faltam: ${ticksFaltando}`);
        } else {
          // Logar progresso a cada 5 ticks ou em marcos (40, 45, 48, 49)
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          const marcos = [40, 45, 48, 49];
          const deveLogar = marcos.includes(ticksAtuais) && !marcosLogados.has(ticksAtuais);
          
          if (deveLogar) {
            marcosLogados.add(ticksAtuais);
            this.saveOrionLog(userId, 'R_10', 'info', `📊 Coletando dados... | Modo: Lenta | Ticks coletados: ${ticksAtuais}/${amostraNecessaria} | Faltam: ${ticksFaltando}`);
            this.logger.debug(`[ORION][Lenta][${userId}] 📊 Progresso: ${ticksAtuais}/${amostraNecessaria} ticks coletados`);
          }
        }
      }
      
      return;
    }
    
    // ✅ Se temos 50+ ticks, podemos processar (o sistema mantém 100 ticks, então sempre teremos pelo menos 50)
    // Logar quando completar a coleta (apenas uma vez) - usar >= para garantir que funciona mesmo se já passou
    // ✅ IMPORTANTE: Como o sistema mantém 100 ticks, se ticksAtuais >= 50, já podemos processar
    if (ticksAtuais >= amostraNecessaria) {
      for (const [userId] of this.lentaUsers.entries()) {
        const key = `lenta_${userId}`;
        // ✅ Garantir que a chave existe (mesmo se usuário foi ativado depois)
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
        }
        
        const marcosLogados = this.coletaLogsEnviados.get(key)!;
        // Se ainda não logou que completou, logar agora
        if (!marcosLogados.has(100)) {
          marcosLogados.add(100);
          this.saveOrionLog(userId, 'R_10', 'info', `✅ DADOS COLETADOS | Modo: Lenta | Amostra completa: ${amostraNecessaria} ticks | Ticks disponíveis: ${ticksAtuais} | Iniciando operações...`);
          this.logger.log(`[ORION][Lenta][${userId}] ✅ Dados coletados! Ticks: ${ticksAtuais}/${amostraNecessaria} | Iniciando processamento...`);
          // Limpar após um tempo para permitir novo ciclo se necessário
          setTimeout(() => {
            this.coletaLogsEnviados.delete(key);
          }, 60000); // Limpar após 60 segundos
        }
      }
    } else {
      // ✅ Se ainda não temos 50 ticks, aguardar
      this.logger.debug(`[ORION][Lenta] ⏳ Aguardando mais ticks | Atual: ${ticksAtuais} | Necessário: ${amostraNecessaria}`);
      return;
    }

    // Processar cada usuário
    this.logger.log(`[ORION][Lenta] 🔄 Processando ${this.lentaUsers.size} usuário(s) | Ticks disponíveis: ${ticksAtuais} (necessário: ${amostraNecessaria})`);
    
    for (const [userId, state] of this.lentaUsers.entries()) {
      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) {
        this.logger.debug(`[ORION][Lenta][${userId.substring(0, 8)}] Operação ativa, pulando`);
        continue;
      }

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        // ✅ Se defesa está ativa, validar a direção do martingale com filtros do modo PRECISO
        if (defesaAtiva) {
          const sinalPreciso = this.check_signal(state, 'preciso');
          if (sinalPreciso && sinalPreciso === state.ultimaDirecaoMartingale) {
            // Direção do martingale é válida com filtros do modo PRECISO - continuar martingale
            const proximaEntrada = (state.martingaleStep || 0) + 1;
            this.logger.log(
              `[ORION][Lenta][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
            );
            this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa (${consecutiveLosses} losses). Continuando MARTINGALE em modo PRECISO`);
            
            await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'lenta', proximaEntrada);
            continue;
          } else {
            // Direção do martingale não é válida com filtros do modo PRECISO - gerar novo sinal
            // ✅ CORREÇÃO: Manter perda acumulada e continuar martingale com nova direção
            this.logger.log(
              `[ORION][Lenta][${userId}] 🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida em modo PRECISO. Recalculando sinal mas mantendo martingale.`,
            );
            this.saveOrionLog(userId, 'R_10', 'alerta', `🛡️ Defesa ativa (${consecutiveLosses} losses). Direção do martingale inválida. Recalculando sinal em modo PRECISO mas mantendo perda acumulada.`);
            // ✅ NÃO resetar martingale - manter perda acumulada e continuar com nova direção
            // A direção será atualizada quando o novo sinal for gerado
          }
        } else {
          // Defesa não está ativa - continuar martingale normalmente
          const proximaEntrada = (state.martingaleStep || 0) + 1;
          this.logger.log(
            `[ORION][Lenta][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
          );
          
          await this.executeOrionOperation(state, state.ultimaDirecaoMartingale, 'lenta', proximaEntrada);
          continue;
        }
      }

      const sinal = gerarSinalZenix(this.ticks, LENTA_CONFIG, 'LENTA');
      if (!sinal || !sinal.sinal) {
        this.logger.debug(`[ORION][Lenta][${userId}] ⚠️ Nenhum sinal gerado (confiança insuficiente ou desequilíbrio baixo) | Ticks: ${this.ticks.length}`);
        continue;
      }

      this.logger.log(
        `[ORION][Lenta] 🎯 SINAL | User: ${userId} | Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`,
      );

      // ✅ Salvar logs do sinal
      this.saveOrionLog(userId, 'R_10', 'sinal', `✅ SINAL GERADO: ${sinal.sinal}`);
      this.saveOrionLog(userId, 'R_10', 'sinal', `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`);
      
      // ✅ Logs detalhados das 4 análises (conforme documentação)
      this.saveOrionLog(userId, 'R_10', 'analise', `🔍 ANÁLISE ZENIX v2.0`);
      
      const detalhes = sinal.detalhes;
      const deseq = detalhes?.desequilibrio;
      const sequencias = detalhes?.sequencias;
      const microTendencias = detalhes?.microTendencias;
      const forca = detalhes?.forca;
      const confiancaBase = detalhes?.confiancaBase || 0;
      
      // Histórico (últimos 20 ticks)
      const ultimosTicks = this.ticks.slice(-20).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ Histórico (últimos 20): [${ultimosTicks}]`);
      
      // Distribuição
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        const pares = Math.round(deseq.percentualPar * LENTA_CONFIG.amostraInicial);
        const impares = LENTA_CONFIG.amostraInicial - pares;
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Distribuição: PAR: ${percPar}% (${pares}/${LENTA_CONFIG.amostraInicial}) | ÍMPAR: ${percImpar}% (${impares}/${LENTA_CONFIG.amostraInicial})`);
        
        // Desequilíbrio
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const simboloCheck = deseq.desequilibrio >= LENTA_CONFIG.desequilibrioMin ? '✅' : '❌';
        this.saveOrionLog(userId, 'R_10', 'analise', `├─ Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}% ${direcaoDeseq} ${simboloCheck} (≥ ${(LENTA_CONFIG.desequilibrioMin * 100).toFixed(1)}% requerido)`);
      }
      
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 1: Desequilíbrio Base
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 1: Desequilíbrio Base`);
      if (deseq) {
        const direcaoDeseq = deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR';
        const direcaoOperar = deseq.operacao || 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${direcaoDeseq}: ${(deseq.desequilibrio * 100).toFixed(1)}% → Operar ${direcaoOperar}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Confiança base: ${confiancaBase.toFixed(1)}%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 2: Sequências Repetidas
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 2: Sequências Repetidas`);
      const ultimos10Ticks = this.ticks.slice(-10).map(t => t.digit).join(',');
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos ${Math.min(10, this.ticks.length)} ticks: [${ultimos10Ticks}]`);
      if (sequencias) {
        const atendeRequerido = sequencias.tamanho >= 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Maior sequência: ${sequencias.tamanho} ticks ${sequencias.paridade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${sequencias.bonus > 0 ? '+' : ''}${sequencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 3: Micro-Tendências
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 3: Micro-Tendências`);
      if (microTendencias) {
        const perc10 = microTendencias.curtoPrazoPercPar ? (microTendencias.curtoPrazoPercPar * 100).toFixed(1) : 'N/A';
        const perc20 = microTendencias.medioPrazoPercPar ? (microTendencias.medioPrazoPercPar * 100).toFixed(1) : 'N/A';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10 vs 20 ticks`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Últimos 10: PAR ${perc10}% | Últimos 20: PAR ${perc20}%`);
        const aceleracao = microTendencias.aceleracao * 100;
        const direcaoAcel = aceleracao > 0 ? 'PAR acelerando' : 'ÍMPAR acelerando';
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Aceleração: ${aceleracao > 0 ? '+' : ''}${aceleracao.toFixed(1)}% (${direcaoAcel})`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${microTendencias.bonus > 0 ? '+' : ''}${microTendencias.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // ANÁLISE 4: Força do Desequilíbrio
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 📊 ANÁLISE 4: Força do Desequilíbrio`);
      if (deseq) {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Desequilíbrio atual: ${(deseq.desequilibrio * 100).toFixed(1)}%`);
      }
      if (forca) {
        const atendeRequerido = forca.velocidade > 5;
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Ticks consecutivos com desequilíbrio ≥60%: ${forca.velocidade} ${atendeRequerido ? '(atende 5+ requerido)' : '(não atende 5+ requerido)'}`);
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: ${forca.bonus > 0 ? '+' : ''}${forca.bonus}%`);
      } else {
        this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Bônus: +0%`);
      }
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      
      // CONFIANÇA FINAL
      this.saveOrionLog(userId, 'R_10', 'analise', `├─ 🎯 CONFIANÇA FINAL`);
      const bonusSeq = sequencias?.bonus || 0;
      const bonusMicro = microTendencias?.bonus || 0;
      const bonusForca = forca?.bonus || 0;
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Base: ${confiancaBase.toFixed(1)}% + Sequências: ${bonusSeq}% + Micro: ${bonusMicro}% + Força: ${bonusForca}%`);
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ Total: ${sinal.confianca.toFixed(1)}% (limitado a 95%)`);
      const confiancaOK = sinal.confianca >= (LENTA_CONFIG.confianciaMin * 100);
      this.saveOrionLog(userId, 'R_10', 'analise', `│  └─ ${confiancaOK ? '✅' : '❌'} Confiança: ${sinal.confianca.toFixed(1)}% ${confiancaOK ? '≥' : '<'} ${(LENTA_CONFIG.confianciaMin * 100).toFixed(1)}% (mínimo)`);
      this.saveOrionLog(userId, 'R_10', 'analise', `│`);
      this.saveOrionLog(userId, 'R_10', 'analise', `└─ ✅ SINAL GERADO`);
      this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Direção: ${sinal.sinal}`);
      this.saveOrionLog(userId, 'R_10', 'analise', `   └─ Confiança: ${sinal.confianca.toFixed(1)}%`);

      // ✅ CORREÇÃO: Se defesa está ativa e há perda acumulada, continuar martingale
      let entryNumber = 1;
      if (defesaAtiva && state.perdaAcumulada > 0) {
        // Continuar martingale com nova direção
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal.sinal;
        this.logger.log(
          `[ORION][Lenta][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal.sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );
        this.saveOrionLog(userId, 'R_10', 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo PRECISO`);
      } else {
        // Nova operação normal
        state.ultimaDirecaoMartingale = sinal.sinal;
      }
      
      // ✅ Executar operação
      await this.executeOrionOperation(state, sinal.sinal, 'lenta', entryNumber);
    }
  }

  /**
   * ✅ ORION: Executa operação completa
   */
  private async executeOrionOperation(
    state: VelozUserState | ModeradoUserState | PrecisoUserState,
    operation: DigitParity,
    mode: 'veloz' | 'moderado' | 'preciso' | 'lenta',
    entry: number = 1,
  ): Promise<void> {
    // ✅ Declarar tradeId no escopo da função para ser acessível no catch
    let tradeId: number | null = null;
    
    if (state.isOperationActive) {
      this.logger.warn(`[ORION][${mode}] Usuário ${state.userId} já possui operação ativa`);
      return;
    }

    // ✅ VERIFICAR STOP LOSS ANTES DE QUALQUER OPERAÇÃO
    try {
      const stopLossConfig = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stake_amount, 0) as capitalInicial,
          stop_blindado_percent as stopBlindadoPercent,
          is_active
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = 1
         LIMIT 1`,
        [state.userId],
      );
      
      if (stopLossConfig && stopLossConfig.length > 0) {
        const config = stopLossConfig[0];
        const lossLimit = parseFloat(config.lossLimit) || 0;
        const profitTarget = parseFloat(config.profitTarget) || 0;
        const capitalInicial = parseFloat(config.capitalInicial) || 0;
        
        // ✅ Usar capital do estado em memória (state.capital) ao invés do banco
        // O estado em memória sempre reflete o capital atual da sessão
        const capitalAtual = state.capital || capitalInicial;
        
        // Calcular perda/lucro atual (capital atual - capital inicial)
        const lucroAtual = capitalAtual - capitalInicial;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
        
        // ✅ Verificar STOP WIN (profit target) antes de executar operação
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
          this.logger.log(
            `[ORION][${mode}][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
          );
          this.saveOrionLog(state.userId, 'R_10', 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);
          
          // Desativar a IA
          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} >= Meta +$${profitTarget.toFixed(2)}`, state.userId],
          );
          
          // Remover usuário do monitoramento
          this.velozUsers.delete(state.userId);
          this.moderadoUsers.delete(state.userId);
          this.precisoUsers.delete(state.userId);
          this.lentaUsers.delete(state.userId);
          
          return; // NÃO EXECUTAR OPERAÇÃO
        }
        
        // ✅ Verificar STOP-LOSS BLINDADO antes de executar operação (ZENIX v2.0)
        // Conforme documentação: Stop Blindado = Capital Inicial + (Lucro Líquido × Percentual)
        // Se Capital Atual ≤ Stop Blindado → PARA sistema (garante X% do lucro)
        // ✅ ZENIX v2.0: Só verifica se stop-loss blindado estiver ativado (não NULL)
        if (lucroAtual > 0 && config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
          
          // Calcular stop blindado: Capital Inicial + (Lucro Líquido × percentual)
          const fatorProtecao = stopBlindadoPercent / 100; // 50% → 0.5
          const stopBlindado = capitalInicial + (lucroAtual * fatorProtecao);
          
          // Se capital atual caiu abaixo do stop blindado → PARAR
          if (capitalAtual <= stopBlindado) {
            const lucroProtegido = capitalAtual - capitalInicial;
            
            this.logger.warn(
              `[ORION][${mode}][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
              `Capital: $${capitalAtual.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | ` +
              `Lucro protegido: $${lucroProtegido.toFixed(2)} (${stopBlindadoPercent}% de $${lucroAtual.toFixed(2)}) - BLOQUEANDO OPERAÇÃO`,
            );
            
            this.saveOrionLog(
              state.userId,
              'R_10',
              'alerta',
              `🛡️ STOP-LOSS BLINDADO ATIVADO! Capital: $${capitalAtual.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} | Lucro protegido: $${lucroProtegido.toFixed(2)} - IA DESATIVADA`,
            );
            
            const deactivationReason = 
              `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
              `(${stopBlindadoPercent}% de $${lucroAtual.toFixed(2)} conquistados)`;
            
            // Desativar a IA
            await this.dataSource.query(
              `UPDATE ai_user_config 
               SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
               WHERE user_id = ? AND is_active = 1`,
              [deactivationReason, state.userId],
            );
            
            // Remover usuário do monitoramento
            this.velozUsers.delete(state.userId);
            this.moderadoUsers.delete(state.userId);
            this.precisoUsers.delete(state.userId);
            
            return; // NÃO EXECUTAR OPERAÇÃO
          }
        }
        
        // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(
            `[ORION][${mode}][${state.userId}] 🛑 STOP LOSS ATINGIDO! Perda atual: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
          );
          this.saveOrionLog(state.userId, 'R_10', 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);
          
          // Desativar a IA
          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ? 
             WHERE user_id = ?`,
            [`Stop loss atingido: Perda $${perdaAtual.toFixed(2)} >= Limite $${lossLimit.toFixed(2)}`, state.userId],
          );
          
          // Remover usuário do monitoramento
          this.velozUsers.delete(state.userId);
          this.moderadoUsers.delete(state.userId);
          this.precisoUsers.delete(state.userId);
          this.lentaUsers.delete(state.userId);
          
          return; // NÃO EXECUTAR OPERAÇÃO
        }
        
        // ✅ Verificar se a próxima aposta do martingale ultrapassaria o stop loss
        if (lossLimit > 0 && entry > 1 && state.perdaAcumulada > 0) {
          const payoutCliente = 92;
          const proximaAposta = calcularProximaAposta(state.perdaAcumulada, state.modoMartingale, payoutCliente);
          // Perda total potencial = perda atual + próxima aposta de martingale
          const perdaTotalPotencial = perdaAtual + proximaAposta;
          
          if (perdaTotalPotencial > lossLimit) {
            this.logger.warn(
              `[ORION][${mode}][${state.userId}] ⚠️ Próxima aposta ($${proximaAposta.toFixed(2)}) ultrapassaria stop loss! Perda atual: $${perdaAtual.toFixed(2)} + Próxima: $${proximaAposta.toFixed(2)} = $${perdaTotalPotencial.toFixed(2)} > Limite: $${lossLimit.toFixed(2)}`,
            );
            this.saveOrionLog(state.userId, 'R_10', 'alerta', `⚠️ Martingale bloqueado! Próxima aposta ($${proximaAposta.toFixed(2)}) ultrapassaria stop loss de $${lossLimit.toFixed(2)}`);
            
            // Resetar martingale e voltar para aposta inicial
            state.perdaAcumulada = 0;
            state.ultimaDirecaoMartingale = null;
            state.martingaleStep = 0;
            if ('ultimaApostaUsada' in state) state.ultimaApostaUsada = 0;
            
            // Continuar com aposta inicial ao invés de martingale
            entry = 1;
            this.logger.log(`[ORION][${mode}][${state.userId}] 🔄 Resetando para aposta inicial após bloqueio de martingale`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`[ORION][${mode}][${state.userId}] Erro ao verificar stop loss:`, error);
      // Continuar mesmo se houver erro na verificação (fail-open)
    }

    // ✅ VALIDAÇÕES PREVENTIVAS serão feitas APÓS calcular o stakeAmount
    state.isOperationActive = true;
    // ✅ CORREÇÃO: martingaleStep é gerenciado após perda/vitória, não aqui
    // entry é apenas para logs e cálculo do stake

    // Resetar contador de ticks
    if ('ticksDesdeUltimaOp' in state) {
      state.ticksDesdeUltimaOp = 0;
      // Limpar flag de intervalo quando operação for executada
      const key = `veloz_intervalo_${state.userId}`;
      this.intervaloLogsEnviados.delete(key);
    }

    // Atualizar timestamp da última operação (Moderado)
    if ('lastOperationTimestamp' in state) {
      state.lastOperationTimestamp = new Date();
      // Limpar flag de intervalo quando operação for executada
      const key = `moderado_intervalo_${state.userId}`;
      this.intervaloLogsEnviados.delete(key);
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
      const confirmedStatus = profit >= 0 ? 'WON' : 'LOST';

      // Atualizar trade no banco
      await this.dataSource.query(
        `UPDATE ai_trades
         SET contract_id = ?, exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
         WHERE id = ?`,
        [contractId, exitPrice, profit, confirmedStatus, tradeId],
      );

      // Emitir evento de atualização
      this.tradeEvents.emit({
        userId: state.userId,
        type: 'updated',
        tradeId,
        status: confirmedStatus,
        strategy: 'orion',
        profitLoss: profit,
        exitPrice,
      });

      this.logger.log(`[ORION][${mode}] ${confirmedStatus} | User: ${state.userId} | P&L: $${profit.toFixed(2)}`);
      
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
   * ✅ ORION: Obtém ou cria conexão WebSocket reutilizável por token
   * Mantém uma conexão por token para evitar criar nova conexão a cada trade
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
    ws: WebSocket;
    sendRequest: (payload: any, timeoutMs?: number) => Promise<any>;
    subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs?: number) => Promise<void>;
    removeSubscription: (subId: string) => void;
  }> {
    // ✅ Verificar se já existe conexão ativa para este token
    const existing = this.wsConnections.get(token);
    
    // ✅ Logs de diagnóstico
    this.logger.debug(`[ORION] 🔍 [${userId || 'SYSTEM'}] Verificando conexão existente para token ${token.substring(0, 8)}...`);
    this.logger.debug(`[ORION] 🔍 [${userId || 'SYSTEM'}] Total de conexões no pool: ${this.wsConnections.size}`);
    
    if (existing) {
      const readyState = existing.ws.readyState;
      const readyStateText = readyState === WebSocket.OPEN ? 'OPEN' : 
                            readyState === WebSocket.CONNECTING ? 'CONNECTING' : 
                            readyState === WebSocket.CLOSING ? 'CLOSING' : 
                            readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN';
      
      this.logger.debug(`[ORION] 🔍 [${userId || 'SYSTEM'}] Conexão encontrada: readyState=${readyStateText}, authorized=${existing.authorized}`);
      
      if (existing.ws.readyState === WebSocket.OPEN && existing.authorized) {
        this.logger.debug(`[ORION] ♻️ [${userId || 'SYSTEM'}] ✅ Reutilizando conexão WebSocket existente`);
        
        return {
          ws: existing.ws,
          sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
          subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) => 
            this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
          removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
        };
      } else {
        this.logger.warn(`[ORION] ⚠️ [${userId || 'SYSTEM'}] Conexão existente não está pronta (readyState=${readyStateText}, authorized=${existing.authorized}). Fechando e recriando.`);
        if (existing.keepAliveInterval) {
          clearInterval(existing.keepAliveInterval);
        }
        existing.ws.close();
        this.wsConnections.delete(token);
      }
    } else {
      this.logger.debug(`[ORION] 🔍 [${userId || 'SYSTEM'}] Nenhuma conexão existente encontrada para token ${token.substring(0, 8)}`);
    }

    // ✅ Criar nova conexão
    this.logger.debug(`[ORION] 🔌 [${userId || 'SYSTEM'}] Criando nova conexão WebSocket para token`);
    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      let authResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          this.logger.error(`[ORION] ❌ [${userId || 'SYSTEM'}] Timeout na autorização após 20s. Estado: readyState=${socket.readyState}`);
          socket.close();
          this.wsConnections.delete(token);
          reject(new Error('Timeout ao conectar e autorizar WebSocket (20s)'));
        }
      }, 20000); // ✅ Aumentado de 15s para 20s

      // ✅ Listener de mensagens para capturar autorização e outras respostas
      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // ✅ Log de todas as mensagens recebidas durante autorização
          if (!authResolved) {
            this.logger.debug(`[ORION] 📥 [${userId || 'SYSTEM'}] Mensagem recebida durante autorização: ${JSON.stringify(Object.keys(msg))}`);
          }
          
          // ✅ Ignorar ping/pong
          if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
            return;
          }

          const conn = this.wsConnections.get(token);
          if (!conn) {
            this.logger.warn(`[ORION] ⚠️ [${userId || 'SYSTEM'}] Mensagem recebida mas conexão não encontrada no pool para token ${token.substring(0, 8)}`);
            return;
          }

          // ✅ Processar autorização (apenas durante inicialização)
          // A API Deriv retorna msg.msg_type === 'authorize' com dados em msg.authorize
          if (msg.msg_type === 'authorize' && !authResolved) {
            this.logger.debug(`[ORION] 🔐 [${userId || 'SYSTEM'}] Processando resposta de autorização...`);
            authResolved = true;
            clearTimeout(connectionTimeout);
            
            if (msg.error || (msg.authorize && msg.authorize.error)) {
              const errorMsg = msg.error?.message || msg.authorize?.error?.message || 'Erro desconhecido na autorização';
              this.logger.error(`[ORION] ❌ [${userId || 'SYSTEM'}] Erro na autorização: ${errorMsg}`);
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(`Erro na autorização: ${errorMsg}`));
              return;
            }
            
            conn.authorized = true;
            this.logger.log(`[ORION] ✅ [${userId || 'SYSTEM'}] Autorizado com sucesso | LoginID: ${msg.authorize?.loginid || 'N/A'}`);
            
            // ✅ Iniciar keep-alive
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send(JSON.stringify({ ping: 1 }));
                  this.logger.debug(`[ORION][KeepAlive][${token.substring(0, 8)}] Ping enviado`);
                } catch (error) {
                  // Ignorar erros
                }
              }
            }, 90000);
            
            resolve(socket);
            return;
          }

          // ✅ Processar mensagens de subscription (proposal_open_contract) - PRIORIDADE 1
          if (msg.proposal_open_contract) {
            const contractId = msg.proposal_open_contract.contract_id;
            if (contractId && conn.subscriptions.has(contractId)) {
              const callback = conn.subscriptions.get(contractId)!;
              callback(msg);
              return;
            }
          }

          // ✅ Processar respostas de requisições (proposal, buy, etc.) - PRIORIDADE 2
          if (msg.proposal || msg.buy || (msg.error && !msg.proposal_open_contract)) {
            // Processar primeira requisição pendente (FIFO)
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
          }
        } catch (error) {
          // Continuar processando
        }
      });

      socket.on('open', () => {
        this.logger.log(`[ORION] ✅ [${userId || 'SYSTEM'}] WebSocket conectado, enviando autorização...`);
        
        // ✅ Criar entrada no pool
        const conn = {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        };
        this.wsConnections.set(token, conn);
        
        // ✅ Enviar autorização
        const authPayload = { authorize: token };
        this.logger.debug(`[ORION] 📤 [${userId || 'SYSTEM'}] Enviando autorização: ${JSON.stringify({ authorize: token.substring(0, 8) + '...' })}`);
        socket.send(JSON.stringify(authPayload));
      });

      socket.on('error', (error) => {
        if (!authResolved) {
          clearTimeout(connectionTimeout);
          authResolved = true;
          this.wsConnections.delete(token);
          reject(error);
        }
      });

      socket.on('close', () => {
        this.logger.debug(`[ORION] 🔌 [${userId || 'SYSTEM'}] WebSocket fechado`);
        const conn = this.wsConnections.get(token);
        if (conn) {
          if (conn.keepAliveInterval) {
            clearInterval(conn.keepAliveInterval);
          }
          // Rejeitar todas as requisições pendentes
          conn.pendingRequests.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.reject(new Error('WebSocket fechado'));
          });
          conn.subscriptions.clear();
        }
        this.wsConnections.delete(token);
        
        if (!authResolved) {
          clearTimeout(connectionTimeout);
          authResolved = true;
          reject(new Error('WebSocket fechado antes da autorização'));
        }
      });
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

    // ✅ Aguardar primeira resposta para confirmar subscription
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.subscriptions.delete(subId);
        reject(new Error(`Timeout ao inscrever ${subId}`));
      }, timeoutMs);

      // ✅ Callback wrapper que confirma subscription na primeira mensagem
      const wrappedCallback = (msg: any) => {
        // ✅ Primeira mensagem confirma subscription
        if (msg.proposal_open_contract || msg.error) {
          clearTimeout(timeout);
          if (msg.error) {
            conn.subscriptions.delete(subId);
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
          // ✅ Subscription confirmada, substituir por callback original
          conn.subscriptions.set(subId, callback);
          resolve();
          // ✅ Chamar callback original com primeira mensagem
          callback(msg);
          return;
        }
        // ✅ Se não for primeira mensagem, já deve estar usando callback original
        callback(msg);
      };
      
      conn.subscriptions.set(subId, wrappedCallback);
      conn.ws.send(JSON.stringify(payload));
    });
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

  /**
   * ✅ ORION: Executa trade via WebSocket REUTILIZÁVEL (pool por token) E monitora resultado no MESMO WebSocket
   * Retorna o resultado completo (contractId, profit, exitSpot) ou null se falhar
   * Reutiliza conexão WebSocket por token conforme documentação Deriv, com keep-alive para evitar expiração
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
    try {
      // ✅ PASSO 1: Obter ou criar conexão WebSocket reutilizável
      const connection = await this.getOrCreateWebSocketConnection(token, userId);

      // ✅ PASSO 2: Solicitar proposta
      const proposalStartTime = Date.now();
      this.logger.debug(`[ORION] 📤 [${userId || 'SYSTEM'}] Solicitando proposta | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);
      
      const proposalResponse: any = await connection.sendRequest({
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: this.symbol,
      }, 60000);

      // ✅ Verificar erros na resposta (pode estar em error ou proposal.error)
      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        const errorCode = errorObj?.code || '';
        const errorMessage = errorObj?.message || JSON.stringify(errorObj);
        this.logger.error(
          `[ORION] ❌ Erro na proposta: ${JSON.stringify(errorObj)} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`,
        );
        
        if (userId) {
          // ✅ Mensagem mais clara para WrongResponse
          let userMessage = `❌ Erro na proposta da Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`;
          if (errorCode === 'WrongResponse' || errorMessage.includes('WrongResponse')) {
            userMessage = `❌ Erro na proposta da Deriv | Código: WrongResponse | Mensagem: Sorry, an error occurred while processing your request`;
          }
          this.saveOrionLog(userId, 'R_10', 'erro', userMessage);
          
          if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
            this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Saldo insuficiente na Deriv.`);
          } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
            this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Rate limit atingido na Deriv.`);
          } else if (errorCode === 'WrongResponse' || errorMessage.includes('WrongResponse')) {
            this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Erro temporário da Deriv. Tente novamente em alguns segundos.`);
          }
        }
        // ✅ Não fechar conexão - ela é reutilizada para próximos trades
        return null;
      }

      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);

      if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
        this.logger.error(`[ORION] ❌ Proposta inválida recebida: ${JSON.stringify(proposalResponse)}`);
        if (userId) {
          this.saveOrionLog(userId, 'R_10', 'erro', `❌ Proposta inválida da Deriv | Resposta: ${JSON.stringify(proposalResponse)}`);
        }
        // ✅ Não fechar conexão - ela é reutilizada para próximos trades
        return null;
      }

      const proposalDuration = Date.now() - proposalStartTime;
      this.logger.debug(`[ORION] 📊 [${userId || 'SYSTEM'}] Proposta recebida em ${proposalDuration}ms | ID=${proposalId}, Preço=${proposalPrice}, Executando compra...`);

      // ✅ PASSO 3: Comprar contrato
      const buyStartTime = Date.now();
      this.logger.debug(`[ORION] 💰 [${userId || 'SYSTEM'}] Comprando contrato | ProposalId: ${proposalId}`);
      
      let buyResponse: any;
      try {
        buyResponse = await connection.sendRequest({
          buy: proposalId,
          price: proposalPrice,
        }, 60000);
      } catch (error: any) {
        const errorMessage = error?.message || JSON.stringify(error);
        this.logger.error(
          `[ORION] ❌ Erro ao comprar contrato: ${errorMessage} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | ProposalId: ${proposalId}`,
        );
        
        if (userId) {
          this.saveOrionLog(userId, 'R_10', 'erro', `❌ Erro ao comprar contrato: ${errorMessage}`);
          if (errorMessage.includes('Timeout')) {
            this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Timeout ao comprar contrato. Tente novamente.`);
          }
        }
        return null;
      }

      // ✅ Verificar erros na resposta
      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        const errorCode = buyErrorObj?.code || '';
        const errorMessage = buyErrorObj?.message || JSON.stringify(buyErrorObj);
        this.logger.error(
          `[ORION] ❌ Erro ao comprar contrato: ${JSON.stringify(buyErrorObj)} | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | ProposalId: ${proposalId}`,
        );
        
        if (userId) {
          this.saveOrionLog(userId, 'R_10', 'erro', `❌ Erro ao comprar contrato na Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`);
          
          if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
            this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Saldo insuficiente na Deriv.`);
          } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
            this.saveOrionLog(userId, 'R_10', 'alerta', `💡 Rate limit atingido na Deriv.`);
          }
        }
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[ORION] ❌ Contrato criado mas sem contract_id: ${JSON.stringify(buyResponse)}`);
        if (userId) {
          this.saveOrionLog(userId, 'R_10', 'erro', `❌ Contrato criado mas sem contract_id | Resposta: ${JSON.stringify(buyResponse)}`);
        }
        return null;
      }

      const buyDuration = Date.now() - buyStartTime;
      this.logger.log(`[ORION] ✅ [${userId || 'SYSTEM'}] Contrato criado em ${buyDuration}ms | ContractId: ${contractId} | Monitorando...`);
      if (userId) {
        this.saveOrionLog(userId, 'R_10', 'operacao', `✅ Contrato criado: ${contractId} | Proposta: ${proposalDuration}ms | Compra: ${buyDuration}ms`);
      }

      // ✅ PASSO 4: Monitorar contrato usando subscribe no MESMO WebSocket reutilizável
      const monitorStartTime = Date.now();
      let firstUpdateTime: number | null = null;
      let lastUpdateTime: number | null = null;
      let updateCount = 0;
      
      this.logger.debug(`[ORION] 👁️ [${userId || 'SYSTEM'}] Iniciando monitoramento do contrato ${contractId}...`);
      
      return new Promise((resolve) => {
        let hasResolved = false;
        let contractMonitorTimeout: NodeJS.Timeout | null = null;

        // ✅ Timeout de 90 segundos para monitoramento
        contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[ORION] ⏱️ Timeout ao monitorar contrato (90s) | ContractId: ${contractId}`);
            if (userId) {
              this.saveOrionLog(userId, 'R_10', 'erro', `⏱️ Contrato ${contractId} não finalizou em 90 segundos`);
            }
            connection.removeSubscription(contractId);
            resolve(null);
          }
        }, 90000);

        // ✅ Inscrever para atualizações do contrato
        connection.subscribe(
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          (msg: any) => {
            try {
              // ✅ Verificar erros
              if (msg.error) {
                this.logger.error(`[ORION] ❌ Erro na subscription do contrato ${contractId}: ${JSON.stringify(msg.error)}`);
                if (!hasResolved) {
                  hasResolved = true;
                  if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                  connection.removeSubscription(contractId);
                  resolve(null);
                }
                return;
              }

              const contract = msg.proposal_open_contract;
              if (!contract) {
                return;
              }

              // ✅ Métricas de performance
              const now = Date.now();
              updateCount++;
              
              if (!firstUpdateTime) {
                firstUpdateTime = now;
                const timeToFirstUpdate = firstUpdateTime - monitorStartTime;
                this.logger.log(
                  `[ORION] ⚡ [${userId || 'SYSTEM'}] Primeira atualização recebida em ${timeToFirstUpdate}ms | Contrato: ${contractId}`,
                );
              }
              
              if (lastUpdateTime) {
                const timeSinceLastUpdate = now - lastUpdateTime;
                this.logger.debug(
                  `[ORION] ⏱️ [${userId || 'SYSTEM'}] Atualização #${updateCount} | Tempo desde última: ${timeSinceLastUpdate}ms | Total desde criação: ${now - monitorStartTime}ms`,
                );
              }
              
              lastUpdateTime = now;

              // ✅ Log de atualizações para debug
              this.logger.debug(
                `[ORION] 📊 Atualização do contrato ${contractId}: is_sold=${contract.is_sold}, status=${contract.status}, profit=${contract.profit} | Update #${updateCount}`,
              );

              // ✅ Verificar se contrato finalizou
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
                
                // ✅ Log detalhado de performance
                this.logger.log(
                  `[ORION] ✅ [${userId || 'SYSTEM'}] Contrato ${contractId} finalizado em ${monitorDuration}ms | Profit: $${profit.toFixed(2)} | Status: ${contract.status}`,
                );
                this.logger.log(
                  `[ORION] 📈 [${userId || 'SYSTEM'}] Performance: Primeira atualização: ${timeToFirstUpdate}ms | Total atualizações: ${updateCount} | Intervalo médio: ${avgUpdateInterval.toFixed(0)}ms`,
                );
                
                if (userId) {
                  this.saveOrionLog(
                    userId, 
                    'R_10', 
                    'resultado', 
                    `✅ Contrato finalizado em ${monitorDuration}ms | Primeira atualização: ${timeToFirstUpdate}ms | Total: ${updateCount} atualizações`,
                  );
                }

                connection.removeSubscription(contractId);
                resolve({ contractId, profit, exitSpot });
              }
            } catch (error) {
              if (!hasResolved) {
                hasResolved = true;
                if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                this.logger.error(`[ORION] ❌ Erro ao processar atualização do contrato:`, error);
                if (userId) {
                  this.saveOrionLog(
                    userId,
                    'R_10',
                    'erro',
                    `Erro ao processar atualização do contrato ${contractId} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
                  );
                }
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
            this.logger.error(`[ORION] ❌ Erro ao inscrever no contrato ${contractId}:`, error);
            if (userId) {
              this.saveOrionLog(
                userId,
                'R_10',
                'erro',
                `Erro ao inscrever no contrato ${contractId} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
              );
            }
            resolve(null);
          }
        });
      });
    } catch (error) {
      this.logger.error(`[ORION] ❌ Erro ao executar trade via WebSocket:`, error);
      if (userId) {
        this.saveOrionLog(
          userId,
          'R_10',
          'erro',
          `Erro ao executar trade | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount} | Detalhes: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        );
      }
      return null;
    }
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
    
    // ✅ Sempre armazenar a última aposta usada (necessário para cálculo do martingale agressivo)
    if ('ultimaApostaUsada' in state) {
      state.ultimaApostaUsada = stakeAmount;
    }
    
    if (profit > 0) {
      // ✅ VITÓRIA: Zerar consecutive_losses (Defesa Automática)
      const consecutiveLossesAntes = state.consecutive_losses || 0;
      if ('consecutive_losses' in state) {
        state.consecutive_losses = 0;
      }
      
      if (consecutiveLossesAntes > 0) {
        this.logger.log(`[ORION][${mode}][${state.userId}] 🎯 DEFESA AUTOMÁTICA DESATIVADA | Losses consecutivos zerados após vitória (antes: ${consecutiveLossesAntes})`);
        this.saveOrionLog(state.userId, 'R_10', 'info', `🎯 DEFESA AUTOMÁTICA DESATIVADA | Losses consecutivos zerados: ${consecutiveLossesAntes} → 0`);
      }
      
      // ✅ VITÓRIA: Verificar se estava em martingale ANTES de processar Soros
      const estavaEmMartingale = (state.perdaAcumulada || 0) > 0;
      
      // Resetar martingale primeiro
      if ('perdaAcumulada' in state) state.perdaAcumulada = 0;
      if ('ultimaDirecaoMartingale' in state) state.ultimaDirecaoMartingale = null;
      if ('martingaleStep' in state) state.martingaleStep = 0;
      if ('ultimaApostaUsada' in state) state.ultimaApostaUsada = 0;
      
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
      // ❌ PERDA: Incrementar consecutive_losses (Defesa Automática)
      const consecutiveLossesAntes = state.consecutive_losses || 0;
      if ('consecutive_losses' in state) {
        state.consecutive_losses = consecutiveLossesAntes + 1;
      }
      const consecutiveLossesAgora = state.consecutive_losses || 0;
      
      this.logger.log(`[ORION][${mode}][${state.userId}] 📊 LOSSES CONSECUTIVAS | ${consecutiveLossesAntes} → ${consecutiveLossesAgora}`);
      this.saveOrionLog(state.userId, 'R_10', 'resultado', `📊 LOSSES CONSECUTIVAS: ${consecutiveLossesAntes} → ${consecutiveLossesAgora}`);
      
      if (consecutiveLossesAgora >= 3) {
        this.logger.warn(`[ORION][${mode}][${state.userId}] 🚨 DEFESA AUTOMÁTICA ATIVADA | ${consecutiveLossesAgora} losses consecutivos. Modo PRECISO será forçado na próxima entrada.`);
        this.saveOrionLog(state.userId, 'R_10', 'alerta', `🚨 DEFESA AUTOMÁTICA ATIVADA | ${consecutiveLossesAgora} losses consecutivos. Modo PRECISO será forçado na próxima entrada.`);
      }
      
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
    
    // ✅ Verificar stop loss e stop win após processar resultado
    // Atualizar session_balance no banco com o lucro/perda da sessão (capital atual - capital inicial)
    try {
      const configResult = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stake_amount, 0) as capitalInicial,
          stop_blindado_percent as stopBlindadoPercent,
          is_active
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = 1
         LIMIT 1`,
        [state.userId],
      );
      
      if (configResult && configResult.length > 0) {
        const config = configResult[0];
        const lossLimit = parseFloat(config.lossLimit) || 0;
        const profitTarget = parseFloat(config.profitTarget) || 0;
        const capitalInicial = parseFloat(config.capitalInicial) || 0;
        
        // ✅ Usar capital do estado em memória (state.capital) ao invés do banco
        // O estado em memória sempre reflete o capital atual da sessão após o resultado
        const capitalAtual = state.capital || capitalInicial;
        
        // Calcular perda/lucro atual (capital atual - capital inicial)
        const lucroAtual = capitalAtual - capitalInicial;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
        
        // ✅ Atualizar session_balance com o lucro/perda da sessão (não o capital atual)
        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET session_balance = ?
           WHERE user_id = ? AND is_active = 1`,
          [lucroAtual, state.userId],
        );
        
        // ✅ Verificar STOP WIN (profit target)
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
          this.logger.log(
            `[ORION][${mode}][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - DESATIVANDO SESSÃO`,
          );
          this.saveOrionLog(state.userId, 'R_10', 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);
          
          // Desativar a IA
          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_profit', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Meta de lucro atingida: +$${lucroAtual.toFixed(2)} >= Meta +$${profitTarget.toFixed(2)}`, state.userId],
          );
          
          // Remover usuário do monitoramento
          this.velozUsers.delete(state.userId);
          this.moderadoUsers.delete(state.userId);
          this.precisoUsers.delete(state.userId);
          return;
        }
        
        // ✅ Verificar STOP-LOSS BLINDADO (ZENIX v2.0 - protege lucros conquistados)
        // Conforme documentação: Stop Blindado = Capital Inicial + (Lucro Líquido × Percentual)
        // Se Capital Atual ≤ Stop Blindado → PARA sistema (garante X% do lucro)
        // ✅ ZENIX v2.0: Só verifica se stop-loss blindado estiver ativado (não NULL)
        if (lucroAtual > 0 && config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
          
          // Calcular stop blindado: Capital Inicial + (Lucro Líquido × percentual)
          const fatorProtecao = stopBlindadoPercent / 100; // 50% → 0.5
          const stopBlindado = capitalInicial + (lucroAtual * fatorProtecao);
          
          // Se capital atual caiu abaixo do stop blindado → PARAR
          if (capitalAtual <= stopBlindado) {
            const lucroProtegido = capitalAtual - capitalInicial;
            
            this.logger.warn(
              `[ORION][${mode}][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
              `Capital: $${capitalAtual.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | ` +
              `Lucro protegido: $${lucroProtegido.toFixed(2)} (${stopBlindadoPercent}% de $${lucroAtual.toFixed(2)})`,
            );
            
            this.saveOrionLog(
              state.userId,
              'R_10',
              'alerta',
              `🛡️ STOP-LOSS BLINDADO ATIVADO! Capital: $${capitalAtual.toFixed(2)} | Stop: $${stopBlindado.toFixed(2)} | Lucro protegido: $${lucroProtegido.toFixed(2)} - IA DESATIVADA`,
            );
            
            const deactivationReason = 
              `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
              `(${stopBlindadoPercent}% de $${lucroAtual.toFixed(2)} conquistados)`;
            
            // Desativar a IA
            await this.dataSource.query(
              `UPDATE ai_user_config 
               SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
               WHERE user_id = ? AND is_active = 1`,
              [deactivationReason, state.userId],
            );
            
            // Remover usuário do monitoramento
            this.velozUsers.delete(state.userId);
            this.moderadoUsers.delete(state.userId);
            this.precisoUsers.delete(state.userId);
            return;
          }
        }
        
        // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(
            `[ORION][${mode}][${state.userId}] 🛑 STOP LOSS ATINGIDO APÓS OPERAÇÃO! Perda: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - DESATIVANDO SESSÃO`,
          );
          this.saveOrionLog(state.userId, 'R_10', 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);
          
          // Desativar a IA
          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop loss atingido após operação: Perda $${perdaAtual.toFixed(2)} >= Limite $${lossLimit.toFixed(2)}`, state.userId],
          );
          
          // Remover usuário do monitoramento
          this.velozUsers.delete(state.userId);
          this.moderadoUsers.delete(state.userId);
          this.precisoUsers.delete(state.userId);
          return;
        }
        
        // ✅ Verificar STOP-LOSS BLINDADO (protege X% do lucro conquistado)
        // Stop Blindado só funciona quando está em LUCRO
        if (lucroAtual > 0) {
          const stopBlindadoConfig = await this.dataSource.query(
            `SELECT 
              COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent,
              session_status
             FROM ai_user_config 
             WHERE user_id = ? AND is_active = 1
             LIMIT 1`,
            [state.userId],
          );
          
          if (stopBlindadoConfig && stopBlindadoConfig.length > 0) {
            const stopBlindadoPercent = parseFloat(stopBlindadoConfig[0].stopBlindadoPercent) || 50.0;
            
            // Calcular stop blindado (protege X% do lucro)
            // Fórmula: stopBlindado = capitalInicial + (lucroAtual × percentual)
            // Exemplo: $1000 inicial + ($100 lucro × 50%) = $1050
            const fatorProtecao = stopBlindadoPercent / 100; // 50% → 0.5
            const stopBlindado = capitalInicial + (lucroAtual * fatorProtecao);
            
            // ✅ Log sempre visível para monitoramento (não apenas debug)
            this.logger.log(
              `[ORION][${mode}][${state.userId}] 🛡️ Verificando Stop Blindado | Lucro: $${lucroAtual.toFixed(2)} | ` +
              `Stop: $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%) | ` +
              `Capital atual: $${capitalAtual.toFixed(2)}`,
            );
            
            // ✅ Salvar log também no sistema de logs do usuário
            this.saveOrionLog(
              state.userId,
              'R_10',
              'info',
              `🛡️ Stop Blindado: Lucro $${lucroAtual.toFixed(2)} | Stop $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%) | Capital $${capitalAtual.toFixed(2)}`,
            );
            
            // Se capital atual caiu abaixo do stop blindado → PARAR
            if (capitalAtual <= stopBlindado) {
              const lucroProtegido = capitalAtual - capitalInicial;
              const percentualProtegido = lucroAtual > 0 ? (lucroProtegido / lucroAtual) * 100 : 0;
              
              this.logger.warn(
                `[ORION][${mode}][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
                `Protegendo $${lucroProtegido.toFixed(2)} de lucro ` +
                `(${percentualProtegido.toFixed(0)}% de $${lucroAtual.toFixed(2)} conquistados)`,
              );
              
              this.saveOrionLog(
                state.userId, 
                'R_10', 
                'alerta', 
                `🛡️ STOP-LOSS BLINDADO ATIVADO! Capital: $${capitalAtual.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | Lucro protegido: $${lucroProtegido.toFixed(2)}`,
              );
              
              const deactivationReason = 
                `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
                `(${stopBlindadoPercent}% de $${lucroAtual.toFixed(2)} conquistados)`;
              
              // Desativar a IA
              await this.dataSource.query(
                `UPDATE ai_user_config 
                 SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
                 WHERE user_id = ? AND is_active = 1`,
                [deactivationReason, state.userId],
              );
              
              // Remover usuário do monitoramento
              this.velozUsers.delete(state.userId);
              this.moderadoUsers.delete(state.userId);
              this.precisoUsers.delete(state.userId);
              
              this.logger.log(
                `[ORION][${mode}][${state.userId}] 🛡️ IA DESATIVADA POR STOP BLINDADO | ` +
                `Lucro protegido: $${lucroProtegido.toFixed(2)} | ` +
                `Saldo final: $${capitalAtual.toFixed(2)}`,
              );
              return;
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`[ORION][${mode}][${state.userId}] Erro ao verificar limites após resultado:`, error);
      // Continuar mesmo se houver erro na verificação (fail-open)
    }
  }

  /**
   * ✅ Extrai o último dígito de um valor (mesma lógica do ai.service.ts)
   */
  private extractLastDigit(value: number): number {
    const numeric = Math.abs(value);
    const normalized = numeric.toString().replace('.', '').replace('-', '');
    const lastChar = normalized.charAt(normalized.length - 1);
    const digit = parseInt(lastChar, 10);
    return Number.isNaN(digit) ? 0 : digit;
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
                if ('ultimaApostaUsada' in state) {
                  state.ultimaApostaUsada = 0;
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
        ultimaApostaUsada: existing.ultimaApostaUsada || 0, // ✅ Preservar última aposta usada
        // ✅ Garantir que ticksDesdeUltimaOp está inicializado
        ticksDesdeUltimaOp: existing.ticksDesdeUltimaOp !== undefined ? existing.ticksDesdeUltimaOp : 0,
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
        // ✅ Preservar consecutive_losses ao atualizar
        consecutive_losses: existing.consecutive_losses ?? 0,
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
        ultimaApostaUsada: 0, // ✅ Última aposta usada (para cálculo do martingale agressivo)
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
        consecutive_losses: 0, // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
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
        ultimaApostaUsada: existing.ultimaApostaUsada || 0, // ✅ Preservar última aposta usada
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
        // ✅ Preservar consecutive_losses ao atualizar
        consecutive_losses: existing.consecutive_losses ?? 0,
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
        ultimaApostaUsada: 0, // ✅ Última aposta usada (para cálculo do martingale agressivo)
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
        consecutive_losses: 0, // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
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
        ultimaApostaUsada: existing.ultimaApostaUsada || 0, // ✅ Preservar última aposta usada
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
        // ✅ Preservar consecutive_losses ao atualizar
        consecutive_losses: existing.consecutive_losses ?? 0,
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
        ultimaApostaUsada: 0, // ✅ Última aposta usada (para cálculo do martingale agressivo)
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
        consecutive_losses: 0, // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
      });
    }
  }

  private upsertLentaUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const apostaInicial = params.apostaInicial || 0.35; // Usar apostaInicial se fornecido, senão 0.35
    const existing = this.lentaUsers.get(params.userId);
    if (existing) {
      Object.assign(existing, {
        capital: params.stakeAmount,
        derivToken: params.derivToken,
        currency: params.currency,
        modoMartingale: params.modoMartingale || existing.modoMartingale || 'conservador',
        // ✅ Atualizar aposta inicial se fornecido
        apostaInicial: params.apostaInicial || existing.apostaInicial,
        apostaBase: params.apostaInicial || existing.apostaBase,
        ultimaApostaUsada: existing.ultimaApostaUsada || 0, // ✅ Preservar última aposta usada
        // ✅ Não resetar ultimaDirecaoMartingale ao atualizar (manter estado do martingale)
        // ✅ Preservar consecutive_losses ao atualizar
        consecutive_losses: existing.consecutive_losses ?? 0,
      });
    } else {
      this.lentaUsers.set(params.userId, {
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
        ultimaApostaUsada: 0, // ✅ Última aposta usada (para cálculo do martingale agressivo)
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
        consecutive_losses: 0, // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
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
      this.logger.warn(`[ORION][SaveLog] ⚠️ Parâmetros inválidos: userId=${userId}, type=${type}, message=${message}`);
      return;
    }

    // Normalizar símbolo: usar o padrão da Orion, exceto logs de sistema
    const symbolToUse = symbol === 'SISTEMA' ? 'SISTEMA' : this.symbol;

    // Adicionar à fila
    this.logQueue.push({ userId, symbol: symbolToUse, type, message, details });
    this.logger.debug(`[ORION][SaveLog] 📝 Log adicionado à fila | userId=${userId} | type=${type} | message=${message.substring(0, 50)}... | Fila: ${this.logQueue.length}`);

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

