import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick, DigitParity } from '../ai.service';
import { IStrategy, ModeConfig, VELOZ_CONFIG, MODERADO_CONFIG, PRECISO_CONFIG, LENTA_CONFIG, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';

import { gerarSinalZenix } from './signal-generator';
// ✅ REMOVIDO: DerivWebSocketPoolService - usando WebSocket direto conforme documentação Deriv

// Estados ORION
export type OrionPhase = 'ATAQUE' | 'DEFESA';
export type OrionSignal = DigitParity | 'DIGITOVER' | 'CALL' | 'PUT' | null;

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
  lastRecoveryLog?: number; // ✅ Timestamp para log throttled de recuperação
  vitoriasConsecutivas: number;
  apostaBase: number;
  ultimoLucro: number;
  ultimaApostaUsada: number; // ✅ Última aposta usada (necessário para cálculo do martingale agressivo)
  ultimaDirecaoMartingale: DigitParity | 'CALL' | 'PUT' | 'DIGITOVER' | null; // ✅ Atualizado para suportar Digits/Call/Put
  creationCooldownUntil?: number; // Cooldown pós erro/timeout para mitigar rate limit
  consecutive_losses: number; // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
  defesaAtivaLogged?: boolean; // ✅ Flag para evitar log repetido de defesa ativa
  ticksColetados: number; // ✅ NOVO: Ticks coletados desde a ativação

  // ✅ NOVOS CAMPOS PARA ORION HÍBRIDA
  currentPhase: OrionPhase; // ATAQUE (Dígitos) ou DEFESA (Price Action)
  lastLowDigitsCount: number; // Contagem de dígitos < 4
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
  ultimaDirecaoMartingale: DigitParity | 'CALL' | 'PUT' | 'DIGITOVER' | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number;
  consecutive_losses: number; // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
  defesaAtivaLogged?: boolean; // ✅ Flag para evitar log repetido de defesa ativa
  // ✅ PREVISÃO: Campos para rastrear trade pendente e fazer previsão
  pendingTradeId?: number | null;
  pendingTradeOperation?: DigitParity | null; // PAR ou IMPAR
  pendingTradeEntryPrice?: number | null;
  pendingTradeStakeAmount?: number | null;
  predictedStatus?: 'WON' | 'LOST' | null;
  ticksReceivedAfterBuy?: number;
  ticksDesdeUltimaOp: number; // ✅ Cooldown para modo Moderado
  ticksColetados: number; // ✅ NOVO: Ticks coletados desde a ativação

  // ✅ NOVOS CAMPOS PARA ORION HÍBRIDA
  currentPhase: OrionPhase;
  lastLowDigitsCount: number;
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
  ultimaDirecaoMartingale: DigitParity | 'CALL' | 'PUT' | 'DIGITOVER' | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  creationCooldownUntil?: number;
  consecutive_losses: number; // ✅ NOVO: Rastrear perdas consecutivas para defesa automática
  defesaAtivaLogged?: boolean; // ✅ Flag para evitar log repetido de defesa ativa
  ticksDesdeUltimaOp: number; // ✅ Cooldown para modo Preciso/Lenta
  lastRecoveryLog?: number; // ✅ Timestamp para log throttled de recuperação
  ticksColetados: number; // ✅ NOVO: Ticks coletados desde a ativação

  // ✅ NOVOS CAMPOS PARA ORION HÍBRIDA
  currentPhase: OrionPhase;
  lastLowDigitsCount: number;
  lastOperationTimestamp?: number; // ✅ Timestamp da última operação para cooldown de tempo (10s)
}

// ============================================
// ESTRATÉGIA SOROS - ZENIX v2.0
// ============================================
const SOROS_MAX_NIVEL = 1; // Soros tem apenas 1 nível (entrada 1, 2)

/**
 * Calcula aposta com estratégia Soros aplicada
 * Soros funciona até o nível 1 (2 entradas):
 * - Entrada 1: valor inicial
 * - Entrada 2 (Soros Nível 1): entrada anterior + lucro da entrada anterior
 * 
 * @param entradaAnterior - Valor da entrada anterior
 * @param lucroAnterior - Lucro obtido na entrada anterior
 * @param vitoriasConsecutivas - Número de vitórias consecutivas (0 ou 1)
 * @returns Valor da aposta com Soros aplicado, ou null se Soros não deve ser aplicado
 */
function calcularApostaComSoros(
  entradaAnterior: number,
  lucroAnterior: number,
  vitoriasConsecutivas: number,
): number | null {
  // Soros funciona até o nível 1 (vitoriasConsecutivas = 0 ou 1)
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
 * CONSERVADOR: Próxima Aposta = Perda Acumulada (apenas recuperar, sem lucro)
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
  baseStake: number = 0.35,
  ultimaAposta: number = 0,
): number {
  const PAYOUT = typeof payoutCliente === 'number' && payoutCliente > 1
    ? payoutCliente / 100  // Se for 92, converter para 0.92
    : payoutCliente;       // Se já for 0.95, usar direto

  let aposta = 0;

  switch (modo) {
    case 'conservador':
      // Meta: recuperar apenas o valor da perda (break-even)
      // Fórmula: entrada_próxima = perdas_totais / payout
      aposta = perdasTotais / PAYOUT;
      break;
    case 'moderado':
      // Meta: recuperar 100% das perdas + 10% de lucro ( conforme doc )
      // Fórmula: entrada_próxima = (perdas_totais × 1.10) / payout
      aposta = (perdasTotais * 1.10) / PAYOUT;
      break;
    case 'agressivo':
      // Meta: recuperar 100% das perdas + 20% de lucro ( conforme doc )
      // Fórmula: entrada_próxima = (perdas_totais × 1.20) / payout
      aposta = (perdasTotais * 1.20) / PAYOUT;
      break;
  }

  return Math.round(aposta * 100) / 100; // 2 casas decimais
}

/**
 * ✅ ORION Master Blueprint: RiskManager
 * Gerencia dinheiro com Modos de Risco Personalizados e Stop Blindado
 */
class RiskManager {
  private initialBalance: number;
  private stopLossLimit: number;
  private profitTarget: number;
  private riskMode: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
  private useBlindado: boolean;
  private maxBalance: number;
  public consecutiveLosses: number;
  private totalLossAccumulated: number;
  private lastResultWasWin: boolean;
  private _blindadoActive: boolean;

  constructor(
    initialBalance: number,
    stopLossLimit: number,
    profitTarget: number,
    riskMode: 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO' = 'CONSERVADOR',
    useBlindado: boolean = true,
  ) {
    this.initialBalance = initialBalance;
    this.stopLossLimit = stopLossLimit;
    this.profitTarget = profitTarget;
    this.riskMode = riskMode.toUpperCase() as 'CONSERVADOR' | 'MODERADO' | 'AGRESSIVO';
    this.useBlindado = useBlindado;
    this.maxBalance = initialBalance;
    this.consecutiveLosses = 0;
    this.totalLossAccumulated = 0.0;
    this.lastResultWasWin = false;
    this._blindadoActive = false;

    // Validação de Segurança
    if (this.stopLossLimit <= 0) {
      console.error('❌ ERRO CRÍTICO: Stop Loss deve ser um valor positivo (ex: 100.00).');
    }
  }

  updateResult(profit: number, stakeUsed: number): void {
    /**
     * Chamar após cada operação para atualizar contadores
     */
    if (profit < 0) {
      this.consecutiveLosses += 1;
      this.totalLossAccumulated += stakeUsed;
      this.lastResultWasWin = false;
    } else {
      // Se ganhou, reseta ciclo de recuperação
      this.consecutiveLosses = 0;
      this.totalLossAccumulated = 0.0;
      this.lastResultWasWin = true;
    }
  }

  calculateStake(
    currentBalance: number,
    baseStake: number,
    lastProfit: number,
    logger?: any,
    vitoriasConsecutivas?: number,
    saveLog?: (type: string, message: string) => void,
  ): number {
    /**
     * Calcula o valor da próxima entrada baseado no Modo de Risco.
     * Retorna 0 se o Stop Loss (Normal ou Blindado) for atingido.
     */
    // Atualiza Pico de Saldo (High Water Mark)
    if (currentBalance > this.maxBalance) {
      this.maxBalance = currentBalance;
    }

    let nextStake = baseStake;
    const PAYOUT_RATE = 0.95; // Estimativa conservadora do Payout (95%)

    // --- LÓGICA DE RECUPERAÇÃO (MARTINGALE) ---
    if (this.consecutiveLosses > 0) {
      // 1. CONSERVADOR: Tenta até Nível 5. Se falhar, aceita e volta pra base.
      if (this.riskMode === 'CONSERVADOR') {
        if (this.consecutiveLosses <= 5) {
          // CONSERVADOR: Recuperar apenas o valor da última perda (Break-even)
          // Fórmula conforme pedido: nextStake = totalLossAccumulated / 0.92
          nextStake = this.totalLossAccumulated / 0.92;
          nextStake = Math.round(nextStake * 100) / 100;
          if (logger) {
            logger.log(`🔄 [CONSERVADOR] Recuperação Ativada: $${nextStake.toFixed(2)}`);
          }
          if (saveLog) {
            saveLog('info', `🔄 MARTINGALE (CONSERVADOR) | Perda acumulada: $${this.totalLossAccumulated.toFixed(2)}`);
          }
        } else {
          // Aceita a perda e reseta
          if (logger) {
            logger.log(
              `❌ [CONSERVADOR] Limite de 5 perdas atingido. Resetando para stake base.`,
            );
          }
          this.consecutiveLosses = 0; // Reseta forçado
          this.totalLossAccumulated = 0.0;
          nextStake = baseStake;
        }
      }
      // 2. MODERADO: Infinito + 25% de Lucro sobre a perda
      else if (this.riskMode === 'MODERADO') {
        const targetRecovery = this.totalLossAccumulated * 1.25; // Recupera + 25%
        nextStake = targetRecovery / PAYOUT_RATE;
        nextStake = Math.round(nextStake * 100) / 100;
        if (logger) {
          logger.log(`⚖️ [MODERADO] Buscando Recuperação + 25%: $${nextStake.toFixed(2)}`);
        }
        if (saveLog) {
          saveLog('info', `🩹 RECUPERAÇÃO ATIVADA\n• PERDA ACUMULADA: $${this.totalLossAccumulated.toFixed(2)}\n• MODO ATUAL: MODERADO (+25%)\n• PRÓXIMA APOSTA: $${nextStake.toFixed(2)}`);
        }
      }
      // 3. AGRESSIVO: Infinito + 50% de Lucro sobre a perda
      else if (this.riskMode === 'AGRESSIVO') {
        const targetRecovery = this.totalLossAccumulated * 1.50; // Recupera + 50%
        nextStake = targetRecovery / PAYOUT_RATE;
        nextStake = Math.round(nextStake * 100) / 100;
        if (logger) {
          logger.log(`🔥 [AGRESSIVO] Buscando Recuperação + 50%: $${nextStake.toFixed(2)}`);
        }
        if (saveLog) {
          saveLog('info', `🩹 RECUPERAÇÃO ATIVADA\n• PERDA ACUMULADA: $${this.totalLossAccumulated.toFixed(2)}\n• MODO ATUAL: AGRESSIVO (+50%)\n• PRÓXIMA APOSTA: $${nextStake.toFixed(2)}`);
        }
      }
    }
    // --- LÓGICA DE SOROS (APÓS WIN) ---
    // --- LÓGICA DE SOROS (APÓS WIN) ---
    else if (lastProfit > 0 && vitoriasConsecutivas !== undefined && vitoriasConsecutivas > 0 && vitoriasConsecutivas <= 3) {
      nextStake = baseStake + lastProfit;
      nextStake = Math.round(nextStake * 100) / 100;
      if (logger) {
        logger.log(`🚀 [SOROS] Nível ${vitoriasConsecutivas} ativado! Entrada: $${nextStake.toFixed(2)}`);
      }
      if (saveLog) {
        saveLog('info', `🚀 APLICANDO SOROS NÍVEL ${vitoriasConsecutivas}\n• Lucro Anterior: $${lastProfit.toFixed(2)}\n• Nova Stake (Base + Lucro): $${nextStake.toFixed(2)}`);
      }
    }

    // --- GESTÃO DE LIMITES (STOP LOSS vs BLINDADO) ---
    // Definição: Quem manda agora? Stop Normal ou Blindado?
    const currentProfit = currentBalance - this.initialBalance;
    const profitAccumulatedAtPeak = this.maxBalance - this.initialBalance;
    const activationTrigger = this.profitTarget * 0.40;
    let minAllowedBalance = 0.0;
    let limitType = '';

    // Verifica gatilho do Blindado (40% da meta atingida no pico)
    if (this.useBlindado && profitAccumulatedAtPeak >= activationTrigger) {
      this._blindadoActive = true;
    }

    if (this._blindadoActive) {
      // MODO BLINDADO ATIVO: O Stop Loss Normal é DESABILITADO.
      // Regra: Garantir 50% do lucro máximo atingido.
      const guaranteedProfit = profitAccumulatedAtPeak * 0.5;
      minAllowedBalance = this.initialBalance + guaranteedProfit;
      limitType = 'STOP BLINDADO (LUCRO GARANTIDO)';

      // Mensagem informativa (apenas quando muda o pico)
      if (currentBalance === this.maxBalance && logger) {
        logger.log(`🛡️ [SISTEMA] Stop Blindado Atualizado. Novo Piso: $${minAllowedBalance.toFixed(2)}`);
        if (saveLog && currentBalance > this.initialBalance) { // Apenas salvar se tiver lucro real
          // Log apenas se mudou significativamente ou é novo?
          // Para "Atualização/Ativação Stop Blindado":
          saveLog('info', `🛡️ STOP BLINDADO ATIVADO\n• LUCRO ATUAL: $${(currentBalance - this.initialBalance).toFixed(2)}\n• PICO DO LUCRO: $${profitAccumulatedAtPeak.toFixed(2)}\n• PROTEÇÃO: 50% ($${guaranteedProfit.toFixed(2)})\n• NOVO STOP LOSS: $${minAllowedBalance.toFixed(2)}`);
        }
      }
    } else {
      // MODO NORMAL: Vale o Stop Loss definido pelo usuário.
      minAllowedBalance = this.initialBalance - this.stopLossLimit;
      limitType = 'STOP LOSS NORMAL';
    }

    // --- AJUSTE DE PRECISÃO (VALIDAÇÃO FINAL) ---
    // Esta lógica garante que a stake NUNCA viole o limite ativo (seja ele Normal ou Blindado).
    const potentialBalanceAfterLoss = currentBalance - nextStake;
    if (potentialBalanceAfterLoss < minAllowedBalance) {
      // Se a perda dessa entrada fizer cruzar a linha vermelha, ajustamos a stake.
      let adjustedStake = currentBalance - minAllowedBalance;
      adjustedStake = Math.round(adjustedStake * 100) / 100;

      // Se a stake ajustada for menor que o mínimo da corretora (0.35), paramos.
      if (adjustedStake < 0.35) {
        if (logger) {
          if (this._blindadoActive) {
            logger.log(
              `🏆 [META PARCIAL] ${limitType} atingido. Lucro no bolso!`,
            );
            if (saveLog) saveLog('alerta', `🏆 META/STOP BLINDADO ATINGIDO\n• TIPO: ${limitType}\n• SALDO FINAL: $${currentBalance.toFixed(2)}`);
          } else {
            logger.log(`🚨 [STOP LOSS] ${limitType} atingido. Parando operações.`);
            if (saveLog) saveLog('alerta', `🛑 STOP LOSS NORMAL ATINGIDO\n• Motivo: Limite de perda diária alcançado.\n• Ação: Encerrando operações imediatamente.`);
          }
        }
        return 0.0; // Sinal de parada
      }

      if (logger) {
        logger.log(
          `⚠️ [PRECISÃO] Stake ajustada de $${nextStake.toFixed(2)} para $${adjustedStake.toFixed(2)}`,
        );
        logger.log(
          ` • Motivo: Respeitar ${limitType} (Piso: $${minAllowedBalance.toFixed(2)})`,
        );
        if (saveLog) {
          if (limitType.includes('BLINDADO')) {
            saveLog('alerta', `⚠️ AJUSTE DE RISCO (STOP BLINDADO)\n• Stake Calculada: $${nextStake.toFixed(2)}\n• Lucro Protegido Restante: $${(currentBalance - minAllowedBalance).toFixed(2)}\n• Ação: Stake reduzida para $${adjustedStake.toFixed(2)} para não violar a proteção de lucro.`);
          } else {
            saveLog('alerta', `⚠️ AJUSTE DE RISCO (STOP LOSS)\n• Stake Calculada: $${nextStake.toFixed(2)}\n• Saldo Restante até Stop: $${(currentBalance - minAllowedBalance).toFixed(2)}\n• Ação: Stake reduzida para $${adjustedStake.toFixed(2)} para respeitar o Stop Loss exato.`);
          }
        }
      }
      return adjustedStake;
    }

    return Math.round(nextStake * 100) / 100;
  }
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

