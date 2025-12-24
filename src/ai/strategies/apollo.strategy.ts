import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { Tick } from '../ai.service';
import { IStrategy, ModoMartingale } from './common.types';
import { TradeEventsService } from '../trade-events.service';

// Tipos específicos da Apollo v3
export type ApolloMode = 'veloz' | 'balanceado' | 'preciso';
export type ApolloContractLevel = 5 | 6 | 7 | 8; // Over 5, Over 6, Over 7, Over 8

// Estado do usuário Apollo
export interface ApolloUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  capitalInicial: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  isOperationActive: boolean;
  
  // Modo e configurações
  mode: ApolloMode;
  modoMartingale: ModoMartingale;
  
  // Martingale Inteligente
  martingaleStep: number; // 0 = Over 5, 1 = Over 6, 2 = Over 7, 3+ = Over 8
  contractLevel: ApolloContractLevel; // Nível atual do contrato (5, 6, 7, 8)
  perdaAcumulada: number;
  apostaInicial: number;
  ultimaApostaUsada: number;
  
  // Histórico de dígitos para detecção de padrões
  digitHistory: number[]; // Últimos dígitos coletados
  
  // Stop Loss e Proteções
  stopLoss?: number; // Limite de perda (negativo)
  profitTarget?: number; // Meta de lucro
  maxProfitReached?: number; // Maior lucro já alcançado (para trailing stop)
  trailingStopActive?: boolean; // Se trailing stop está ativo
  
  // Timestamps
  lastOperationTimestamp?: Date;
  creationCooldownUntil?: number;
}

// Payouts esperados para cada nível (aprox, será consultado na API)
const CONTRACT_PAYOUTS: Record<ApolloContractLevel, number> = {
  5: 0.92, // 92% (95% - 3%)
  6: 0.89, // ~89%
  7: 0.86, // ~86%
  8: 0.83, // ~83%
};

/**
 * ☀️ APOLLO v3: Calcula aposta baseada no martingale inteligente
 * Cada nível de martingale muda o contrato para um payout maior
 */
function calcularApostaApollo(
  perdasTotais: number,
  modo: ModoMartingale,
  contractLevel: ApolloContractLevel,
  ultimaAposta: number = 0,
): number {
  // Obter payout do nível atual (será consultado na API, mas usar estimativa por enquanto)
  const payoutEstimado = CONTRACT_PAYOUTS[contractLevel] || 0.92;
  
  let aposta = 0;
  
  switch (modo) {
    case 'conservador':
      // Só recupera o que perdeu (break-even)
      aposta = perdasTotais / payoutEstimado;
      break;
    case 'moderado':
      // Recupera tudo + 25% de lucro
      aposta = (perdasTotais * 1.25) / payoutEstimado;
      break;
    case 'agressivo':
      // Recupera tudo + 50% de lucro
      aposta = (perdasTotais * 1.50) / payoutEstimado;
      break;
  }
  
  return Math.round(aposta * 100) / 100; // 2 casas decimais
}

/**
 * ☀️ APOLLO v3: Determina o próximo nível de contrato baseado no martingale step
 */
function getContractLevelFromStep(martingaleStep: number): ApolloContractLevel {
  if (martingaleStep === 0) return 5; // Over 5 (payout ~92%)
  if (martingaleStep === 1) return 6; // Over 6 (payout ~89%)
  if (martingaleStep === 2) return 7; // Over 7 (payout ~86%)
  return 8; // Over 8 (payout ~83%)
}

/**
 * ☀️ APOLLO v3: Verifica se deve entrar baseado no modo
 * - Veloz: Entra sempre (força bruta)
 * - Balanceado: Aguarda 3 dígitos baixos seguidos (0,1,2,3)
 * - Preciso: Aguarda 5 dígitos baixos seguidos
 */
function deveEntrar(
  digitHistory: number[],
  mode: ApolloMode,
): boolean {
  const digitosBaixos = [0, 1, 2, 3]; // Dígitos que fazem perder (0,1,2,3)
  
  if (mode === 'veloz') {
    return true; // Força bruta: entra sempre
  }
  
  if (mode === 'balanceado') {
    // Precisa de pelo menos 3 dígitos baixos seguidos
    if (digitHistory.length < 3) return false;
    const ultimos3 = digitHistory.slice(-3);
    return ultimos3.every(d => digitosBaixos.includes(d));
  }
  
  if (mode === 'preciso') {
    // Precisa de pelo menos 5 dígitos baixos seguidos
    if (digitHistory.length < 5) return false;
    const ultimos5 = digitHistory.slice(-5);
    return ultimos5.every(d => digitosBaixos.includes(d));
  }
  
  return false;
}

@Injectable()
export class ApolloStrategy implements IStrategy {
  name = 'apollo';
  private readonly logger = new Logger(ApolloStrategy.name);
  
  private ticks: Tick[] = [];
  private apolloUsers = new Map<string, ApolloUserState>();
  
  // Pool de conexões WebSocket por token (reutilização)
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
  
  // Sistema de logs
  private logQueue: Array<{
    userId: string;
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;
  private appId: string;
  private symbol = 'R_100'; // Apollo opera em R_100 (Dígitos)

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async initialize(): Promise<void> {
    this.logger.log('[APOLLO] ☀️ Estratégia APOLLO v3 inicializada');
    this.startLogProcessor();
  }

  async processTick(tick: Tick, symbol?: string): Promise<void> {
    this.ticks.push(tick);
    // Limitar a 100 ticks para evitar consumo excessivo de memória
    if (this.ticks.length > 100) {
      this.ticks.shift();
    }

    // Processar usuários Apollo
    await this.processApolloStrategies(tick);
  }

  async activateUser(userId: string, config: any): Promise<void> {
    const { mode, stakeAmount, derivToken, currency, modoMartingale, entryValue, stopLoss, profitTarget } = config;
    let modeLower = (mode || 'balanceado').toLowerCase();
    
    // Mapear modos do frontend para modos da Apollo
    const modeMap: Record<string, ApolloMode> = {
      'veloz': 'veloz',
      'moderado': 'balanceado', // Frontend usa 'moderado', Apollo usa 'balanceado'
      'lento': 'preciso', // Frontend usa 'lento', Apollo usa 'preciso'
      'balanceado': 'balanceado',
      'preciso': 'preciso',
    };
    
    const apolloMode = modeMap[modeLower] || 'balanceado';
    
    const apostaInicial = entryValue || 0.35;
    const capitalInicial = stakeAmount || 0;

    this.upsertApolloUserState({
      userId,
      stakeAmount: capitalInicial,
      apostaInicial,
      derivToken,
      currency,
      modoMartingale: modoMartingale || 'conservador',
      mode: apolloMode,
      stopLoss: stopLoss ? -Math.abs(stopLoss) : undefined,
      profitTarget,
    });
    
    this.saveApolloLog(userId, 'info', 
      `☀️ Usuário ATIVADO | Modo: ${apolloMode} | Capital: $${capitalInicial.toFixed(2)} | Martingale: ${modoMartingale || 'conservador'}`);
  }

  async deactivateUser(userId: string): Promise<void> {
    this.apolloUsers.delete(userId);
    this.saveApolloLog(userId, 'info', '☀️ Usuário DESATIVADO');
  }

  getUserState(userId: string): any {
    return this.apolloUsers.get(userId) || null;
  }

  /**
   * ☀️ APOLLO: Processa estratégias para todos os usuários ativos
   */
  private async processApolloStrategies(latestTick: Tick): Promise<void> {
    if (this.apolloUsers.size === 0) return;

    const userPromises = Array.from(this.apolloUsers.entries()).map(async ([userId, state]) => {
      try {
        // Atualizar histórico de dígitos
        state.digitHistory.push(latestTick.digit);
        if (state.digitHistory.length > 20) {
          state.digitHistory.shift();
        }

        // Verificar se deve entrar
        if (state.isOperationActive) {
          return; // Já tem operação ativa
        }

        if (!deveEntrar(state.digitHistory, state.mode)) {
          return; // Condições não atendidas
        }

        // Executar operação
        await this.executeApolloOperation(state);
      } catch (error) {
        this.logger.error(`[APOLLO][${userId}] Erro ao processar:`, error);
      }
    });

    await Promise.all(userPromises);
  }

  /**
   * ☀️ APOLLO: Executa operação
   */
  private async executeApolloOperation(state: ApolloUserState): Promise<void> {
    let tradeId: number | null = null;

    if (state.isOperationActive) {
      this.logger.warn(`[APOLLO] Usuário ${state.userId} já possui operação ativa`);
      return;
    }

    // Verificar Stop Loss antes de operar
    try {
      const stopLossConfig = await this.dataSource.query(
        `SELECT 
          COALESCE(loss_limit, 0) as lossLimit,
          COALESCE(profit_target, 0) as profitTarget,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stake_amount, 0) as capitalInicial,
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
        const capitalInicialBD = parseFloat(config.capitalInicial) || state.capitalInicial;
        const capitalInicial = state.capitalInicial || capitalInicialBD;
        
        const capitalAtual = state.capital || capitalInicial;
        const lucroAtual = capitalAtual - capitalInicial;
        const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
        
        // Verificar STOP WIN
        if (profitTarget > 0 && lucroAtual >= profitTarget) {
          this.logger.log(`[APOLLO][${state.userId}] 🎯 META ATINGIDA! Lucro: $${lucroAtual.toFixed(2)}`);
          this.saveApolloLog(state.userId, 'info', `🎯 META DE LUCRO ATINGIDA! Lucro: $${lucroAtual.toFixed(2)}`);
          await this.deactivateApolloUser(state.userId);
          return;
        }
        
        // Verificar STOP LOSS NORMAL
        if (lossLimit > 0 && perdaAtual >= lossLimit) {
          this.logger.warn(`[APOLLO][${state.userId}] 🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)}`);
          this.saveApolloLog(state.userId, 'alerta', `🛑 STOP LOSS ATINGIDO! Perda: $${perdaAtual.toFixed(2)}`);
          await this.deactivateApolloUser(state.userId);
          return;
        }

        // Verificar TRAILING STOP
        if (state.trailingStopActive && state.maxProfitReached) {
          const lucroProtegido = state.maxProfitReached * 0.5; // Protege 50% do lucro máximo
          if (lucroAtual < lucroProtegido) {
            this.logger.warn(`[APOLLO][${state.userId}] 🛡️ TRAILING STOP ATIVADO! Lucro caiu abaixo de 50%`);
            this.saveApolloLog(state.userId, 'alerta', `🛡️ TRAILING STOP: Lucro protegido $${lucroProtegido.toFixed(2)}`);
            await this.deactivateApolloUser(state.userId);
            return;
          }
        }

        // Verificar STOP LOSS RÍGIDO (antes do martingale) será feito depois de calcular stake
      }
    } catch (error) {
      this.logger.error(`[APOLLO][${state.userId}] Erro ao verificar limites:`, error);
    }

    state.isOperationActive = true;
    state.lastOperationTimestamp = new Date();

    // Determinar nível do contrato baseado no martingale step
    const contractLevel = getContractLevelFromStep(state.martingaleStep);
    state.contractLevel = contractLevel;

    // Calcular stake
    let stakeAmount: number;
    if (state.martingaleStep === 0) {
      stakeAmount = state.apostaInicial;
    } else {
      stakeAmount = calcularApostaApollo(
        state.perdaAcumulada,
        state.modoMartingale,
        contractLevel,
        state.ultimaApostaUsada,
      );
      // Garantir valor mínimo
      if (stakeAmount < 0.35) {
        stakeAmount = 0.35;
      }
    }

    // 🛬 POUSO SUAVE: Ajustar aposta se ultrapassaria stop loss
    try {
      const stopLossConfig = await this.dataSource.query(
        `SELECT COALESCE(loss_limit, 0) as lossLimit, COALESCE(stake_amount, 0) as capitalInicial
         FROM ai_user_config WHERE user_id = ? AND is_active = 1 LIMIT 1`,
        [state.userId],
      );
      
      if (stopLossConfig && stopLossConfig.length > 0 && state.martingaleStep > 0) {
        const lossLimit = parseFloat(stopLossConfig[0].lossLimit) || 0;
        const capitalInicial = parseFloat(stopLossConfig[0].capitalInicial) || state.capitalInicial;
        
        if (lossLimit > 0) {
          const capitalAtual = state.capital || capitalInicial;
          const lucroAtual = capitalAtual - capitalInicial;
          const perdaAtual = lucroAtual < 0 ? Math.abs(lucroAtual) : 0;
          const perdaTotalPotencial = perdaAtual + stakeAmount;
          
          if (perdaTotalPotencial > lossLimit) {
            // 🛬 POUSO SUAVE: Ajustar aposta para caber no stop loss
            const perdaPermitida = lossLimit - perdaAtual;
            if (perdaPermitida > 0.35) { // Mínimo da Deriv
              stakeAmount = perdaPermitida * 0.95; // Margem de segurança
              this.logger.log(`[APOLLO][${state.userId}] 🛬 POUSO SUAVE: Aposta ajustada para $${stakeAmount.toFixed(2)} (limite: $${lossLimit.toFixed(2)})`);
              this.saveApolloLog(state.userId, 'alerta', `🛬 POUSO SUAVE: Aposta ajustada para $${stakeAmount.toFixed(2)} (limite: $${lossLimit.toFixed(2)})`);
            } else {
              // Não pode mais apostar
              this.logger.warn(`[APOLLO][${state.userId}] 🛑 STOP LOSS RÍGIDO: Não pode mais apostar (perda permitida: $${perdaPermitida.toFixed(2)} < mínimo $0.35)`);
              this.saveApolloLog(state.userId, 'alerta', `🛑 STOP LOSS RÍGIDO: Limite atingido`);
              state.isOperationActive = false;
              await this.deactivateApolloUser(state.userId);
              return;
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`[APOLLO][${state.userId}] Erro ao verificar pouso suave:`, error);
    }

    // Validar saldo
    if (state.capital < stakeAmount * 1.1) {
      this.logger.warn(`[APOLLO][${state.userId}] ❌ Saldo insuficiente`);
      state.isOperationActive = false;
      return;
    }

    const currentPrice = this.ticks.length > 0 ? this.ticks[this.ticks.length - 1].value : 0;

    // Logs
    this.saveApolloLog(state.userId, 'operacao', `🎯 EXECUTANDO OPERAÇÃO | Over ${contractLevel}`);
    this.saveApolloLog(state.userId, 'operacao', `Valor: $${stakeAmount.toFixed(2)} | Payout: ~${(CONTRACT_PAYOUTS[contractLevel] * 100).toFixed(0)}%`);
    if (state.martingaleStep > 0) {
      this.saveApolloLog(state.userId, 'operacao', `🔄 MARTINGALE M${state.martingaleStep} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`);
    }

    try {
      // Criar registro de trade
      tradeId = await this.createApolloTradeRecord(
        state.userId,
        contractLevel,
        stakeAmount,
        currentPrice,
        state.mode,
      );

      // Executar trade
      const result = await this.executeApolloTradeViaWebSocket(
        state.derivToken,
        {
          contract_type: 'DIGITOVER',
          barrier: contractLevel,
          amount: stakeAmount,
          currency: state.currency || 'USD',
        },
        state.userId,
      );

      if (!result) {
        throw new Error('Trade falhou');
      }

      // Processar resultado
      const digitoResultado = this.extractLastDigit(result.exitSpot);
      const isWin = digitoResultado > contractLevel; // Ganha se dígito > nível do contrato
      const profit = isWin ? result.profit : -stakeAmount;

      await this.processApolloResult(state, isWin, stakeAmount, profit, result.exitSpot, tradeId, contractLevel);

    } catch (error: any) {
      this.logger.error(`[APOLLO][${state.userId}] Erro ao executar operação:`, error);
      state.isOperationActive = false;
      state.creationCooldownUntil = Date.now() + 5000;
      
      if (tradeId) {
        await this.dataSource.query(
          `UPDATE ai_trades SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [error.message || 'Erro ao executar operação', tradeId],
        ).catch(err => {
          this.logger.error(`[APOLLO] Erro ao atualizar trade:`, err);
        });
      }
      