  // ✅ [NOVO] RiskManager por usuário
  private riskManagers = new Map<string, RiskManager>();

  // ✅ Rastreamento de logs de coleta de dados (para evitar logs duplicados)
  private coletaLogsEnviados = new Map<string, Set<number>>(); // userId -> Set de marcos já logados

  // ✅ Rastreamento de logs de intervalo entre operações (para evitar logs duplicados)
  private intervaloLogsEnviados = new Map<string, boolean>(); // userId -> se já logou que está aguardando intervalo

  // ✅ Rastreamento de log de direção inválida do martingale (para evitar logs duplicados)
  private defesaDirecaoInvalidaLogsEnviados = new Map<string, boolean>(); // userId -> se já logou que direção do martingale é inválida

  // ✅ Sistema de logs
  private logInitialConfig(userId: string, mode: string, riskMode: string, profitTarget: number, stopLoss: number, blindado: boolean) {
    const blindadoStatus = blindado ? 'ATIVADO' : 'DESATIVADO';
    this.logger.log(`⚙️ CONFIGURAÇÕES INICIAIS`);
    this.logger.log(`• Estratégia: ORION`);
    this.logger.log(`• Modo de Negociação: ${mode}`);
    this.logger.log(`• Gerenciamento de Risco: ${riskMode.toUpperCase()}`);
    this.logger.log(`• Meta de Lucro: $${profitTarget.toFixed(2)}`);
    // The original log lines for stop loss and blindado are replaced by the new one
    // this.logger.log(`• Stop Loss Normal: $${stopLoss.toFixed(2)}`);
    // this.logger.log(`• Stop Loss Blindado: ${blindadoStatus}`);

    // The new log line for stop loss and blindado
    // Note: The provided snippet uses `lossLimit`, `useBlindado`, `stopBlindadoPercent`, and `state.modoMartingale`
    // which are not parameters of `logInitialConfig`. Assuming these are available in the context where this function is called,
    // or that the user intended to pass them as parameters.
    // For now, I'll use the existing parameters `stopLoss` and `blindado` for consistency with the function signature.
    // If `lossLimit`, `useBlindado`, `stopBlindadoPercent` are meant to be new parameters, the function signature needs to change.
    // Given the instruction is to "fix stop loss log", I will adapt the provided log line to use the existing parameters.
    // The user's provided log line:
    // this.logger.log(`[ORION][${mode}] 📊 Stop Loss: $${lossLimit.toFixed(2)} | Stop Blindado: ${useBlindado ? 'ATIVADO' : 'DESATIVADO'} (${stopBlindadoPercent}%) | Meta: $${profitTarget.toFixed(2)}`);
    // Adapting to existing parameters:
    this.logger.log(`[ORION][${mode}] 📊 Stop Loss: $${stopLoss.toFixed(2)} | Stop Blindado: ${blindado ? 'ATIVADO' : 'DESATIVADO'} | Meta: $${profitTarget.toFixed(2)}`);

    // The original saveOrionLog is replaced by the new one
    // this.saveOrionLog(userId, this.symbol, 'info',
    //   `⚙️ CONFIGURAÇÕES INICIAIS\n` +
    //   `• Estratégia: ORION\n` +
    //   `• Modo de Negociação: ${mode}\n` +
    //   `• Gerenciamento de Risco: ${riskMode.toUpperCase()}\n` +
    //   `• Meta de Lucro: $${profitTarget.toFixed(2)}\n` +
    //   `• Stop Loss Normal: $${stopLoss.toFixed(2)}\n` +
    //   `• Stop Loss Blindado: ${blindadoStatus}`
    // );
    // The user's provided saveOrionLog line:
    // this.saveOrionLog(userId, this.symbol, 'config', `⚙️ CONFIGURAÇÕES INICIAIS\n• Estratégia: ORION\n• Modo de Negociação: ${mode.toUpperCase()}\n• Gerenciamento de Risco: ${state.modoMartingale ? state.modoMartingale.toUpperCase() : 'CONSERVADOR'}\n• Meta de Lucro: $${profitTarget.toFixed(2)}\n• Stop Loss Normal: $${lossLimit.toFixed(2)}\n• Stop Loss Blindado: ${useBlindado ? 'ATIVADO' : 'DESATIVADO'}`);
    // Adapting to existing parameters:
    this.saveOrionLog(userId, this.symbol, 'config', `⚙️ CONFIGURAÇÕES INICIAIS\n• Estratégia: ORION\n• Modo de Negociação: ${mode.toUpperCase()}\n• Gerenciamento de Risco: ${riskMode.toUpperCase()}\n• Meta de Lucro: $${profitTarget.toFixed(2)}\n• Stop Loss Normal: $${stopLoss.toFixed(2)}\n• Stop Loss Blindado: ${blindado ? 'ATIVADO' : 'DESATIVADO'}`);
  }

  private logQueue: Array<{
    userId: string;
    symbol: string;
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro' | 'config';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;
  private appId: string;
  private symbol = '1HZ100V'; // Volatility 100 (1s) Index
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
    this.logger.log('[ORION] Estratégia ORION inicializada - v2.0.1 (Conservative Doubling Fixed)');
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    // ✅ PREVENÇÃO DE DUPLICATAS: Ignorar se tiver o mesmo epoch do último tick
    if (this.ticks.length > 0) {
      const lastTick = this.ticks[this.ticks.length - 1];
      if (tick.epoch === lastTick.epoch) {
        return; // Tick duplicado, ignorar
      }
    }

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

    // ✅ OTIMIZADO: Processar modos em paralelo para reduzir latência
    await Promise.all([
      this.processVelozStrategies(tick).catch(error => {
        this.logger.error('[ORION][Veloz] Erro:', error);
      }),
      this.processModeradoStrategies(tick).catch(error => {
        this.logger.error('[ORION][Moderado] Erro:', error);
      }),
      this.processPrecisoStrategies(tick).catch(error => {
        this.logger.error('[ORION][Preciso] Erro:', error);
      }),
      this.processLentaStrategies(tick).catch(error => {
        this.logger.error('[ORION][Lenta] Erro:', error);
      }),
    ]);

    // ✅ Incrementar contadores para todos os usuários ativos
    for (const state of this.velozUsers.values()) {
      state.ticksColetados++;
      state.ticksDesdeUltimaOp++;
    }
    for (const state of this.moderadoUsers.values()) {
      state.ticksColetados++;
      // Modo moderado usa timestamp, mas manteremos o contador por consistência se necessário
    }
    for (const state of this.precisoUsers.values()) {
      state.ticksColetados++;
      state.ticksDesdeUltimaOp++;
    }
    for (const state of this.lentaUsers.values()) {
      state.ticksColetados++;
      state.ticksDesdeUltimaOp++;
    }
  }