      this.saveApolloLog(state.userId, 'erro', `Erro ao executar operação: ${error.message}`);
    }
  }

  /**
   * ☀️ APOLLO: Processa resultado do trade
   */
  private async processApolloResult(
    state: ApolloUserState,
    isWin: boolean,
    stakeAmount: number,
    profit: number,
    exitPrice: number,
    tradeId: number | null,
    contractLevel: ApolloContractLevel,
  ): Promise<void> {
    state.isOperationActive = false;
    state.ultimaApostaUsada = stakeAmount;

    const capitalAntes = state.capital;
    state.capital += profit;
    const capitalDepois = state.capital;

    const digitoResultado = this.extractLastDigit(exitPrice);
    const roi = state.capitalInicial > 0 ? ((profit / capitalAntes) * 100).toFixed(2) : '0.00';

    if (isWin) {
      // VITÓRIA
      this.logger.log(`[APOLLO][${state.userId}] ✅ VITÓRIA! Dígito: ${digitoResultado} > ${contractLevel} | Lucro: $${profit.toFixed(2)}`);
      
      this.saveApolloLog(state.userId, 'resultado', 
        `✅ VITÓRIA! Operação #${state.martingaleStep + 1}
  └─ Dígito resultado: ${digitoResultado} ✅ (Over ${contractLevel})
  └─ Aposta: $${stakeAmount.toFixed(2)}
  └─ Lucro: +$${profit.toFixed(2)}
  └─ Capital depois: $${capitalDepois.toFixed(2)}
  └─ ROI: +${roi}%`);

      // Resetar martingale
      state.martingaleStep = 0;
      state.contractLevel = 5;
      state.perdaAcumulada = 0;

      // Atualizar trailing stop
      const lucroAtual = state.capital - state.capitalInicial;
      if (!state.maxProfitReached || lucroAtual > state.maxProfitReached) {
        state.maxProfitReached = lucroAtual;
        // Ativar trailing stop se atingiu 50% da meta
        if (state.profitTarget && lucroAtual >= state.profitTarget * 0.5) {
          state.trailingStopActive = true;
          this.saveApolloLog(state.userId, 'info', `🛡️ TRAILING STOP ATIVADO (lucro máximo: $${lucroAtual.toFixed(2)})`);
        }
      }

    } else {
      // DERROTA
      this.logger.log(`[APOLLO][${state.userId}] ❌ DERROTA! Dígito: ${digitoResultado} ≤ ${contractLevel} | Perda: $${Math.abs(profit).toFixed(2)}`);
      
      this.saveApolloLog(state.userId, 'resultado', 
        `❌ DERROTA! Operação #${state.martingaleStep + 1}
  └─ Dígito resultado: ${digitoResultado} ❌ (Over ${contractLevel})
  └─ Aposta: $${stakeAmount.toFixed(2)}
  └─ Perda: -$${Math.abs(profit).toFixed(2)}
  └─ Capital depois: $${capitalDepois.toFixed(2)}
  └─ ROI: -${roi}%`);

      // Atualizar martingale
      state.perdaAcumulada += stakeAmount;
      state.martingaleStep += 1;
      state.contractLevel = getContractLevelFromStep(state.martingaleStep);
      
      // Limite de martingale (Over 8 é o máximo)
      if (state.martingaleStep >= 4) {
        this.logger.warn(`[APOLLO][${state.userId}] ⚠️ Limite de martingale atingido (Over 8)`);
        this.saveApolloLog(state.userId, 'alerta', `⚠️ Limite de martingale atingido. Resetando...`);
        // Resetar após limite
        state.martingaleStep = 0;
        state.contractLevel = 5;
        state.perdaAcumulada = 0;
      }
    }

    // Atualizar trade no banco
    if (tradeId) {
      await this.dataSource.query(
        `UPDATE ai_trades SET status = ?, profit_loss = ?, exit_price = ? WHERE id = ?`,
        [isWin ? 'WON' : 'LOST', profit, exitPrice, tradeId],
      ).catch(err => {
        this.logger.error(`[APOLLO] Erro ao atualizar trade:`, err);
      });
    }

    // Cooldown
    state.creationCooldownUntil = Date.now() + 2000;
  }

  /**
   * ☀️ APOLLO: Executa trade via WebSocket
   */
  private async executeApolloTradeViaWebSocket(
    token: string,
    contractParams: {
      contract_type: 'DIGITOVER';
      barrier: ApolloContractLevel;
      amount: number;
      currency: string;
    },
    userId?: string,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    try {
      const connection = await this.getOrCreateWebSocketConnection(token, userId);

      // Solicitar proposta
      const proposalResponse: any = await connection.sendRequest({
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: this.symbol,
        barrier: contractParams.barrier,
      }, 60000);

      const errorObj = proposalResponse.error || proposalResponse.proposal?.error;
      if (errorObj) {
        this.logger.error(`[APOLLO] ❌ Erro na proposta: ${JSON.stringify(errorObj)}`);
        if (userId) {
          this.saveApolloLog(userId, 'erro', `❌ Erro na proposta: ${errorObj.message || JSON.stringify(errorObj)}`);
        }
        return null;
      }

      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);
      if (!proposalId || !proposalPrice || isNaN(proposalPrice)) {
        this.logger.error(`[APOLLO] ❌ Proposta inválida`);
        return null;
      }

      // Comprar contrato
      const buyResponse: any = await connection.sendRequest({
        buy: proposalId,
        price: proposalPrice,
      }, 60000);

      const buyErrorObj = buyResponse.error || buyResponse.buy?.error;
      if (buyErrorObj) {
        this.logger.error(`[APOLLO] ❌ Erro ao comprar: ${JSON.stringify(buyErrorObj)}`);
        if (userId) {
          this.saveApolloLog(userId, 'erro', `❌ Erro ao comprar: ${buyErrorObj.message || JSON.stringify(buyErrorObj)}`);
        }
        return null;
      }

      const contractId = buyResponse.buy?.contract_id;
      if (!contractId) {
        this.logger.error(`[APOLLO] ❌ Sem contract_id`);
        return null;
      }

      // Monitorar contrato
      return await new Promise((resolve) => {
        let hasResolved = false;
        const contractMonitorTimeout = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            this.logger.warn(`[APOLLO] ⏱️ Timeout ao monitorar contrato ${contractId}`);
            connection.removeSubscription(contractId);
            resolve(null);
          }
        }, 90000);

        connection.subscribe(
          { proposal_open_contract: 1, contract_id: contractId },
          (msg: any) => {
            const contract = msg.proposal_open_contract;
            if (!contract) return;

            if (contract.is_sold || contract.status === 'sold') {
              if (!hasResolved) {
                hasResolved = true;
                clearTimeout(contractMonitorTimeout);
                connection.removeSubscription(contractId);

                const profit = Number(contract.profit || 0);
                const exitSpot = contract.exit_tick || contract.current_spot || 0;

                resolve({
                  contractId,
                  profit,
                  exitSpot,
                });
              }
            }
          },
          contractId,
          90000,
        );
      });
    } catch (error: any) {
      this.logger.error(`[APOLLO] Erro ao executar trade:`, error);
      return null;
    }
  }

  /**
   * ☀️ APOLLO: Cria registro de trade no banco
   */
  private async createApolloTradeRecord(
    userId: string,
    contractLevel: ApolloContractLevel,
    stakeAmount: number,
    entryPrice: number,
    mode: ApolloMode,
  ): Promise<number> {
    const analysisData = {
      strategy: 'apollo',
      mode,
      contractLevel,
      timestamp: new Date().toISOString(),
    };

    const insertResult: any = await this.dataSource.query(
      `INSERT INTO ai_trades 
       (user_id, gemini_signal, entry_price, stake_amount, status, 
        gemini_duration, contract_type, created_at, analysis_data, symbol)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [
        userId,
        `OVER_${contractLevel}`,
        entryPrice,
        stakeAmount,
        'PENDING',
        1,
        'DIGITOVER',
        JSON.stringify(analysisData),
        this.symbol,
      ],
    );

    const result = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    const tradeId = result?.insertId || null;

    if (tradeId) {
      this.tradeEvents.emit({
        userId,
        type: 'created',
        tradeId,
        status: 'PENDING',
        strategy: 'apollo',
        symbol: this.symbol as any,
        contractType: 'DIGITOVER',
      });
    }

    return tradeId;
  }

  /**
   * ☀️ APOLLO: Desativa usuário
   */
  private async deactivateApolloUser(userId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_user_config SET is_active = 0, session_status = 'stopped', deactivated_at = NOW()
       WHERE user_id = ? AND is_active = 1`,
      [userId],
    );
    
    this.apolloUsers.delete(userId);
  }

  /**
   * ☀️ APOLLO: Upsert estado do usuário
   */
  private upsertApolloUserState(config: {
    userId: string;
    stakeAmount: number;
    apostaInicial: number;
    derivToken: string;
    currency: string;
    modoMartingale: ModoMartingale;
    mode: ApolloMode;
    stopLoss?: number;
    profitTarget?: number;
  }): void {
    const existing = this.apolloUsers.get(config.userId);
    
    if (existing) {
      // Atualizar campos
      existing.derivToken = config.derivToken;
      existing.currency = config.currency;
      existing.modoMartingale = config.modoMartingale;
      existing.mode = config.mode;
      existing.stopLoss = config.stopLoss;
      existing.profitTarget = config.profitTarget;
      if (existing.capital === existing.capitalInicial) {
        existing.capital = config.stakeAmount;
        existing.capitalInicial = config.stakeAmount;
      }
    } else {
      // Criar novo
      this.apolloUsers.set(config.userId, {
        userId: config.userId,
        derivToken: config.derivToken,
        currency: config.currency || 'USD',
        capital: config.stakeAmount,
        capitalInicial: config.stakeAmount,
        virtualCapital: config.stakeAmount,
        lossVirtualActive: false,
        lossVirtualCount: 0,
        isOperationActive: false,
        mode: config.mode,
        modoMartingale: config.modoMartingale,
        martingaleStep: 0,
        contractLevel: 5,
        perdaAcumulada: 0,
        apostaInicial: config.apostaInicial,
        ultimaApostaUsada: 0,
        digitHistory: [],
        stopLoss: config.stopLoss,
        profitTarget: config.profitTarget,
        maxProfitReached: 0,
        trailingStopActive: false,
      });
    }
  }

  /**
   * ☀️ APOLLO: Extrai último dígito de um preço
   */
  private extractLastDigit(price: number): number {
    const priceStr = price.toFixed(5);
    const lastChar = priceStr[priceStr.length - 1];
    return parseInt(lastChar, 10);
  }

  /**
   * ☀️ APOLLO: Sistema de logs
   */
  private saveApolloLog(userId: string, type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro', message: string, details?: any): void {
    this.logQueue.push({ userId, type, message, details });
  }

  private async startLogProcessor(): Promise<void> {
    if (this.logProcessing) return;
    this.logProcessing = true;

    setInterval(async () => {
      if (this.logQueue.length === 0) return;

      const logs = this.logQueue.splice(0, 50); // Processar até 50 logs por vez

      for (const log of logs) {
        try {
          await this.dataSource.query(
            `INSERT INTO ai_logs (user_id, strategy, log_type, message, details, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [log.userId, 'apollo', log.type, log.message, log.details ? JSON.stringify(log.details) : null],
          );
        } catch (error) {
          this.logger.error(`[APOLLO] Erro ao salvar log:`, error);
        }
      }
    }, 1000); // Processar logs a cada 1 segundo
  }

  /**
   * ☀️ APOLLO: Gerenciamento de WebSocket (similar à Orion)
   */
  private async getOrCreateWebSocketConnection(token: string, userId?: string): Promise<{
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

    // Criar nova conexão (código simplificado, implementar completo como na Orion)
    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { Origin: 'https://app.deriv.com' },
      });

      let authResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (!authResolved) {
          socket.close();
          this.wsConnections.delete(token);
          reject(new Error('Timeout ao conectar WebSocket'));
        }
      }, 20000);

      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.msg_type === 'ping' || msg.msg_type === 'pong' || msg.ping || msg.pong) {
            return;
          }

          const conn = this.wsConnections.get(token);
          if (!conn) return;

          if (msg.msg_type === 'authorize' && !authResolved) {
            authResolved = true;
            clearTimeout(connectionTimeout);
            
            if (msg.error || (msg.authorize && msg.authorize.error)) {
              socket.close();
              this.wsConnections.delete(token);
              reject(new Error(`Erro na autorização: ${msg.error?.message || msg.authorize?.error?.message}`));
              return;
            }
            
            conn.authorized = true;
            conn.keepAliveInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send(JSON.stringify({ ping: 1 }));
                } catch (error) {
                  // Ignorar erros
                }
              }
            }, 90000);
            
            resolve(socket);
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
          }
        } catch (error) {
          // Continuar processando
        }
      });

      socket.on('open', () => {
        const conn = {
          ws: socket,
          authorized: false,
          keepAliveInterval: null,
          requestIdCounter: 0,
          pendingRequests: new Map(),
          subscriptions: new Map(),
        };
        this.wsConnections.set(token, conn);
        
        const authPayload = { authorize: token };
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
        const conn = this.wsConnections.get(token);
        if (conn) {
          if (conn.keepAliveInterval) {
            clearInterval(conn.keepAliveInterval);
          }
          conn.pendingRequests.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.reject(new Error('WebSocket fechado'));
          });
          conn.subscriptions.clear();
        }
        this.wsConnections.delete(token);
      });
    });

    return {
      ws,
      sendRequest: (payload: any, timeoutMs = 60000) => this.sendRequestViaConnection(token, payload, timeoutMs),
      subscribe: (payload: any, callback: (msg: any) => void, subId: string, timeoutMs = 90000) => 
        this.subscribeViaConnection(token, payload, callback, subId, timeoutMs),
      removeSubscription: (subId: string) => this.removeSubscriptionFromConnection(token, subId),
    };
  }

  private async sendRequestViaConnection(token: string, payload: any, timeoutMs: number): Promise<any> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível');
    }

    return new Promise((resolve, reject) => {
      const requestId = `req_${++conn.requestIdCounter}_${Date.now()}`;
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`Timeout na requisição após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });
      conn.ws.send(JSON.stringify(payload));
    });
  }

  private async subscribeViaConnection(
    token: string,
    payload: any,
    callback: (msg: any) => void,
    subId: string,
    timeoutMs: number,
  ): Promise<void> {
    const conn = this.wsConnections.get(token);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authorized) {
      throw new Error('Conexão WebSocket não está disponível');
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.subscriptions.delete(subId);
        reject(new Error(`Timeout ao inscrever ${subId}`));
      }, timeoutMs);

      const wrappedCallback = (msg: any) => {
        if (msg.proposal_open_contract || msg.error) {
          clearTimeout(timeout);
          if (msg.error) {
            conn.subscriptions.delete(subId);
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
          conn.subscriptions.set(subId, callback);
          resolve();
          callback(msg);
          return;
        }
        callback(msg);
      };
      
      conn.subscriptions.set(subId, wrappedCallback);
      conn.ws.send(JSON.stringify(payload));
    });
  }

  private removeSubscriptionFromConnection(token: string, subId: string): void {
    const conn = this.wsConnections.get(token);
    if (conn) {
      conn.subscriptions.delete(subId);
    }
  }
}