  async activateUser(userId: string, config: any): Promise<void> {
    const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, profitTarget, lossLimit, stopLossBlindado, symbol } = config;
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
        ticksColetados: 0,
        profitTarget: profitTarget || 0,
        lossLimit: lossLimit || 0,
        stopLossBlindado: stopLossBlindado
      });

    } else if (modeLower === 'moderado') {
      this.upsertModeradoUserState({
        userId,
        stakeAmount, // Capital total
        apostaInicial, // Valor de entrada por operação
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
        ticksColetados: 0,
        profitTarget: profitTarget || 0,
        lossLimit: lossLimit || 0,
        stopLossBlindado: stopLossBlindado
      });

    } else if (modeLower === 'preciso') {
      this.upsertPrecisoUserState({
        userId,
        stakeAmount, // Capital total
        apostaInicial, // Valor de entrada por operação
        derivToken,
        currency,
        modoMartingale: modoMartingale || 'conservador',
        ticksColetados: 0,
        profitTarget: profitTarget || 0,
        lossLimit: lossLimit || 0,
        stopLossBlindado: stopLossBlindado
      });

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
        ticksColetados: 0,
        profitTarget: profitTarget || 0,
        lossLimit: lossLimit || 0,
        stopLossBlindado: stopLossBlindado
      });

    } else {
      this.logger.warn(`[ORION] ⚠️ Modo desconhecido: ${modeLower} | Usuário ${userId} não foi ativado`);
    }

    // ✅ Resetar RiskManager ao ativar usuário (garantir contadores zerados)
    if (this.riskManagers.has(userId)) {
      this.riskManagers.delete(userId);
      this.logger.log(`[ORION] 🔄 RiskManager resetado para usuário ${userId} ao ativar`);
    }

    // ✅ Resetar consecutive_losses e defesaAtivaLogged no state ao ativar usuário
    const state = this.getUserState(userId);
    if (state && 'consecutive_losses' in state) {
      state.consecutive_losses = 0;
      if ('defesaAtivaLogged' in state) {
        state.defesaAtivaLogged = false;
      }
      this.logger.log(`[ORION] 🔄 consecutive_losses e defesaAtivaLogged resetados para usuário ${userId} ao ativar`);
    }

    // LOG REMOVIDO: A responsabilidade de logar a configuração inicial agora é dos métodos upsert*UserState
    // Isso evita duplicação de logs e garante que os valores reais (passados para o estado) sejam logados.
    this.logger.log(`[ORION] ✅ Usuário ${userId} ativado no modo ${modeLower.toUpperCase()}.`);
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
   * ✅ [ZENIX] Detector de Sequências Repetidas
   * Conta quantos dígitos iguais consecutivos ocorreram no final
   */
  private getRepeatedSequenceCount(lastDigits: number[]): number {
    if (!lastDigits || lastDigits.length === 0) return 0;
    const lastType = lastDigits[lastDigits.length - 1] % 2;
    let count = 0;
    for (let i = lastDigits.length - 1; i >= 0; i--) {
      if (lastDigits[i] % 2 === lastType) {
        count += 1;
      } else {
        break;
      }
    }
    return count;
  }



  /**
   * ✅ ORION Master Blueprint: check_signal
   * Implementa a lógica HÍBRIDA:
   * - ATAQUE: Digit Over 3 (Sequência de dígitos < 4)
   * - DEFESA: Price Action (Rise/Fall)
   */
  private check_signal(
    state: VelozUserState | ModeradoUserState | PrecisoUserState | any,
    currentMode: 'veloz' | 'moderado' | 'preciso' | 'lenta',
    riskManager?: RiskManager,
  ): DigitParity | 'DIGITOVER' | 'CALL' | 'PUT' | null {
    if (this.ticks.length < 20) return null;

    // ✅ Log de análise iniciada (Debounce)
    const agora = Date.now();
    const lastLogTime = (state as any).lastAnalysisLogTime || 0;
    if (agora - lastLogTime > 5000) {
      (state as any).lastAnalysisLogTime = agora;
      this.logger.log(`🧠 ANÁLISE INICIADA...`);
      this.logger.log(`• Verificando condições para o modo: ${currentMode.toUpperCase()}`);
    }

    // Identificar fase atual (padrão: ATAQUE)
    const phase = state.currentPhase || 'ATAQUE';
    const consecutiveLosses = riskManager?.consecutiveLosses || state.consecutive_losses || 0;

    // --- 1. FASE DE DEFESA (Recuperação com Price Action) ---
    // Ativa se estiver na fase de defesa OU se tiver losses consecutivos
    // ✅ CORREÇÃO: Se >= 3 Losses, usar Lógica de Dígitos do Modo Lenta (Over 3)
    // Se 1-2 Losses, usar Price Action (Active Fallback)

    // Se 1-2 Losses (Defesa Leve / Active Fallback), usar Momentum + Força
    if ((phase === 'DEFESA' || consecutiveLosses > 0) && consecutiveLosses < 3) {
      // Executar lógica de Recuperação Leve por Modo (Unified Delta Logic)
      if (currentMode === 'veloz') {
        // Veloz: 2 ticks + delta 0.3
        return this.checkMomentumAndStrength(state, 2, 0.3, 'VELOZ');
      } else {
        // Normal/Lento/Preciso: 3 ticks + delta 0.5
        return this.checkMomentumAndStrength(state, 3, 0.5, currentMode.toUpperCase());
      }
    }

    // Se >= 3 Losses (Defesa Pesada), forçamos modo LENTA para usar Análise de Dígitos estrita
    if (consecutiveLosses >= 3) {
      if (currentMode !== 'lenta') {
        // Debug apenas se mudou
        const now = Date.now();
        // Cast to avoid TS error if property not in type
        if (now - ((state as any).lastModeChangeLog || 0) > 5000) {
          (state as any).lastModeChangeLog = now;
          this.logger.debug(`[ORION] 🛡️ Defesa Ativada (>3 Losses): Alternando para Modo LENTA (Análise de Dígitos Estrita)`);
        }
      }
      currentMode = 'lenta';
      // Não retorna! Deixa cair (fallthrough) para a FASE DE ATAQUE abaixo
    }

    // --- 2. FASE DE ATAQUE (Digit Over 3) ---
    // Busca falhas na sequência de dígitos baixos (< 4)

    // ✅ MODO VELOZ: SEM FILTRO (Compra em todos os ticks)
    if (currentMode === 'veloz') {
      // Log simplificado para não spammar
      // const now = Date.now();
      // if (now - ((state as any).lastVelozLog || 0) > 1000) {
      //   (state as any).lastVelozLog = now;
      //   this.logger.log(`[ORION][VELOZ] 🚀 Modo Veloz: Entrada Direta (Sem Filtro)`);
      // }

      // Salvar log para frontend (Rate limited pelo próprio RiskManager/UI se necessário, mas aqui enviamos o sinal)
      this.saveOrionLog(
        state.userId,
        this.symbol,
        'sinal',
        `🚀 MODO VELOZ (SEM FILTRO)\n` +
        `• Ação: Compra Imediata (Tick a Tick)\n` +
        `• Motivo: Estratégia de Alta Frequência\n` +
        `📊 ENTRADA: DIGIT OVER 3`
      );

      return 'DIGITOVER';
    }

    // ✅ stateless implementation aligned with reference
    let requiredLosses = 3;
    // if (currentMode === 'veloz') requiredLosses = 0; // REMOVIDO: Veloz agora é tratado acima
    if (currentMode === 'moderado') requiredLosses = 3; // 'normal' in reference
    else if (currentMode === 'lenta') requiredLosses = 5;
    else if (currentMode === 'preciso') requiredLosses = 5;

    // Safety check
    if (this.ticks.length < requiredLosses) return null;

    // Lógica Stateless: Extrair últimos N dígitos
    const lastTicks = this.ticks.slice(-requiredLosses);
    const lastDigits = lastTicks.map(t => this.extractLastDigit(t.value));

    // Verificar se TODOS são < 4 (Dígitos Perdedores)
    const analysisResults = lastDigits.map((d, i) => ({
      digit: d,
      value: lastTicks[i].value,
      passed: d < 4,
    }));

    const isSignal = analysisResults.every((r) => r.passed);

    if (isSignal) {
      // ✅ LOGS EXATOS DA REFERÊNCIA
      this.logger.log(`[ORION] 🔍 ANÁLISE: MODO ${currentMode.toUpperCase()}`);

      lastDigits.forEach((d, i) => {
        // ✅ Debug: Mostrar valor real para provar que são ticks diferentes
        const val = lastTicks[i].value;
        this.logger.log(
          `[ORION] ✅ FILTRO ${i + 1}: Dígito ${d} (Valor: ${val}) (Perdedor < 4)`,
        );
      });

      this.logger.log(
        `[ORION] ✅ GATILHO: Sequência de ${requiredLosses} dígitos < 4 detectada.`,
      );

      // Calcular Força (Simulada para alinhar com referência)
      const strength = 60 + requiredLosses * 5;
      this.logger.log(`[ORION] 💪 FORÇA DO SINAL: ${strength}%`);
      this.logger.log(`[ORION] 📊 ENTRADA: DIGIT OVER 3`);

      // Salvar log para frontend
      this.saveOrionLog(
        state.userId,
        this.symbol,
        'sinal',
        `🔍 ANÁLISE: MODO ${currentMode.toUpperCase()}\n` +
        lastDigits
          .map(
            (d, i) =>
              `✅ FILTRO ${i + 1}: Dígito ${d} (Valor: ${lastTicks[i].value}) (Perdedor < 4)`,
          )
          .join('\n') +
        '\n' +
        `✅ GATILHO: Sequência de ${requiredLosses} dígitos < 4 detectada.\n` +
        `💪 FORÇA DO SINAL: ${strength}%\n` +
        `📊 ENTRADA: DIGIT OVER 3`,
      );

      return 'DIGITOVER';
    } else {
      // ✅ LOG DE ANÁLISE RECUSADA (100% de Transparência por solicitação do usuário)
      // APENAS SE NÃO FOR VELOZ (Veloz já retornou acima)
      const failedFilters = analysisResults.filter((r) => !r.passed).length;
      const totalFilters = analysisResults.length;

      // Montar log detalhado da recusa
      this.saveOrionLog(
        state.userId,
        this.symbol,
        'analise',
        `🔍 ANÁLISE: MODO ${currentMode.toUpperCase()} (RECUSADA)\n` +
        analysisResults
          .map(
            (r, i) =>
              `${r.passed ? '✅' : '❌'} FILTRO ${i + 1}: Dígito ${r.digit} (Valor: ${r.value}) ${r.passed ? '(OK < 4)' : '(FALHA >= 4)'}`,
          )
          .join('\n') +
        '\n' +
        `❌ RESULTADO: ${failedFilters}/${totalFilters} filtros falharam. Aguardando sequência...`,
      );
    }

    return null;
  }

  // --- Helpers de Price Action (Defesa) ---

  /**
   * ✅ UNIFICADO: Momentum + Força do Mercado (Delta)
   * Verifica consistência direcional em N intervalos + força mínima no último movimento.
   * 
   * @param ticksCount - Número de intervalos a verificar (Ex: 2 ticks = 3 pontos de dados)
   * @param minDelta - Diferença mínima absoluta no último intervalo
   * @param modeLabel - Nome do modo para exibição nos logs (Ex: VELOZ, NORMAL)
   */
  private checkMomentumAndStrength(state: any, ticksCount: number, minDelta: number, modeLabel: string): DigitParity | 'DIGITOVER' | 'CALL' | 'PUT' | null {
    // Precisa de N+1 pontos de dados para N intervalos
    const requiredPoints = ticksCount + 1;
    if (this.ticks.length < requiredPoints) return null;

    const relevantTicks = this.ticks.slice(-requiredPoints);

    // Calcular diferenças (deltas)
    const deltas: number[] = [];
    for (let i = 1; i < relevantTicks.length; i++) {
      deltas.push(relevantTicks[i].value - relevantTicks[i - 1].value);
    }

    // Verificar consistência direcional
    const allPositive = deltas.every(d => d > 0);
    const allNegative = deltas.every(d => d < 0);

    if (!allPositive && !allNegative) return null;

    // Verificar força do último movimento (Delta)
    const lastDelta = Math.abs(deltas[deltas.length - 1]);

    // Pegar referências para log
    const lastTick = relevantTicks[relevantTicks.length - 1];
    const prevTick = relevantTicks[relevantTicks.length - 2];

    if (lastDelta >= minDelta) {
      const signal = allPositive ? 'CALL' : 'PUT';
      const directionStr = allPositive ? 'SUBIU' : 'CAIU';

      // Detalhes para log user-friendly
      const priceHistory = relevantTicks.map(t => t.value.toFixed(2)).join(' -> ');
      const calcDetail = `|${lastTick.value} - ${prevTick.value}| = ${lastDelta.toFixed(3)}`;

      const logMsg = `🛡️ RECUPERAÇÃO ${modeLabel} DETECTADA\n` +
        `• Onde: Últimos ${ticksCount} movimentos (${priceHistory})\n` +
        `• O que aconteceu: O preço ${directionStr} ${ticksCount} vezes seguidas.\n` +
        `• Cálculo da Força: ${calcDetail}\n` +
        `• Força Final: ${lastDelta.toFixed(3)} (Mínimo: ${minDelta}) ✅\n` +
        `• Conclusão: Mercado com força para continuar ${allPositive ? 'SUBINDO' : 'CAINDO'}.`;

      // Logar
      this.saveOrionLog(state.userId, this.symbol, 'sinal', logMsg);
      this.logger.log(`[ORION] 🛡️ Defesa ${modeLabel}: ${signal} (Força ${lastDelta.toFixed(3)} >= ${minDelta})`);

      return signal;
    }

    // Feedback visual se estiver em defesa (throttled)
    const now = Date.now();
    if (now - (state.lastRecoveryLog || 0) > 4000) {
      state.lastRecoveryLog = now;
      this.logger.debug(`[ORION] ⏳ Aguardando Momentum (${ticksCount}t) + Delta >= ${minDelta}... (Atual: ${lastDelta.toFixed(3)})`);
    }

    return null;
  }

  private calculateSMA(period: number): number {
    const slice = this.ticks.slice(-period);
    const sum = slice.reduce((acc, tick) => acc + tick.value, 0);
    return sum / slice.length;
  }

  private logDefenseSignal(state: any, modeName: string, logic: string, signal: string) {
    if (state.lastDefenseLogTick === this.ticks.length) return; // Evita spam no mesmo tick
    state.lastDefenseLogTick = this.ticks.length;

    this.logger.log(`🛡️ ANÁLISE DEFESA: ${modeName}`);
    this.logger.log(`✅ LÓGICA: ${logic}`);
    this.logger.log(`📊 ENTRADA: ${signal === 'CALL' ? 'CALL (Sobe)' : 'PUT (Desce)'}`);

    this.saveOrionLog(
      state.userId,
      this.symbol,
      'sinal',
      `🛡️ ANÁLISE DEFESA: ${modeName}\n✅ LÓGICA: ${logic}\n📊 ENTRADA: ${signal === 'CALL' ? 'CALL (Sobe)' : 'PUT (Desce)'}`
    );
  }

  private async processVelozStrategies(latestTick: Tick): Promise<void> {
    if (this.velozUsers.size === 0) {
      this.logger.debug(`[ORION][Veloz] Nenhum usuário ativo (total: ${this.velozUsers.size})`);
      return;
    }

    // Processar cada usuário
    for (const [userId, state] of this.velozUsers.entries()) {
      if (state.ticksColetados < VELOZ_CONFIG.amostraInicial) {
        const ticksAtuais = state.ticksColetados;
        const amostraNecessaria = VELOZ_CONFIG.amostraInicial;
        const ticksFaltando = amostraNecessaria - ticksAtuais;

        // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
        // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
        const key = `veloz_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Veloz)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        // ✅ Logar progresso a cada 20% ou no final (Reduzir spam em amostras pequenas)
        if (ticksAtuais > 0 && ticksAtuais % Math.max(5, Math.floor(amostraNecessaria / 5)) === 0) {
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Veloz)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.logger.debug(`[ORION][Veloz][${userId}] Coletando: ${ticksAtuais}/${amostraNecessaria}`);
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        continue;
      }

      // ✅ Logar quando completar a coleta (apenas uma vez)
      if (state.ticksColetados === VELOZ_CONFIG.amostraInicial) {
        const key = `veloz_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${VELOZ_CONFIG.amostraInicial} TICKS (Modo Veloz)\n• CONTAGEM: ${VELOZ_CONFIG.amostraInicial}/${VELOZ_CONFIG.amostraInicial} (COMPLETO)`;
            this.saveOrionLog(userId, this.symbol, 'info', logMsg);
          }
        }
      }

      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) {
        // Log a cada 10s se estiver travado muito tempo
        const now = Date.now();
        if (!(state as any).lastLockLog || now - (state as any).lastLockLog > 10000) {
          (state as any).lastLockLog = now;
          this.logger.debug(`[ORION][Veloz][${userId.substring(0, 8)}] 🔒 Operação ativa, pulando tick...`);
        }
        continue;
      }

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale IMEDIATAMENTE (Active Fallback)
      // ⚠️ FIX: Não ativar fallback se estiver em MODO DE DEFESA (3+ losses) para respeitar o tempo do filtro LENTO
      if (state.perdaAcumulada > 0 && !defesaAtiva) {
        // ✅ THRESHOLD: Aguardar pelo menos 5 segundos entre recuperações rápidas para evitar "metralhadora"
        const now = Date.now();
        const lastOpTime = (state as any).lastOperationTimestamp || 0;
        if (now - lastOpTime < 5000) {
          // Log throttled
          if (now - ((state as any).lastCooldownLog || 0) > 2000) {
            (state as any).lastCooldownLog = now;
            this.logger.debug(`[ORION][Veloz] ⏳ Aguardando cooldown de recuperação (5s)...`);
          }
          continue;
        }

        // ✅ [ZENIX v2.0] MODO VELOZ: 2 Ticks + Delta 0.3
        const nexusSignal = this.checkMomentumAndStrength(state, 2, 0.3, 'VELOZ');

        if (!nexusSignal) {
          // Aguardando força...
          // Log throttled
          if (now - (state.lastRecoveryLog || 0) > 4000) {
            state.lastRecoveryLog = now;
            this.logger.debug(`[ORION][Veloz] ⏳ Aguardando Momentum (2 Ticks) + Delta >= 0.3...`);
          }
          continue;
        }

        const novoSinal = nexusSignal;
        const entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = novoSinal;

        this.logger.log(`[ORION][Veloz][${userId}] 🔄 Recuperação (Dinâmica) | Entrada: ${entryNumber} | Direção: ${novoSinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🔄 Recuperação. Price Action (2 Movimentos) (${novoSinal})`);

        await this.executeOrionOperation(state, novoSinal, 'veloz', entryNumber);
        continue;
      }

      const modoSinal = defesaAtiva ? 'veloz' : 'veloz';
      const riskManager = this.riskManagers.get(userId);
      const sinal = this.check_signal(state, modoSinal, riskManager);
      if (!sinal) {
        // ✅ Se estiver em modo de defesa (recuperação) e sem sinal, logar periodicamente para feedback
        if (state.perdaAcumulada > 0) {
          const now = Date.now();
          const lastLog = (state as any).lastWaitingLog || 0;
          if (now - lastLog > 5000) { // Log a cada 5 segundos
            (state as any).lastWaitingLog = now;
            this.logger.debug(`[ORION][Veloz][${userId}] 🛡️ Defesa ativa. Aguardando sinal de Price Action...`);
          }
        }
        continue;
      }

      this.logger.log(`[ORION][Veloz] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`);
      this.saveOrionLog(userId, this.symbol, 'sinal', `✅ SINAL GERADO: ${sinal}`);

      let entryNumber = 1;
      // ✅ CORREÇÃO: Qualquer perda acumulada deve acionar lógica de Martingale (RiskManager/Entry Number)
      if (state.perdaAcumulada > 0) {
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        const key = `veloz_defesa_invalida_${userId}`;
        this.defesaDirecaoInvalidaLogsEnviados.delete(key);
        this.logger.log(`[ORION][Veloz][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo LENTO (2 movimentos)`);
      } else {
        state.ultimaDirecaoMartingale = sinal;
        const key = `veloz_defesa_invalida_${userId}`;
        this.defesaDirecaoInvalidaLogsEnviados.delete(key);
      }

      await this.executeOrionOperation(state, sinal, 'veloz', entryNumber);
    }
  }

  private async processModeradoStrategies(latestTick: Tick): Promise<void> {
    if (this.moderadoUsers.size === 0) return;

    // Processar cada usuário
    for (const [userId, state] of this.moderadoUsers.entries()) {
      if (state.ticksColetados < MODERADO_CONFIG.amostraInicial) {
        const ticksAtuais = state.ticksColetados;
        const amostraNecessaria = MODERADO_CONFIG.amostraInicial;
        const ticksFaltando = amostraNecessaria - ticksAtuais;

        // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
        // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
        const key = `moderado_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Moderado)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        // ✅ Logar progresso a cada 20%
        if (ticksAtuais > 0 && ticksAtuais % Math.max(5, Math.floor(amostraNecessaria / 5)) === 0) {
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Moderado)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.logger.debug(`[ORION][Moderado][${userId}] Coletando: ${ticksAtuais}/${amostraNecessaria}`);
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        continue;
      }

      // ✅ Logar quando completar a coleta (apenas uma vez)
      if (state.ticksColetados === MODERADO_CONFIG.amostraInicial) {
        const key = `moderado_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${MODERADO_CONFIG.amostraInicial} TICKS (Modo Moderado)\n• CONTAGEM: ${MODERADO_CONFIG.amostraInicial}/${MODERADO_CONFIG.amostraInicial} (COMPLETO)`;
            this.saveOrionLog(userId, this.symbol, 'info', logMsg);
          }
        }
      }

      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale IMEDIATAMENTE (Active Fallback)
      // ⚠️ FIX: Não ativar fallback se estiver em MODO DE DEFESA (3+ losses) para respeitar o tempo do filtro LENTO
      if (state.perdaAcumulada > 0 && !defesaAtiva) {
        // ✅ THRESHOLD: Aguardar pelo menos 5 segundos entre recuperações rápidas para evitar "metralhadora"
        const now = Date.now();
        const lastOpTime = (state as any).lastOperationTimestamp || 0;
        if (now - lastOpTime < 5000) {
          // Log throttled
          if (now - ((state as any).lastCooldownLog || 0) > 2000) {
            (state as any).lastCooldownLog = now;
            this.logger.debug(`[ORION][Moderado] ⏳ Aguardando cooldown de recuperação (5s)...`);
          }
          continue;
        }

        // ✅ [ZENIX v2.0] Active Fallback: Usar Momentum + Delta (MODERADO: 3 Ticks + Delta 0.5)
        const smaSignal = this.checkMomentumAndStrength(state, 3, 0.5, 'NORMAL');

        if (!smaSignal) {
          // Aguardando...
          continue;
        }

        const novoSinal = smaSignal;
        const entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = novoSinal;

        this.logger.log(`[ORION][Moderado][${userId}] 🔄 Recuperação Rápida (SMA) | Entrada: ${entryNumber} | Direção: ${novoSinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🔄 Recuperação Rápida. Alternando para Momentum + Força (${novoSinal})`);

        await this.executeOrionOperation(state, novoSinal, 'moderado', entryNumber);
        continue;
      }

      const modoSinal = defesaAtiva ? 'moderado' : 'moderado';
      const riskManager = this.riskManagers.get(userId);
      const sinal = this.check_signal(state, modoSinal, riskManager);
      if (!sinal) {
        // ✅ Feedback visual: Aguardando sinal de defesa
        if (state.perdaAcumulada > 0) {
          const now = Date.now();
          const lastLog = (state as any).lastWaitingLog || 0;
          if (now - lastLog > 5000) {
            (state as any).lastWaitingLog = now;
            this.logger.debug(`[ORION][Moderado][${userId}] 🛡️ Defesa ativa. Aguardando sinal de Price Action...`);
          }
        }
        continue;
      }

      this.logger.log(`[ORION][Moderado] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`);
      this.saveOrionLog(userId, this.symbol, 'sinal', `✅ SINAL GERADO: ${sinal}`);

      let entryNumber = 1;
      // ✅ CORREÇÃO: Qualquer perda acumulada deve acionar lógica de Martingale
      if (state.perdaAcumulada > 0) {
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        this.logger.log(`[ORION][Moderado][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo LENTO (2 movimentos)`);
      } else {
        state.ultimaDirecaoMartingale = sinal;
      }

      await this.executeOrionOperation(state, sinal, 'moderado', entryNumber);
    }
  }

  private async processPrecisoStrategies(latestTick: Tick): Promise<void> {
    if (this.precisoUsers.size === 0) return;

    // Processar cada usuário
    for (const [userId, state] of this.precisoUsers.entries()) {
      if (state.ticksColetados < PRECISO_CONFIG.amostraInicial) {
        const ticksAtuais = state.ticksColetados;
        const amostraNecessaria = PRECISO_CONFIG.amostraInicial;
        const ticksFaltando = amostraNecessaria - ticksAtuais;

        // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
        const key = `preciso_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Preciso)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        // ✅ Logar progresso a cada 20%
        if (ticksAtuais > 0 && ticksAtuais % Math.max(5, Math.floor(amostraNecessaria / 5)) === 0) {
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Preciso)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.logger.debug(`[ORION][Preciso][${userId}] Coletando: ${ticksAtuais}/${amostraNecessaria}`);
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        continue;
      }

      // ✅ Logar quando completar a coleta (apenas uma vez)
      if (state.ticksColetados === PRECISO_CONFIG.amostraInicial) {
        const key = `preciso_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${PRECISO_CONFIG.amostraInicial} TICKS (Modo Preciso)\n• CONTAGEM: ${PRECISO_CONFIG.amostraInicial}/${PRECISO_CONFIG.amostraInicial} (COMPLETO)`;
            this.saveOrionLog(userId, this.symbol, 'info', logMsg);
          }
        }
      }

      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) continue;

      // ✅ CORREÇÃO MARTINGALE: Active Fallback usando Momentum + Delta (PRECISO: 3 Ticks + Delta 0.5)
      if (state.perdaAcumulada > 0 && !defesaAtiva) {
        // Usar lógica "Momentum + Delta" também para Preciso
        const momentumSignal = this.checkMomentumAndStrength(state, 3, 0.5, 'NORMAL');

        if (!momentumSignal) continue;

        const novoSinal = momentumSignal;

        const entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = novoSinal;

        this.logger.log(`[ORION][Preciso][${userId}] 🔄 Recuperação Rápida (Martingale) | Entrada: ${entryNumber} | Direção: ${novoSinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🔄 Recuperação Rápida. Momentum + Delta (${novoSinal})`);

        await this.executeOrionOperation(state, novoSinal, 'preciso', entryNumber);
        continue;
      }

      // ✅ NOVO: Usar check_signal (Estratégia Híbrida Dual-Core)
      const riskManager = this.riskManagers.get(userId);
      const sinal = this.check_signal(state, 'preciso', riskManager);
      if (!sinal) continue;

      this.logger.log(`[ORION][Preciso] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`);
      this.saveOrionLog(userId, this.symbol, 'sinal', `✅ SINAL GERADO: ${sinal}`);

      let entryNumber = 1;
      // ✅ CORREÇÃO: Qualquer perda acumulada deve acionar lógica de Martingale
      if (state.perdaAcumulada > 0) {
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        this.logger.log(`[ORION][Preciso][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🛡️ Defesa ativa. Continuando MARTINGALE com nova direção em modo LENTO (2 movimentos)`);
      } else {
        state.ultimaDirecaoMartingale = sinal;
      }

      await this.executeOrionOperation(state, sinal, 'preciso', entryNumber);
    }
  }

  private async processLentaStrategies(latestTick: Tick): Promise<void> {
    if (this.lentaUsers.size === 0) {
      this.logger.debug(`[ORION][Lenta] Nenhum usuário ativo (total: ${this.lentaUsers.size})`);
      return;
    }

    // Processar cada usuário
    for (const [userId, state] of this.lentaUsers.entries()) {
      if (state.ticksColetados < LENTA_CONFIG.amostraInicial) {
        // ✅ Incrementar contador de ticks coletados
        state.ticksColetados++;

        const ticksAtuais = state.ticksColetados;
        const amostraNecessaria = LENTA_CONFIG.amostraInicial;
        const ticksFaltando = amostraNecessaria - ticksAtuais;

        // ✅ Logar apenas uma vez quando começar a coletar (não a cada tick)
        const key = `lenta_${userId}`;
        if (!this.coletaLogsEnviados.has(key)) {
          this.coletaLogsEnviados.set(key, new Set());
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Lenta)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        // ✅ Logar progresso periodicamente (apenas a cada 10 ticks)
        if (ticksAtuais > 0 && ticksAtuais % 10 === 0) {
          const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${amostraNecessaria} TICKS (Modo Lenta)\n• CONTAGEM: ${ticksAtuais}/${amostraNecessaria}`;
          this.logger.debug(`[ORION][Lenta][${userId}] Coletando: ${ticksAtuais}/${amostraNecessaria}`);
          this.saveOrionLog(userId, this.symbol, 'info', logMsg);
        }

        continue;
      }

      // ✅ Logar quando completar a coleta (apenas uma vez)
      if (state.ticksColetados === LENTA_CONFIG.amostraInicial) {
        const key = `lenta_${userId}`;
        if (this.coletaLogsEnviados.has(key)) {
          const marcosLogados = this.coletaLogsEnviados.get(key)!;
          if (!marcosLogados.has(100)) {
            marcosLogados.add(100);
            const logMsg = `📡 COLETANDO DADOS...\n• META DE COLETA: ${LENTA_CONFIG.amostraInicial} TICKS (Modo Lenta)\n• CONTAGEM: ${LENTA_CONFIG.amostraInicial}/${LENTA_CONFIG.amostraInicial} (COMPLETO)`;
            this.saveOrionLog(userId, this.symbol, 'info', logMsg);
          }
        }
      }

      const consecutiveLosses = state.consecutive_losses || 0;
      const defesaAtiva = consecutiveLosses >= 3;
      if (state.isOperationActive) continue;

      // ✅ [ZENIX v2.0] Cooldown entre operações (Modo Lenta: 5 ticks)
      const intervaloMinimo = LENTA_CONFIG.intervaloTicks || 0;
      if (state.ticksDesdeUltimaOp < intervaloMinimo) {
        continue;
      }

      // ✅ [ZENIX v2.0] Cooldown DE TEMPO (10s) - Pedido explícito de precisão
      const now = Date.now();
      if (state.lastOperationTimestamp && (now - state.lastOperationTimestamp < 10000)) {
        // Aguardando tempo...
        continue;
      }

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale IMEDIATAMENTE (Active Fallback)
      // ⚠️ FIX: Não ativar fallback se estiver em MODO DE DEFESA (3+ losses) para respeitar o tempo do filtro LENTO
      if (state.perdaAcumulada > 0 && !defesaAtiva) {
        // ✅ [ZENIX v2.0] Active Fallback: Usar Momentum + Delta (LENTA: 3 Ticks + Delta 0.5)
        const pullbackSignal = this.checkMomentumAndStrength(state, 3, 0.5, 'LENTA');

        if (!pullbackSignal) {
          // Aguardando confirmação do Momentum...
          const now = Date.now();
          if (now - (state.lastRecoveryLog || 0) > 4000) {
            state.lastRecoveryLog = now;
            this.logger.debug(`[ORION][Lenta] ⏳ Aguardando Momentum (3 Ticks) + Delta >= 0.5...`);
          }
          continue;
        }

        const novoSinal = pullbackSignal;
        const entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = novoSinal;

        this.logger.log(`[ORION][Lenta][${userId}] 🔄 Recuperação Rápida (Dinâmica) | Entrada: ${entryNumber} | Direção: ${novoSinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        this.saveOrionLog(userId, this.symbol, 'operacao', `🔄 Recuperação Rápida. Momentum + Delta (${novoSinal})`);

        // Atualiza timestamp também na recuperação
        state.lastOperationTimestamp = Date.now();
        await this.executeOrionOperation(state, novoSinal, 'lenta', entryNumber);
        continue;
      }

      const riskManager = this.riskManagers.get(userId);
      const sinal = this.check_signal(state, 'lenta', riskManager);
      if (!sinal) {
        // ✅ Feedback visual: Aguardando sinal de defesa
        if (state.perdaAcumulada > 0) {
          const now = Date.now();
          const lastLog = (state as any).lastWaitingLog || 0;
          if (now - lastLog > 5000) {
            (state as any).lastWaitingLog = now;
            this.logger.debug(`[ORION][Lenta][${userId}] 🛡️ Defesa ativa. Aguardando sinal de Price Action...`);
          }
        }
        continue;
      }

      this.logger.log(`[ORION][Lenta] 🎯 SINAL | User: ${userId} | Operação: ${sinal}`);
      this.saveOrionLog(userId, this.symbol, 'sinal', `✅ SINAL GERADO: ${sinal}`);

      let entryNumber = 1;
      // ✅ CORREÇÃO: Qualquer perda acumulada deve acionar lógica de Martingale
      if (state.perdaAcumulada > 0) {
        entryNumber = (state.martingaleStep || 0) + 1;
        state.ultimaDirecaoMartingale = sinal;
        this.logger.log(`[ORION][Lenta][${userId}] 🛡️ Defesa ativa. Continuando MARTINGALE com nova direção | Entrada: ${entryNumber} | Direção: ${sinal} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
        // Removido log duplicado de "Recuperação Rápida" aqui, pois executeOrionOperation já loga o Martingale
      } else {
        state.ultimaDirecaoMartingale = sinal;
      }

      state.lastOperationTimestamp = Date.now(); // ✅ Atualiza timestamp da operação
      await this.executeOrionOperation(state, sinal, 'lenta', entryNumber);
    }
  }

  /**
   * ✅ ORION: Executa operação completa
   */
  private async executeOrionOperation(
    state: VelozUserState | ModeradoUserState | PrecisoUserState,
    operation: OrionSignal,
    mode: 'veloz' | 'moderado' | 'preciso' | 'lenta',
    entry: number = 1,
  ): Promise<void> {
    // ✅ [ZENIX v2.0] Bloqueio imediato para evitar race condition de múltiplos disparos por tick
    if (state.isOperationActive) {
      return;
    }
    state.isOperationActive = true;

    // ✅ Resetar contador de ticks ao iniciar operação
    if ('ticksDesdeUltimaOp' in state) {
      state.ticksDesdeUltimaOp = 0;
    }

    // ✅ Declarar tradeId no escopo da função para ser acessível no catch
    let tradeId: number | null = null;
    let forcedStake: number | null = null; // ✅ Variável para forçar limite de stake (stop loss)
    try {
      const stopLossConfig = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stake_amount, 0) as capitalInicial,
          COALESCE(profit_peak, 0) as profitPeak,
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

        // ✅ [NOVO] Criar/obter RiskManager para este usuário
        if (!this.riskManagers.has(state.userId)) {
          const useBlindado = config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined;
          // Mapear modoMartingale para riskMode
          const modoMartingale = state.modoMartingale || 'conservador';
          const riskMode = modoMartingale.toUpperCase() === 'CONSERVADOR'
            ? 'CONSERVADOR'
            : modoMartingale.toUpperCase() === 'MODERADO'
              ? 'MODERADO'
              : 'AGRESSIVO';
          this.riskManagers.set(
            state.userId,
            new RiskManager(capitalInicial, lossLimit, profitTarget, riskMode, useBlindado),
          );
        }

        // ✅ CORREÇÃO: Usar session_balance para calcular capital da sessão
        // Capital da sessão = capitalInicial + session_balance (lucro/perda da sessão)
        const sessionBalance = parseFloat(config.sessionBalance) || 0;
        const capitalSessao = capitalInicial + sessionBalance;

        // Calcular perda/lucro atual (session_balance já é o lucro/perda da sessão)
        const lucroAtual = sessionBalance; // session_balance já é o lucro/perda
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;

        // ✅ Verificar STOP WIN (profit target) antes de executar operação
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
          this.logger.log(
            `[ORION][${mode}][${state.userId}] 🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} >= Meta: $${profitTarget.toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
          );
          this.saveOrionLog(state.userId, this.symbol, 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)} | Meta: $${profitTarget.toFixed(2)} - IA DESATIVADA`);

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

        // ✅ Verificar STOP-LOSS BLINDADO antes de executar operação (ZENIX v2.0 - Dynamic Trailing)
        // Ativar se atingir 40% da meta. Proteger 50% do lucro máximo (PICO).
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          let profitPeak = parseFloat(config.profitPeak) || 0;
          const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
          const activationThreshold = profitTarget * 0.40;

          // ✅ Log de progresso ANTES de ativar (quando lucro < 40% da meta)
          if (lucroAtual > 0 && lucroAtual < activationThreshold) {
            const percentualProgresso = (lucroAtual / activationThreshold) * 100;
            this.saveOrionLog(
              state.userId,
              this.symbol,
              'info',
              `ℹ️🛡️ Stop Blindado: Lucro $${lucroAtual.toFixed(2)} | Meta ativação: $${activationThreshold.toFixed(2)} (${percentualProgresso.toFixed(1)}%)`
            );
          }

          // Auto-healing: se lucro atual superou o pico registrado, atualizar pico
          if (lucroAtual > profitPeak) {
            const profitPeakAnterior = profitPeak;
            profitPeak = lucroAtual;

            // ✅ Log quando profit peak aumenta (após ativação)
            if (profitPeak >= activationThreshold) {
              const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
              const stopBlindado = capitalInicial + protectedAmount;

              this.logger.log(
                `[ORION][${mode}][${state.userId}] ℹ️🛡️ Stop Blindado Atualizado | ` +
                `Lucro: $${profitPeak.toFixed(2)} | Protegendo ${stopBlindadoPercent}%: $${protectedAmount.toFixed(2)}`
              );
              this.saveOrionLog(
                state.userId,
                this.symbol,
                'info',
                `ℹ️🛡️Stop Blindado: Ativado | Lucro atual $${profitPeak.toFixed(2)} | Protegendo ${stopBlindadoPercent}%: $${protectedAmount.toFixed(2)}`
              );
            }

            // Atualizar no banco em background
            this.dataSource.query(
              `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
              [profitPeak, state.userId],
            ).catch(err => this.logger.error(`[ORION] Erro ao atualizar profit_peak:`, err));
          }

          // Ativar apenas se atingiu 40% da meta
          if (profitPeak >= profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0; // Padrão 50%
            const fatorProtecao = stopBlindadoPercent / 100;

            // Trailing Stop: Protege % do PICO de lucro
            const protectedAmount = profitPeak * fatorProtecao;
            const stopBlindado = capitalInicial + protectedAmount;

            // ✅ Log quando Stop Blindado é ativado pela primeira vez (só loga se ainda não logou)
            const stopBlindadoKey = `stop_blindado_ativado_${state.userId}`;
            if (!this.defesaDirecaoInvalidaLogsEnviados.has(stopBlindadoKey)) {
              this.defesaDirecaoInvalidaLogsEnviados.set(stopBlindadoKey, true);
              this.logger.log(
                `[ORION][${mode}][${state.userId}] ℹ️🛡️ Stop Blindado Ativado | ` +
                `Lucro: $${profitPeak.toFixed(2)} | ` +
                `Protegendo ${stopBlindadoPercent}%: $${protectedAmount.toFixed(2)}`
              );
              this.saveOrionLog(
                state.userId,
                this.symbol,
                'info',
                `ℹ️🛡️Stop Blindado: Ativado | Lucro atual $${profitPeak.toFixed(2)} | Protegendo ${stopBlindadoPercent}%: $${protectedAmount.toFixed(2)}`
              );
            }

            // Se capital da sessão caiu abaixo do stop blindado → PARAR
            if (capitalSessao <= stopBlindado) {
              const lucroProtegido = capitalSessao - capitalInicial;

              this.logger.warn(
                `[ORION][${mode}][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
                `Capital Sessão: $${capitalSessao.toFixed(2)} <= Stop: $${stopBlindado.toFixed(2)} | ` +
                `Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%) - BLOQUEANDO OPERAÇÃO`,
              );

              this.saveOrionLog(
                state.userId,
                this.symbol,
                'alerta',
                `💰✅Stoploss blindado atingido, o sistema parou as operações com um lucro de $${lucroProtegido.toFixed(2)} para proteger o seu capital.`,
              );

              const deactivationReason =
                `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
                `(${stopBlindadoPercent}% do pico de $${profitPeak.toFixed(2)})`;

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
              this.lentaUsers.delete(state.userId); // Corrigido para incluir lentaUsers

              return; // NÃO EXECUTAR OPERAÇÃO
            }
          }
        }

        // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
        // ✅ CORREÇÃO: Verificar ANTES de calcular stake para bloquear imediatamente
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(
            `[ORION][${mode}][${state.userId}] 🛑 STOP LOSS ATINGIDO! Perda atual: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - BLOQUEANDO OPERAÇÃO`,
          );
          this.saveOrionLog(state.userId, this.symbol, 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);

          // Desativar a IA
          await this.dataSource.query(
            `UPDATE ai_user_config 
             SET is_active = 0, session_status = 'stopped_loss', deactivation_reason = ?, deactivated_at = NOW()
             WHERE user_id = ? AND is_active = 1`,
            [`Stop loss atingido: Perda $${perdaAtual.toFixed(2)} >= Limite $${lossLimit.toFixed(2)}`, state.userId],
          );

          // Remover usuário do monitoramento
          this.velozUsers.delete(state.userId);
          this.moderadoUsers.delete(state.userId);
          this.precisoUsers.delete(state.userId);
          this.lentaUsers.delete(state.userId);

          // ✅ IMPORTANTE: Bloquear operação imediatamente
          state.isOperationActive = false;
          // ✅ Resetar contador de ticks mesmo quando bloqueado para permitir nova tentativa
          if ('ticksDesdeUltimaOp' in state) {
            state.ticksDesdeUltimaOp = 0;
          }
          return; // NÃO EXECUTAR OPERAÇÃO
        }

        // ✅ Verificar Stop Loss Blindado para Martingale
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined && entry > 1) {
          const profitPeak = Math.max(parseFloat(config.profitPeak) || 0, lucroAtual);
          // Só ativa se atingiu 40% da meta
          if (profitPeak >= profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
            const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
            const stopBlindado = capitalInicial + protectedAmount;

            // Calcular próximo stake do martingale
            const payoutCliente = 92;
            const baseStake = state.apostaInicial || 0.35;
            const stakeMartingale = calcularProximaAposta(state.perdaAcumulada, state.modoMartingale, payoutCliente, baseStake);
            const perdaTotalPotencial = perdaAtual + stakeMartingale; // Perda atual + novo risco (?) 
            // Na verdade, queremos saber se: Capital Sessão - Stake < Stop Blindado
            const saldoDisponivel = capitalSessao - stopBlindado;

            if (stakeMartingale > saldoDisponivel) {
              // Stake ultrapassa o permitido. Ajustar para o máximo permitido ou resetar?
              // Usuário pediu "reajuste seu valor".
              // Se houver saldo positivo (> 0.35), usamos o saldo restante. Senão reiniciamos.
              if (saldoDisponivel >= 0.35) {
                this.logger.warn(`[ORION] ⚠️🛡️ Ajustando stake Martingale para respeitar Stop Blindado. De: ${stakeMartingale} para: ${saldoDisponivel.toFixed(2)}`);
                this.saveOrionLog(state.userId, this.symbol, 'alerta', `⚠️🛡️ Ajustando martingale para respeitar Stop Blindado: $${stakeMartingale.toFixed(2)} ➔ $${saldoDisponivel.toFixed(2)}`);

                // ✅ NÃO resetar o estado do martingale, apenas limitar o valor da aposta
                // Isso garante que se ganhar, o sistema reconheça como vitória de martingale e reset para aposta inicial
                forcedStake = saldoDisponivel;

                // O fluxo segue para execução com o novo stakeAmount
              } else {
                // Sem saldo nem para aposta mínima -> Stop Loss será acionado na próxima verificação ou agora
                // Se blocked here, we return.
                return; // Stop operation
              }
            }
          }
        }

        // ✅ CORREÇÃO: Não bloquear operação prévia se ultrapassaria stop loss
        // Permitir operação com valor base e verificar stop loss APÓS a perda
        // Se a operação perder e atingir o stop loss, então parar
        if (lossLimit > 0 && entry > 1 && state.perdaAcumulada > 0) {
          // Se está em martingale, verificar se a próxima aposta ultrapassaria o stop loss
          // Se sim, usar aposta base ao invés de martingale
          const payoutCliente = 92;
          const baseStake = state.apostaInicial || 0.35;
          const stakeMartingale = calcularProximaAposta(state.perdaAcumulada, state.modoMartingale, payoutCliente, baseStake);
          const perdaTotalPotencial = perdaAtual + stakeMartingale;

          if (perdaTotalPotencial > lossLimit) {
            // ✅ Em vez de bloquear, usar aposta base e resetar martingale
            this.logger.warn(
              `[ORION][${mode}][${state.userId}] ⚠️ Martingale bloqueado! Próxima aposta ($${stakeMartingale.toFixed(2)}) ultrapassaria stop loss de $${lossLimit.toFixed(2)}. Usando aposta base.`,
            );
            this.saveOrionLog(state.userId, this.symbol, 'alerta', `⚠️ Martingale bloqueado! Próxima aposta ($${stakeMartingale.toFixed(2)}) ultrapassaria stop loss de $${lossLimit.toFixed(2)}. Usando aposta base.`);

            // Resetar martingale e usar aposta base
            state.perdaAcumulada = 0;
            state.ultimaDirecaoMartingale = null;
            state.martingaleStep = 0;
            if ('ultimaApostaUsada' in state) state.ultimaApostaUsada = 0;
            this.logger.log(`[ORION][${mode}][${state.userId}] 🔄 Martingale resetado. Continuando com aposta base.`);
            // Continuar com entry = 1 (aposta base)
            entry = 1;
          }
        }

        // ✅ Se for primeira entrada e stake base ultrapassaria stop loss, permitir mesmo assim
        // O stop loss será verificado APÓS a perda (no processOrionResult)
        if (lossLimit > 0 && entry === 1) {
          const stakeBase = state.apostaInicial || 0.35;
          const perdaTotalPotencial = perdaAtual + stakeBase;

          if (perdaTotalPotencial > lossLimit) {
            this.logger.warn(
              `[ORION][${mode}][${state.userId}] ⚠️ Atenção: Aposta base ($${stakeBase.toFixed(2)}) ultrapassaria stop loss de $${lossLimit.toFixed(2)}. Permitindo operação. Stop loss será verificado após perda.`,
            );
            this.saveOrionLog(state.userId, this.symbol, 'alerta', `⚠️ Atenção: Aposta base ($${stakeBase.toFixed(2)}) ultrapassaria stop loss de $${lossLimit.toFixed(2)}. Permitindo operação. Stop loss será verificado após perda.`);
            // Continuar com a operação - não bloquear
          }
        }
      }
    } catch (error) {
      this.logger.error(`[ORION][${mode}][${state.userId}] Erro ao verificar stop loss:`, error);
      // Continuar mesmo se houver erro na verificação (fail-open)
    }

    // ✅ VALIDAÇÕES PREVENTIVAS serão feitas APÓS calcular o stakeAmount
    // state.isOperationActive = true; // Removido: agora é feito no início da função
    // ✅ CORREÇÃO: martingaleStep é gerenciado após perda/vitória, não aqui
    // entry é apenas para logs e cálculo do stake

    // Resetar contador de ticks
    // ✅ Intervalo entre operações REMOVIDO - não é mais necessário resetar ticksDesdeUltimaOp

    // Atualizar timestamp da última operação (Moderado)
    // ✅ Atualizar timestamp da última operação (pode ser útil para outras funcionalidades)
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
          // ✅ Arredondar para 2 casas decimais (requisito da Deriv)
          stakeAmount = Math.round(stakeAmount * 100) / 100;
        } else {
          // Fallback: usar aposta inicial
          this.logger.warn(
            `[ORION][${mode}][${state.userId}] ⚠️ Soros retornou null, usando aposta inicial`,
          );
          stakeAmount = state.apostaInicial || state.capital || 0.35;
          // ✅ Arredondar para 2 casas decimais
          stakeAmount = Math.round(stakeAmount * 100) / 100;
        }
      } else {
        // Primeira entrada normal: usar aposta inicial
        // ✅ GARANTIR que após recuperar do martingale, sempre use aposta inicial
        // Se vitoriasConsecutivas é 0 e ultimoLucro é 0, deve usar aposta inicial
        if ((state.vitoriasConsecutivas || 0) === 0 && (state.ultimoLucro || 0) === 0) {
          stakeAmount = state.apostaInicial || 0.35;
          // ✅ Garantir que apostaBase também está resetada
          if ('apostaBase' in state && state.apostaBase !== state.apostaInicial) {
            state.apostaBase = state.apostaInicial || 0.35;
            this.logger.debug(
              `[ORION][${mode}][${state.userId}] 🔄 Corrigindo apostaBase para aposta inicial: $${(state.apostaInicial || 0.35).toFixed(2)}`,
            );
          }
        } else {
          stakeAmount = state.apostaInicial || state.capital || 0.35;
        }
        // ✅ Arredondar para 2 casas decimais
        stakeAmount = Math.round(stakeAmount * 100) / 100;
      }

      // ✅ Garantir que martingaleStep está em 0 para primeira entrada
      if ('martingaleStep' in state) {
        state.martingaleStep = 0;
      }
    } else {
      // Martingale: calcular próxima aposta
      const payoutCliente = 92; // Payout padrão (95 - 3)
      const baseStake = state.apostaInicial || 0.35;

      // ✅ [CONCURSO] ZENIX v2.0 - Resetar martingale se ultrapassar limite de 5 martingales (6 entradas totais)
      // entry 1: base, entry 2-6: martingale 1-5. entry 7: reset.
      if (state.modoMartingale === 'conservador' && entry > 6) {
        this.logger.warn(`[ORION][${mode}][${state.userId}] ⚠️ LIMITE DE RECUPERAÇÃO ATINGIDO (CONSERVADOR). Resetando.`);
        this.saveOrionLog(state.userId, this.symbol, 'alerta', `⚠️ LIMITE DE RECUPERAÇÃO ATINGIDO (CONSERVADOR)\n• Ação: Aceitando perda e resetando stake.\n• Próxima Entrada: Valor Inicial ($${(state.apostaInicial || 0.35).toFixed(2)})`);

        state.perdaAcumulada = 0;
        state.martingaleStep = 0;
        state.vitoriasConsecutivas = 0;
        state.consecutive_losses = 0;
        if ('ultimaDirecaoMartingale' in state) state.ultimaDirecaoMartingale = null;

        stakeAmount = baseStake;
        forcedStake = baseStake; // ✅ FORÇAR que este valor seja respeitado mesmo com RiskManager
      } else {
        stakeAmount = calcularProximaAposta(state.perdaAcumulada, state.modoMartingale, payoutCliente, baseStake);
      }

      // ✅ Arredondar para 2 casas decimais (requisito da Deriv)
      stakeAmount = Math.round(stakeAmount * 100) / 100;

      // Garantir valor mínimo
      if (stakeAmount < 0.35) {
        stakeAmount = 0.35;
      }

      // ✅ Log: Martingale Ativado (Formato Solicitado)
      const targetProfit = 0; // Simplificação, ou calcular se disponível
      this.logger.log(`🔄 MARTINGALE ATIVADO\n• Nível: M${state.martingaleStep || 1}\n• Contrato: ${operation}\n• Investimento: $${stakeAmount.toFixed(2)}\n• Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} + $${targetProfit.toFixed(2)}\n______________`);
      this.saveOrionLog(state.userId, this.symbol, 'alerta', `🔄 MARTINGALE ATIVADO\n• Nível: M${state.martingaleStep || 1}\n• Contrato: ${operation}\n• Investimento: $${stakeAmount.toFixed(2)}\n• Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} + $${targetProfit.toFixed(2)}\n______________`);
    }

    // ✅ Aplicar limite forçado (se houver) decorrente do Stop Loss Blindado/Normal
    if (forcedStake !== null) {
      if (stakeAmount > forcedStake) {
        this.logger.warn(`[ORION] 🛡️ Aplicando limite forçado de stake: ${stakeAmount.toFixed(2)} -> ${forcedStake.toFixed(2)}`);
        stakeAmount = forcedStake;
      }
    }

    // ✅ [NOVO] VALIDAÇÃO UNIFICADA: Garantir que TODAS as entradas (Martingale, Soros, Normal) respeitam Stop Loss
    try {
      const stopLossConfig = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(stake_amount, 0) as capitalInicial,
          COALESCE(profit_peak, 0) as profitPeak,
          stop_blindado_percent as stopBlindadoPercent
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

        // ✅ IMPORTANTE: Usar state.capital (valor atual em memória) ao invés de consultar DB
        // Isso garante que estamos usando o saldo MAIS RECENTE após todas as operações
        const capitalSessao = state.capital;
        const sessionBalance = capitalSessao - capitalInicial;
        const lucroAtual = sessionBalance;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;

        let maxStakeAllowed = Infinity;

        // 1. Verificar Stop Loss Normal
        if (lossLimit > 0) {
          const remainingLoss = lossLimit - perdaAtual;
          if (remainingLoss > 0) {
            maxStakeAllowed = Math.min(maxStakeAllowed, remainingLoss);
          } else {
            maxStakeAllowed = 0;
          }
        }

        // 2. Verificar Stop Loss Blindado
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          const profitPeak = parseFloat(config.profitPeak) || 0;
          // Só ativa se atingiu 40% da meta
          if (profitPeak >= profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
            const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
            const stopBlindado = capitalInicial + protectedAmount;
            const availableCapitalAboveStop = capitalSessao - stopBlindado;

            this.logger.debug(
              `[ORION][${mode}][${state.userId}] 🛡️ Stop Blindado Check:` +
              ` Capital: $${capitalSessao.toFixed(2)} |` +
              ` Profit Peak: $${profitPeak.toFixed(2)} |` +
              ` Protected: $${protectedAmount.toFixed(2)} |` +
              ` Stop Level: $${stopBlindado.toFixed(2)} |` +
              ` Available: $${availableCapitalAboveStop.toFixed(2)}`
            );

            if (availableCapitalAboveStop > 0) {
              maxStakeAllowed = Math.min(maxStakeAllowed, availableCapitalAboveStop);
            } else {
              maxStakeAllowed = 0;
            }
          }
        }

        // 3. Aplicar limite se necessário
        if (maxStakeAllowed !== Infinity && stakeAmount > maxStakeAllowed) {
          const originalStake = stakeAmount;

          // Se o limite é menor que o mínimo (0.35), bloquear operação
          if (maxStakeAllowed < 0.35) {
            this.logger.warn(
              `[ORION][${mode}][${state.userId}] 🛑 Stake mínimo (0.35) excede limite de Stop Loss (${maxStakeAllowed.toFixed(2)}). Bloqueando operação.`,
            );
            this.saveOrionLog(
              state.userId,
              this.symbol,
              'alerta',
              `🛑 Operação bloqueada: stake mínimo excede limite de Stop Loss`,
            );
            return; // Bloquear operação
          }

          // Ajustar stake para o máximo permitido
          stakeAmount = Math.max(0.35, maxStakeAllowed);
          stakeAmount = Math.round(stakeAmount * 100) / 100;

          this.logger.warn(
            `[ORION][${mode}][${state.userId}] 🛡️ Stake ajustado para respeitar Stop Loss: $${originalStake.toFixed(2)} -> $${stakeAmount.toFixed(2)}`,
          );
          this.saveOrionLog(
            state.userId,
            this.symbol,
            'alerta',
            `🛡️ Stake ajustado: $${originalStake.toFixed(2)} -> $${stakeAmount.toFixed(2)} (Stop Loss)`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`[ORION][${mode}][${state.userId}] Erro ao validar stake contra Stop Loss:`, error);
      // Continuar mesmo se houver erro na validação (fail-open)
    }

    // ✅ [NOVO] Aplicar RiskManager para ajustar stake (Stop Loss de Precisão)
    // O RiskManager aplica sua própria lógica de recuperação baseada em consecutiveLosses
    // e também verifica Stop Loss Normal vs Blindado
    const riskManager = this.riskManagers.get(state.userId);
    if (riskManager) {
      const baseStake = state.apostaInicial || state.capital || 0.35;
      const lastProfit = state.ultimoLucro || 0;
      // RiskManager calcula stake incluindo recuperação se necessário e verifica Stop Loss
      // Passar vitoriasConsecutivas para o RiskManager calcular Soros corretamente até nível 3
      const vitoriasAtuais = state.vitoriasConsecutivas || 0;
      const adjustedStake = riskManager.calculateStake(
        state.capital,
        baseStake,
        lastProfit,
        this.logger,
        vitoriasAtuais,
        (t, m) => this.saveOrionLog(state.userId, this.symbol, t as any, m),
      );
      if (adjustedStake === 0) {
        // ✅ Se RiskManager retornou 0, parar operações (Stop Loss atingido)
        this.logger.warn(
          `[ORION][${mode}][${state.userId}] 🚨 RiskManager bloqueou operação. Stop Loss atingido.`,
        );
        this.saveOrionLog(state.userId, this.symbol, 'alerta', `🚨 RiskManager bloqueou operação. Stop Loss atingido.`);
        return; // Parar operação
      } else {
        // Se há martingale ativo (entry > 1), usar o stake calculado pelo martingale
        // mas ajustado pelo RiskManager conforme Stop Loss
        if (entry > 1) {
          // Martingale: usar o maior entre o calculado pelo martingale e o do RiskManager
          // (RiskManager pode ter ajustado para respeitar Stop Loss)
          // ✅ CORREÇÃO: Se forcedStake estiver definido (Reset Conservador), NÃO usar Math.max(stake, adjusted)
          // Pois adjustedStake pode trazer valor de recuperação antigo do RiskManager
          if (forcedStake !== null) {
            stakeAmount = forcedStake;
          } else {
            stakeAmount = Math.max(stakeAmount, adjustedStake);
          }
        } else {
          // Primeira entrada: se já calculamos Soros, manter o stake do Soros
          // mas validar se não viola Stop Loss (usar o menor entre Soros e ajustado)
          const vitoriasAtuais = state.vitoriasConsecutivas || 0;
          if (vitoriasAtuais > 0 && vitoriasAtuais <= SOROS_MAX_NIVEL) {
            // Já está no Soros: manter o stake calculado, mas respeitar limite do RiskManager
            stakeAmount = Math.min(stakeAmount, adjustedStake);
          } else {
            // Não está no Soros: usar stake calculado pelo RiskManager
            stakeAmount = adjustedStake;
          }
        }
      }
      // ✅ Garantir arredondamento após ajuste do RiskManager
      stakeAmount = Math.round(stakeAmount * 100) / 100;
    }



    // ✅ Log de Soros Nível 1 - Já tratado no RiskManager ou logs anteriores
    // Removido para evitar duplicação conforme solicitado

    // ✅ VALIDAÇÕES PREVENTIVAS após calcular stakeAmount
    // ✅ Garantir que stakeAmount sempre tem exatamente 2 casas decimais antes de enviar
    stakeAmount = Math.round(stakeAmount * 100) / 100;
    // 0. Cooldown para mitigar rate limit (se houve erro/timeout recente)
    if (state.creationCooldownUntil && Date.now() < state.creationCooldownUntil) {
      this.logger.warn(`[ORION][${mode}][${state.userId}] ⏸️ Cooldown ativo para criação de contrato. Aguardando antes de nova tentativa.`);
      state.isOperationActive = false;
      // ✅ Resetar contador de ticks para permitir nova tentativa
      if ('ticksDesdeUltimaOp' in state) {
        state.ticksDesdeUltimaOp = 0;
      }
      return;
    }

    // 1. Validar valor mínimo da Deriv ($0.35)
    if (stakeAmount < 0.35) {
      this.logger.warn(
        `[ORION][${mode}][${state.userId}] ❌ Valor abaixo do mínimo | Stake: $${stakeAmount.toFixed(2)} | Mínimo: $0.35 | Ajustando para mínimo`,
      );
      stakeAmount = 0.35; // Ajustar para o mínimo
      this.saveOrionLog(state.userId, this.symbol, 'alerta', `⚠️ Valor da aposta ajustado para o mínimo permitido: $0.35`);
    }

    // 2. Validar saldo mínimo (com margem de segurança de 10%)
    const saldoNecessario = stakeAmount * 1.1; // 10% de margem
    if (state.capital < saldoNecessario) {
      this.logger.warn(
        `[ORION][${mode}][${state.userId}] ❌ Saldo insuficiente | Capital: $${state.capital.toFixed(2)} | Necessário: $${saldoNecessario.toFixed(2)} (stake: $${stakeAmount.toFixed(2)} + margem)`,
      );
      state.isOperationActive = false;
      this.saveOrionLog(state.userId, this.symbol, 'erro', `❌ Saldo insuficiente para operação | Capital: $${state.capital.toFixed(2)} | Necessário: $${saldoNecessario.toFixed(2)}`);
      // ✅ Resetar contador de ticks para permitir nova tentativa
      if ('ticksDesdeUltimaOp' in state) {
        state.ticksDesdeUltimaOp = 0;
      }
      return; // Não tentar criar contrato se não tiver saldo suficiente
    }

    // 3. Validar token
    if (!state.derivToken || state.derivToken.trim() === '') {
      this.logger.error(`[ORION][${mode}][${state.userId}] ❌ Token Deriv inválido ou ausente`);
      state.isOperationActive = false;
      this.saveOrionLog(state.userId, this.symbol, 'erro', `❌ Token Deriv inválido ou ausente - Não é possível criar contrato`);
      // ✅ Resetar contador de ticks para permitir nova tentativa
      if ('ticksDesdeUltimaOp' in state) {
        state.ticksDesdeUltimaOp = 0;
      }
      return; // Não tentar criar contrato sem token
    }

    const currentPrice = this.ticks.length > 0 ? this.ticks[this.ticks.length - 1].value : 0;

    // ✅ Log: Entrada Executada (Formato Solicitado)
    const formattedDirection = operation;
    const payoutPercent = 92; // Payout padrão estimado

    this.logger.log(`📤 ENTRADA EXECUTADA\n• Tipo: ${operation}\n• Investimento: $${stakeAmount.toFixed(2)}\n• Payout: ${payoutPercent}%\n______________`);
    this.saveOrionLog(state.userId, this.symbol, 'operacao', `📤 ENTRADA EXECUTADA\n• Tipo: ${operation}\n• Investimento: $${stakeAmount.toFixed(2)}\n• Payout: ${payoutPercent}%\n______________`);

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
      // ✅ Garantir arredondamento final antes de enviar (requisito da Deriv: máximo 2 casas decimais)
      const finalStakeAmount = Math.round(stakeAmount * 100) / 100;

      // Definir parâmetros do contrato baseado no sinal
      let contractParams: any = {
        amount: finalStakeAmount,
        currency: state.currency || 'USD',
        symbol: this.symbol,
      };

      if (operation === 'DIGITOVER') {
        contractParams.contract_type = 'DIGITOVER';
        contractParams.barrier = '3'; // Over 3
        contractParams.duration = 1;
        contractParams.duration = 1;
        contractParams.duration_unit = 't';
      } else if (operation === 'CALL') {
        // Rise/Fall - Call
        contractParams.contract_type = 'CALL';
        contractParams.duration = 1;
        contractParams.duration_unit = 't';
      } else if (operation === 'PUT') {
        // Rise/Fall - Put
        contractParams.contract_type = 'PUT';
        contractParams.duration = 1;
        contractParams.duration_unit = 't';
      } else {
        // Fallback para Par/Ímpar (caso antigo)
        contractParams.contract_type = operation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
        contractParams.duration = 1;
        contractParams.duration_unit = 't';
      }

      const result = await this.executeOrionTradeViaWebSocket(
        state.derivToken,
        contractParams,
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
        this.saveOrionLog(state.userId, this.symbol, 'erro', `Erro ao executar operação | Não foi possível criar contrato`);
        return;
      }

      // ✅ Resultado já veio do mesmo WebSocket - processar diretamente
      const { contractId, profit, exitSpot, entrySpot } = result;
      const exitPrice = Number(exitSpot || 0);
      const entryPrice = Number(entrySpot || 0); // ✅ Preço de entrada oficial da Deriv
      const confirmedStatus = profit >= 0 ? 'WON' : 'LOST';

      // Atualizar trade no banco
      await this.dataSource.query(
        `UPDATE ai_trades
         SET contract_id = ?, exit_price = ?, entry_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
         WHERE id = ?`,
        [contractId, exitPrice, entryPrice, profit, confirmedStatus, tradeId],
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
      this.saveOrionLog(state.userId, this.symbol, 'erro', `Erro ao executar operação: ${error.message || 'Erro desconhecido'} | Detalhes: ${errorResponse}`);
    }
  }

  /**
   * ✅ ORION: Cria registro de trade no banco
   */
  private async createOrionTradeRecord(
    userId: string,
    operation: OrionSignal,
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
          operation,
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
            operation, // contract_type direto (DIGITOVER/CALL/PUT)
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
        contractType: operation as any,
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
  ): Promise<{ contractId: string; profit: number; exitSpot: any; entrySpot: any } | null> {
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
        ...((contractParams as any).barrier ? { barrier: (contractParams as any).barrier } : {}),
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
          this.saveOrionLog(userId, this.symbol, 'erro', userMessage);

          if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
            this.saveOrionLog(userId, this.symbol, 'alerta', `💡 Saldo insuficiente na Deriv.`);
          } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
            this.saveOrionLog(userId, this.symbol, 'alerta', `💡 Rate limit atingido na Deriv.`);
          } else if (errorCode === 'WrongResponse' || errorMessage.includes('WrongResponse')) {
            this.saveOrionLog(userId, this.symbol, 'alerta', `💡 Erro temporário da Deriv. Tente novamente em alguns segundos.`);
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
          this.saveOrionLog(userId, this.symbol, 'erro', `❌ Proposta inválida da Deriv | Resposta: ${JSON.stringify(proposalResponse)}`);
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

        // ✅ FIX: Logar erro VISÍVEL para o usuário (Frontend)
        if (userId) {
          this.saveOrionLog(userId, this.symbol, 'erro', `❌ FALHA NA ENTRADA: ${errorMessage} (Tentando novamente...)`);
          if (errorMessage.includes('Timeout')) {
            this.saveOrionLog(userId, this.symbol, 'alerta', `💡 Timeout ao comprar contrato. Tente novamente.`);
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
          this.saveOrionLog(userId, this.symbol, 'erro', `❌ Erro ao comprar contrato na Deriv | Código: ${errorCode} | Mensagem: ${errorMessage}`);

          if (errorMessage.toLowerCase().includes('insufficient') || errorMessage.toLowerCase().includes('balance')) {
            this.saveOrionLog(userId, this.symbol, 'alerta', `💡 Saldo insuficiente na Deriv.`);
          } else if (errorMessage.toLowerCase().includes('rate') || errorMessage.toLowerCase().includes('limit')) {
            this.saveOrionLog(userId, this.symbol, 'alerta', `💡 Rate limit atingido na Deriv.`);
          }
        }
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[ORION] ❌ Contrato criado mas sem contract_id: ${JSON.stringify(buyResponse)}`);
        if (userId) {
          this.saveOrionLog(userId, this.symbol, 'erro', `❌ Contrato criado mas sem contract_id | Resposta: ${JSON.stringify(buyResponse)}`);
        }
        return null;
      }

      const buyDuration = Date.now() - buyStartTime;
      this.logger.log(`[ORION] ✅ [${userId || 'SYSTEM'}] Contrato criado em ${buyDuration}ms | ContractId: ${contractId} | Monitorando...`);
      if (userId) {
        this.saveOrionLog(userId, this.symbol, 'operacao', `✅ Contrato criado: ${contractId} | Proposta: ${proposalDuration}ms | Compra: ${buyDuration}ms`);
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
              this.saveOrionLog(userId, this.symbol, 'erro', `⏱️ Contrato ${contractId} não finalizou em 90 segundos`);
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
                  if (userId) {
                    this.saveOrionLog(userId, this.symbol, 'erro', `❌ Erro na subscription do contrato ${contractId}: ${msg.error.message || JSON.stringify(msg.error)}`);
                  }
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
                const entrySpot = contract.entry_tick || contract.entry_spot || 0;
                const exitSpot = contract.exit_tick || contract.exit_spot || contract.current_spot;

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
                    this.symbol,
                    'resultado',
                    `✅ Contrato finalizado em ${monitorDuration}ms\n• Entrada: ${Number(entrySpot).toFixed(2)} | Saída: ${Number(exitSpot).toFixed(2)}\n• Primeira atualização: ${timeToFirstUpdate}ms | Total: ${updateCount} atualizações`,
                  );
                }

                connection.removeSubscription(contractId);
                resolve({ contractId, profit, exitSpot, entrySpot });
              }
            } catch (error) {
              if (!hasResolved) {
                hasResolved = true;
                if (contractMonitorTimeout) clearTimeout(contractMonitorTimeout);
                this.logger.error(`[ORION] ❌ Erro ao processar atualização do contrato:`, error);
                if (userId) {
                  this.saveOrionLog(
                    userId,
                    this.symbol,
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
                this.symbol,
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
          this.symbol,
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
    operation: OrionSignal,
    profit: number,
    mode: string,
  ): Promise<void> {
    // state.isOperationActive = false; // MOVIDO PARA O FINAL DO MÉTODO PARA EVITAR RACE CONDITION
    state.capital += profit;

    // ✅ [NOVO] Atualizar RiskManager após cada operação
    const riskManager = this.riskManagers.get(state.userId);
    if (riskManager) {
      riskManager.updateResult(profit, stakeAmount);
    }

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

      // ✅ Resetar flag de log de direção inválida quando operação for bem-sucedida
      const keyVeloz = `veloz_defesa_invalida_${state.userId}`;
      const keyModerado = `moderado_defesa_invalida_${state.userId}`;
      const keyPreciso = `preciso_defesa_invalida_${state.userId}`;
      const keyLenta = `lenta_defesa_invalida_${state.userId}`;
      this.defesaDirecaoInvalidaLogsEnviados.delete(keyVeloz);
      this.defesaDirecaoInvalidaLogsEnviados.delete(keyModerado);
      this.defesaDirecaoInvalidaLogsEnviados.delete(keyPreciso);
      this.defesaDirecaoInvalidaLogsEnviados.delete(keyLenta);

      if (consecutiveLossesAntes > 0) {
        this.logger.log(`[ORION][${mode}][${state.userId}] 🎯 DEFESA AUTOMÁTICA DESATIVADA | saiu do modo lento (loss zerado)`);
        this.saveOrionLog(state.userId, this.symbol, 'info', `🎯 saiu do modo lento`);
      }

      // ✅ VITÓRIA: Verificar se estava em martingale ANTES de processar Soros
      // IMPORTANTE: Verificar ANTES de resetar perdaAcumulada
      const perdaRecuperada = state.perdaAcumulada || 0;
      const estavaEmMartingale = perdaRecuperada > 0;

      // Resetar martingale primeiro
      if ('perdaAcumulada' in state) state.perdaAcumulada = 0;
      if ('ultimaDirecaoMartingale' in state) state.ultimaDirecaoMartingale = null;
      if ('martingaleStep' in state) state.martingaleStep = 0;
      if ('ultimaApostaUsada' in state) state.ultimaApostaUsada = 0;

      if (estavaEmMartingale) {
        // Se estava em martingale, NÃO aplicar Soros - RESETAR TUDO para aposta inicial
        if ('vitoriasConsecutivas' in state) state.vitoriasConsecutivas = 0;
        if ('ultimoLucro' in state) state.ultimoLucro = 0;
        if ('apostaBase' in state) {
          state.apostaBase = state.apostaInicial || 0.35;
        }

        this.logger.log(
          `[ORION][${mode}][${state.userId}] ✅ Recuperou perdas do martingale! ` +
          `Resetando para aposta inicial: $${(state.apostaInicial || 0.35).toFixed(2)} | ` +
          `ApostaBase: $${(state.apostaBase || 0.35).toFixed(2)} | ` +
          `UltimoLucro: $${(state.ultimoLucro || 0).toFixed(2)} | ` +
          `VitoriasConsecutivas: ${state.vitoriasConsecutivas || 0}`,
        );
        this.saveOrionLog(
          state.userId,
          this.symbol,
          'resultado',
          `✅ RECUPERAÇÃO CONCLUÍDA\n• PERDA RECUPERADA: $${perdaRecuperada.toFixed(2)}\n• RETORNANDO STAKE BASE: $${(state.apostaInicial || 0.35).toFixed(2)}`
        );
      } else {
        // NÃO estava em martingale: aplicar Soros
        if ('vitoriasConsecutivas' in state) {
          state.vitoriasConsecutivas = (state.vitoriasConsecutivas || 0) + 1;
        }

        // ✅ Verificar se completou o ciclo Soros (vitórias > SOROS_MAX_NIVEL)
        // Com SOROS_MAX_NIVEL = 1: após 2 vitórias (inicial + nível 1), resetar
        // Com SOROS_MAX_NIVEL = 3: após 4 vitórias (inicial + níveis 1, 2, 3), resetar
        if (state.vitoriasConsecutivas > SOROS_MAX_NIVEL) {
          // Ciclo Soros completo
          this.logger.log(`[ORION][${mode}][${state.userId}] 🎉 SOROS CICLO COMPLETO! ${state.vitoriasConsecutivas} vitórias (até nível ${SOROS_MAX_NIVEL})`);
          this.saveOrionLog(state.userId, this.symbol, 'resultado', `🎉 SOROS CICLO COMPLETO! ${state.vitoriasConsecutivas} vitórias (até nível ${SOROS_MAX_NIVEL})`);
          state.vitoriasConsecutivas = 0;
          state.ultimoLucro = 0;
          state.apostaBase = state.apostaInicial || 0.35;
        } else {
          if ('ultimoLucro' in state) state.ultimoLucro = profit;
          if ('apostaBase' in state) state.apostaBase = stakeAmount;

          if (state.vitoriasConsecutivas <= SOROS_MAX_NIVEL) {
            const proximaApostaSoros = calcularApostaComSoros(stakeAmount, profit, state.vitoriasConsecutivas);
            // Log já realizado no RiskManager.calculateStake
            // if (proximaApostaSoros !== null) {
            //   this.saveOrionLog(state.userId, this.symbol, 'resultado', `💰 SOROS Nível ${state.vitoriasConsecutivas} | Próxima: $${proximaApostaSoros.toFixed(2)}`);
            // }
          }
        }
      }

      const tipoOperacao = estavaEmMartingale ? 'MARTINGALE' : (state.vitoriasConsecutivas > 1 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL + 1) ? 'SOROS' : 'NORMAL';
      this.saveOrionLog(state.userId, this.symbol, 'resultado', `🏁 TRADE FINALIZADO: WIN\n💰 LUCRO: +$${profit.toFixed(2)}\n📈 BANCA ATUAL: $${state.capital.toFixed(2)}`);
    } else {
      // ❌ PERDA: Incrementar consecutive_losses (Defesa Automática)
      const consecutiveLossesAntes = state.consecutive_losses || 0;
      if ('consecutive_losses' in state) {
        state.consecutive_losses = consecutiveLossesAntes + 1;
      }
      const consecutiveLossesAgora = state.consecutive_losses || 0;
      this.logger.warn(`[ORION][${mode}][${state.userId}] ❌ PERDA | Losses: ${consecutiveLossesAntes} -> ${consecutiveLossesAgora}`);
      this.saveOrionLog(state.userId, this.symbol, 'resultado', `📊 LOSSES CONSECUTIVAS: ${consecutiveLossesAntes} → ${consecutiveLossesAgora}`);

      if (consecutiveLossesAgora >= 3) {
        this.logger.warn(`[ORION][${mode}][${state.userId}] 🚨 DEFESA AUTOMÁTICA ATIVADA | ${consecutiveLossesAgora} losses consecutivos.`);
        this.saveOrionLog(state.userId, this.symbol, 'alerta', `🚨 DEFESA AUTOMÁTICA ATIVADA\n• Motivo: ${consecutiveLossesAgora} Perdas Consecutivas.\n• Ação: Mudando análise para MODO DE RECUPERAÇÃO Dinâmico.`);
      }

      // ❌ PERDA: Resetar Soros
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
      const tipoOperacao = (state.perdaAcumulada || 0) > 0 ? 'MARTINGALE' : 'NORMAL';
      this.saveOrionLog(state.userId, this.symbol, 'erro', `🏁 TRADE FINALIZADO: LOSS\n📉 PREJUÍZO: -$${Math.abs(profit).toFixed(2)}\n📈 BANCA ATUAL: $${state.capital.toFixed(2)}`);
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
          COALESCE(profit_peak, 0) as profitPeak,
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

        // ✅ CORREÇÃO: Usar capital atual do estado em memória (mais preciso que session_balance do banco)
        // O estado em memória sempre reflete o capital atual da sessão após o resultado
        const capitalAtualMemoria = state.capital || capitalInicial;

        // Calcular perda/lucro atual baseado no capital atual em memória
        const lucroAtual = capitalAtualMemoria - capitalInicial;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;

        // ✅ Usar capital da sessão para cálculos (capital atual em memória)
        const capitalSessao = capitalAtualMemoria;

        // ✅ Atualizar session_balance no banco com o lucro/perda atual
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
          this.saveOrionLog(state.userId, this.symbol, 'info', `🏆 META DE LUCRO ATINGIDA!\n• Lucro Total: $${lucroAtual.toFixed(2)}\n• Ação: Parabéns! Encerrando operações por hoje.`);

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

        // ✅ STOP LOSS BLINDADO (Dynamic Trailing)
        if (config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          let profitPeak = parseFloat(config.profitPeak) || 0;

          // Auto-healing / Update Peak
          if (lucroAtual > profitPeak) {
            const profitPeakAnterior = profitPeak;
            profitPeak = lucroAtual;

            // ✅ Log quando profit peak aumenta após vitória
            if (profitPeak >= profitTarget * 0.40) {
              const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
              const protectedAmount = profitPeak * (stopBlindadoPercent / 100);
              const stopBlindado = capitalInicial + protectedAmount;

              this.logger.log(
                `[ORION][${mode}][${state.userId}] 🛡️💰 STOP BLINDADO ATUALIZADO | ` +
                `Pico: $${profitPeakAnterior.toFixed(2)} → $${profitPeak.toFixed(2)} | ` +
                `Protegido: $${protectedAmount.toFixed(2)} (${stopBlindadoPercent}%)`
              );
              this.saveOrionLog(
                state.userId,
                this.symbol,
                'info',
                `🛡️💰 STOP BLINDADO ATUALIZADO | Pico: $${profitPeak.toFixed(2)} | Protegido: $${protectedAmount.toFixed(2)}`
              );
            }

            // Update DB
            await this.dataSource.query(
              `UPDATE ai_user_config SET profit_peak = ? WHERE user_id = ?`,
              [profitPeak, state.userId]
            );
          }

          // Check Stop
          if (profitPeak >= profitTarget * 0.40) {
            const stopBlindadoPercent = parseFloat(config.stopBlindadoPercent) || 50.0;
            const fatorProtecao = stopBlindadoPercent / 100;
            const protectedAmount = profitPeak * fatorProtecao;
            const stopBlindado = capitalInicial + protectedAmount;

            if (capitalSessao <= stopBlindado) {
              const lucroProtegido = capitalSessao - capitalInicial;
              // ... Log and Stop ...
              this.logger.warn(`[ORION] 🛡️ STOP BLINDADO ATINGIDO APÓS OPERAÇÃO. Peak: ${profitPeak}, Protegido: ${protectedAmount}, Atual: ${lucroAtual}`);
              this.saveOrionLog(state.userId, this.symbol, 'alerta', `🛡️ STOP BLINDADO ATINGIDO! Saldo protegido: $${lucroProtegido.toFixed(2)}`);

              const deactivationReason = `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro`;

              // STOP
              await this.dataSource.query(
                `UPDATE ai_user_config 
                   SET is_active = 0, session_status = 'stopped_blindado', deactivation_reason = ?, deactivated_at = NOW()
                   WHERE user_id = ? AND is_active = 1`,
                [deactivationReason, state.userId],
              );
              this.velozUsers.delete(state.userId);
              this.moderadoUsers.delete(state.userId);
              this.precisoUsers.delete(state.userId);
              this.lentaUsers.delete(state.userId);

              return;
            }
          }
        }




        // ✅ Verificar STOP LOSS NORMAL (apenas se estiver em perda)
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(
            `[ORION][${mode}][${state.userId}] 🛑 STOP LOSS ATINGIDO APÓS OPERAÇÃO! Perda: $${perdaAtual.toFixed(2)} >= Limite: $${lossLimit.toFixed(2)} - DESATIVANDO SESSÃO`,
          );
          this.saveOrionLog(state.userId, this.symbol, 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)} | Limite: $${lossLimit.toFixed(2)} - IA DESATIVADA`);

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

        // ✅ Verificar STOP-LOSS BLINDADO conforme documentação ORION Master Blueprint
        // Regra: Ativa quando atinge 40% da meta, protege 50% do LUCRO MÁXIMO ATINGIDO (pico)
        const riskManager = this.riskManagers.get(state.userId);
        if (riskManager && lucroAtual > 0 && profitTarget > 0 && config.stopBlindadoPercent !== null && config.stopBlindadoPercent !== undefined) {
          // Usar o RiskManager para calcular corretamente (ele rastreia o pico máximo)
          const currentBalance = capitalSessao;
          const baseStake = state.apostaInicial || 0.35;
          const lastProfit = profit;

          // Verificar se o Stop Blindado está ativo (atingiu 40% da meta)
          // O RiskManager rastreia o pico máximo internamente
          const activationTrigger = profitTarget * 0.40; // 40% da meta

          // ✅ Log informativo do status do Stop Blindado
          const percentualAteAtivacao = (lucroAtual / activationTrigger) * 100;
          if (lucroAtual < activationTrigger) {
            // Ainda não ativou - mostrar progresso
            this.logger.log(
              `[ORION][${mode}][${state.userId}] 🛡️ Stop Blindado: Lucro atual $${lucroAtual.toFixed(2)} | ` +
              `Meta para ativar: $${activationTrigger.toFixed(2)} (40% de $${profitTarget.toFixed(2)}) | ` +
              `Progresso: ${percentualAteAtivacao.toFixed(1)}%`,
            );
            this.saveOrionLog(
              state.userId,
              this.symbol,
              'info',
              `🛡️ Stop Blindado: Lucro $${lucroAtual.toFixed(2)} | Meta ativação: $${activationTrigger.toFixed(2)} (${percentualAteAtivacao.toFixed(1)}%)`,
            );
          }

          // O RiskManager já tem a lógica correta: verifica 40% da meta e protege 50% do pico
          const adjustedStake = riskManager.calculateStake(
            currentBalance,
            baseStake,
            lastProfit,
            this.logger,
            state.vitoriasConsecutivas || 0,
            (t, m) => this.saveOrionLog(state.userId, this.symbol, t as any, m),
          );

          // Log informativo quando o Stop Blindado está ativo (apenas quando muda o pico)
          // O RiskManager já faz esse log internamente quando o pico muda

          // Se o RiskManager retornou 0, significa que o Stop Blindado foi atingido
          if (adjustedStake === 0) {
            // Obter informações do pico para o log
            const stopBlindadoConfig = await this.dataSource.query(
              `SELECT COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent
               FROM ai_user_config 
               WHERE user_id = ? AND is_active = 1
               LIMIT 1`,
              [state.userId],
            );

            const stopBlindadoPercent = stopBlindadoConfig && stopBlindadoConfig.length > 0
              ? parseFloat(stopBlindadoConfig[0].stopBlindadoPercent) || 50.0
              : 50.0;

            // Calcular valores para o log (usando o pico do RiskManager)
            // O RiskManager já calculou o minAllowedBalance baseado no pico
            const lucroProtegido = capitalSessao - capitalInicial;

            this.logger.warn(
              `[ORION][${mode}][${state.userId}] 🛡️ STOP-LOSS BLINDADO ATIVADO! ` +
              `Capital Sessão: $${capitalSessao.toFixed(2)} | ` +
              `Lucro protegido: $${lucroProtegido.toFixed(2)} (${stopBlindadoPercent}% do pico máximo)`,
            );

            this.saveOrionLog(
              state.userId,
              this.symbol,
              'alerta',
              `🛡️ STOP-LOSS BLINDADO ATIVADO! Capital Sessão: $${capitalSessao.toFixed(2)} | Lucro protegido: $${lucroProtegido.toFixed(2)} (${stopBlindadoPercent}% do pico máximo)`,
            );

            const deactivationReason =
              `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
              `(${stopBlindadoPercent}% do pico máximo conquistado)`;

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
              `Capital Sessão final: $${capitalSessao.toFixed(2)}`,
            );
            return;
          }
        }
      }
    } catch (error) {
      this.logger.error(`[ORION][${mode}][${state.userId}] Erro ao verificar limites após resultado:`, error);
      // Continuar mesmo se houver erro na verificação (fail-open)
    } finally {
      // ✅ LIBERAR LOCK APÓS ATUALIZAR TODO O ESTADO
      // Isso evita que check_signal seja chamado antes de consecutive_losses ser atualizado
      state.isOperationActive = false;
      this.logger.debug(`[ORION][${mode}] 🔓 LOCK LIBERADO. Pronto para próxima análise.`);
    }
  }

  /**
   * ✅ Extrai o último dígito de um valor (mesma lógica do ai.service.ts)
   * CORREÇÃO: Forçar 2 casas decimais para garantir que 930.60 seja tratado como dígito 0 (e não 6)
   */
  private extractLastDigit(value: number): number {
    const numeric = Math.abs(value);
    // ✅ Forçar 2 casas decimais (padrão para Volatility 100 1s Index e maioria dos sintéticos)
    // Isso evita que o JS remova zeros à direita (ex: 930.60 -> 930.6 -> dígito 6 incorreto)
    const normalized = numeric.toFixed(2);
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
        this.saveOrionLog(state.userId, this.symbol, 'erro', `⏱️ Timeout ao monitorar contrato ${contractId} após 15 segundos - Operação cancelada | Contrato não finalizou no tempo esperado`);

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
              this.saveOrionLog(state.userId, this.symbol, 'erro', `❌ Contrato ${contractId} foi ${contract.status} - Operação cancelada | Resposta Deriv: ${errorResponse}`);

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
                  this.saveOrionLog(state.userId, this.symbol, 'resultado', `✅ Recuperou perdas do martingale! Resetando aposta para: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)}`);
                  this.saveOrionLog(state.userId, this.symbol, 'resultado', `Próxima aposta: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)} (entrada inicial - aguardando próxima vitória para iniciar Soros)`);
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

                  // ✅ ZENIX v2.0: Se completou Soros nível 3 (4 vitórias consecutivas), reiniciar tudo
                  if (state.vitoriasConsecutivas === 4) {
                    this.logger.log(
                      `[ORION][${mode}][${state.userId}] 🎉 SOROS CICLO PERFEITO! 4 vitórias consecutivas (até nível 3). Reiniciando para entrada inicial.`,
                    );
                    this.saveOrionLog(state.userId, this.symbol, 'resultado', `🎉 SOROS CICLO PERFEITO! 4 vitórias consecutivas (até nível 3)`);
                    this.saveOrionLog(state.userId, this.symbol, 'resultado', `Reiniciando para entrada inicial: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)}`);

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
                        this.saveOrionLog(state.userId, this.symbol, 'resultado', `💰 SOROS Nível ${state.vitoriasConsecutivas} | Próxima aposta: $${proximaApostaSoros.toFixed(2)}`);
                      } else {
                        this.logger.warn(
                          `[ORION][${mode}][${state.userId}] ⚠️ calcularApostaComSoros retornou null | Vitórias: ${state.vitoriasConsecutivas} | Stake: $${stakeAmount.toFixed(2)} | Lucro: $${profit.toFixed(2)}`,
                        );
                      }
                    } else {
                      // Se não está mais no Soros, logar próxima aposta inicial
                      this.saveOrionLog(state.userId, this.symbol, 'resultado', `Próxima aposta: $${(state.apostaBase || state.apostaInicial || 0.35).toFixed(2)} (entrada inicial)`);
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
                    this.saveOrionLog(state.userId, this.symbol, 'resultado', `❌ Soros Nível ${state.vitoriasConsecutivas} falhou! Entrando em recuperação`);
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
              const logType = status === 'WON' ? 'resultado' : 'erro';
              this.saveOrionLog(state.userId, this.symbol, logType,
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
          this.saveOrionLog(state.userId, this.symbol, 'erro', `❌ Erro ao processar contrato ${contractId}: ${error.message || 'Erro desconhecido'} - Operação cancelada | Detalhes: ${errorResponse}`);

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
        this.saveOrionLog(state.userId, this.symbol, 'erro', `❌ Erro no WebSocket ao monitorar contrato ${contractId} - Operação cancelada | Detalhes: ${errorResponse}`);

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
    ticksColetados?: number;
    profitTarget?: number; // ✅ NOVO: Meta de lucro
    lossLimit?: number; // ✅ NOVO: Limite de perda
    stopLossBlindado?: boolean; // ✅ NOVO: Stop Blindado
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
        // ✅ Resetar consecutive_losses ao ativar usuário (nova sessão)
        consecutive_losses: 0,
        defesaAtivaLogged: false, // ✅ Resetar flag de log de defesa
        ticksColetados: 0, // ✅ Resetar contagem ao atualizar/ativar
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
        defesaAtivaLogged: false, // ✅ Flag para evitar log repetido de defesa ativa
        ticksColetados: 0, // ✅ Inicializar contagem
        currentPhase: 'ATAQUE', // ✅ Inicializar fase de ataque
        lastLowDigitsCount: 0, // ✅ Inicializar contagem de dígitos baixos
      });
      // ✅ Log de Configurações Iniciais (Novo Usuário) - USA VALORES REAIS
      this.logInitialConfigFixed(params.userId, 'VELOZ', params.modoMartingale || 'CONSERVADOR', params.profitTarget || 0, params.lossLimit || 0, !!params.stopLossBlindado);
    }
  }

  private upsertModeradoUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
    ticksColetados?: number;
    profitTarget?: number; // ✅ NOVO: Meta de lucro
    lossLimit?: number; // ✅ NOVO: Limite de perda
    stopLossBlindado?: boolean; // ✅ NOVO: Stop Blindado
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
        // ✅ Resetar consecutive_losses ao ativar usuário (nova sessão)
        consecutive_losses: 0,
        defesaAtivaLogged: false, // ✅ Resetar flag de log de defesa
        ticksColetados: 0,
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
        defesaAtivaLogged: false, // ✅ Flag para evitar log repetido de defesa ativa
        ticksDesdeUltimaOp: 999, // Cooldown
        ticksColetados: 0,
        currentPhase: 'ATAQUE',
        lastLowDigitsCount: 0,
      });
      // ✅ Log de Configurações Iniciais (Novo Usuário) - USA VALORES REAIS
      this.logInitialConfigFixed(params.userId, 'MODERADO', params.modoMartingale || 'CONSERVADOR', params.profitTarget || 50.00, params.lossLimit || 50.00, !!params.stopLossBlindado);
    }
  }

  private upsertPrecisoUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
    ticksColetados?: number;
    profitTarget?: number; // ✅ NOVO: Meta de lucro
    lossLimit?: number; // ✅ NOVO: Limite de perda
    stopLossBlindado?: boolean; // ✅ NOVO: Stop Blindado
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
        // ✅ Resetar consecutive_losses ao ativar usuário (nova sessão)
        consecutive_losses: 0,
        defesaAtivaLogged: false, // ✅ Resetar flag de log de defesa
        ticksDesdeUltimaOp: 999, // Cooldown
        ticksColetados: 0,
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
        defesaAtivaLogged: false, // ✅ Flag para evitar log repetido de defesa ativa
        ticksDesdeUltimaOp: 999, // Cooldown
        ticksColetados: 0,
        currentPhase: 'ATAQUE',
        lastLowDigitsCount: 0,
      });
      // ✅ Log de Configurações Iniciais (Novo Usuário) - USA VALORES REAIS
      this.logInitialConfigFixed(params.userId, 'PRECISO', params.modoMartingale || 'CONSERVADOR', params.profitTarget || 50.00, params.lossLimit || 50.00, !!params.stopLossBlindado);
    }
  }

  private upsertLentaUserState(params: {
    userId: string;
    stakeAmount: number; // Capital total da conta
    apostaInicial?: number; // Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
    ticksColetados?: number;
    profitTarget?: number; // ✅ NOVO: Meta de lucro
    lossLimit?: number; // ✅ NOVO: Limite de perda
    stopLossBlindado?: boolean; // ✅ NOVO: Stop Blindado
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
        // ✅ Resetar consecutive_losses ao ativar usuário (nova sessão)
        consecutive_losses: 0,
        defesaAtivaLogged: false, // ✅ Resetar flag de log de defesa
        ticksDesdeUltimaOp: 999, // Cooldown
        ticksColetados: 0,
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
        defesaAtivaLogged: false, // ✅ Flag para evitar log repetido de defesa ativa
        ticksDesdeUltimaOp: 999, // Cooldown
        ticksColetados: 0,
        currentPhase: 'ATAQUE',
        lastLowDigitsCount: 0,
      });
      // ✅ Log de Configurações Iniciais (Novo Usuário) - USA VALORES REAIS
      this.logInitialConfigFixed(params.userId, 'LENTA', params.modoMartingale || 'CONSERVADOR', params.profitTarget || 50.00, params.lossLimit || 50.00, !!params.stopLossBlindado);
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
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro' | 'config',
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

      // Salvar logs por usuário em paralelo (✅ OTIMIZADO: não bloqueia)
      await Promise.all(
        Array.from(logsByUser.entries()).map(([userId, logs]) =>
          this.saveOrionLogsBatch(userId, logs).catch(error => {
            this.logger.error(`[ORION][SaveLogsBatch][${userId}] Erro:`, error);
          })
        )
      );
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
        'info': '',
        'tick': '',
        'analise': '',
        'sinal': '',
        'operacao': '',
        'resultado': '',
        'alerta': '',
        'erro': '',
        'config': '',
      };

      const placeholders = logs.map(() => '(?, ?, ?, ?, ?, NOW())').join(', ');
      const flatValues: any[] = [];

      for (const log of logs) {
        const icon = icons[log.type] || '';
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

      // ✅ Emitir evento SSE para atualizar frontend em tempo real
      this.tradeEvents.emit({
        userId,
        type: 'updated',
        strategy: 'orion',
        status: 'LOG',
      });
    } catch (error) {
      this.logger.error(`[ORION][SaveLogsBatch][${userId}] Erro ao salvar logs:`, error);
    }
  }

  // ✅ [ZENIX v2.0] Log de Configuração Inicial (Fix DB Error)
  private logInitialConfigFixed(userId: string, mode: string, riskMode: string, profitTarget: number, stopLoss: number, blindado: boolean) {
    const blindadoStatus = blindado ? 'ATIVADO' : 'DESATIVADO';
    this.logger.log(`⚙️ CONFIGURAÇÕES INICIAIS`);
    this.logger.log(`• Estratégia: ORION`);
    this.logger.log(`• Modo de Negociação: ${mode}`);
    this.logger.log(`• Gerenciamento de Risco: ${riskMode.toUpperCase()}`);
    this.logger.log(`• Meta de Lucro: $${profitTarget.toFixed(2)}`);
    this.logger.log(`[ORION][${mode}] 📊 Stop Loss: $${stopLoss.toFixed(2)} | Stop Blindado: ${blindado ? 'ATIVADO' : 'DESATIVADO'} | Meta: $${profitTarget.toFixed(2)}`);

    // ✅ FIX: Usar type 'info' para evitar WARN_DATA_TRUNCATED no banco
    this.saveOrionLog(userId, this.symbol, 'info', `⚙️ CONFIGURAÇÕES INICIAIS\n• Estratégia: ORION\n• Modo de Negociação: ${mode}\n• Gerenciamento de Risco: ${riskMode.toUpperCase()}\n• Meta de Lucro: $${profitTarget.toFixed(2)}\n• Stop Loss Normal: $${stopLoss.toFixed(2)}\n• Stop Loss Blindado: ${blindado ? 'ATIVADO' : 'DESATIVADO'}`);
  }
}
