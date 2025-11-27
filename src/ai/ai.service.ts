import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import WebSocket from 'ws';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { StatsIAsService } from './stats-ias.service';
import { CopyTradingService } from '../copy-trading/copy-trading.service';

export type DigitParity = 'PAR' | 'IMPAR';

export interface Tick {
  value: number;
  epoch: number;
  timestamp: string;
  digit: number;
  parity: DigitParity;
}

interface VelozUserState {
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
}

interface ModeradoUserState {
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
}

interface PrecisoUserState {
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
}

interface DigitTradeResult {
  profitLoss: number;
  status: 'WON' | 'LOST';
  exitPrice: number;
  contractId: string;
}

const VELOZ_CONFIG = {
  window: 3,
  dvxMax: 70,
  lossVirtualTarget: 2,
  betPercent: 0.005, // 0.5% do capital
  martingaleMax: 2,
  martingaleMultiplier: 2.5,
};

const FAST_MODE_CONFIG = {
  window: 3, // Janela de análise de 3 ticks
  dvxMax: 70, // DVX máximo permitido
  lossVirtualTarget: 2, // Número de perdas virtuais necessárias
  betPercent: 0.01, // 1% do capital por operação
  martingaleMax: 2, // Máximo de martingales
  martingaleMultiplier: 2.5, // Multiplicador do martingale
  minTicks: 100, // Mínimo de ticks para análise
  minStake: 0.35, // Valor mínimo de stake permitido pela Deriv
};

const MODERADO_CONFIG = {
  window: 5, // Janela de análise de 5 ticks
  dvxMax: 60, // DVX máximo permitido (mais restritivo)
  lossVirtualTarget: 3, // 3 perdas virtuais necessárias
  betPercent: 0.0075, // 0.75% do capital por operação
  martingaleMax: 3, // Máximo de 3 entradas (martingale)
  martingaleMultiplier: 2.5, // Multiplicador do martingale
  minTicks: 100, // Mínimo de ticks para análise
  minStake: 0.35, // Valor mínimo de stake permitido pela Deriv
  desequilibrioPercent: 0.80, // 80% para detectar desequilíbrio (4+ de 5)
  trendWindow: 20, // Janela para análise de tendência
  trendPercent: 0.60, // 60% para confirmar tendência (12+ de 20)
  anomalyWindow: 10, // Janela para detecção de anomalias
  anomalyAlternationMin: 6, // Mínimo de alternâncias para detectar anomalia
  anomalyRepetitionMin: 6, // Mínimo de repetições para detectar anomalia
  anomalyHomogeneityMin: 8, // Mínimo de homogeneidade para detectar anomalia
};

const PRECISO_CONFIG = {
  window: 7, // Janela de análise de 7 ticks
  dvxMax: 50, // DVX máximo permitido (MAIS rigoroso)
  lossVirtualTarget: 4, // 4 perdas virtuais necessárias
  betPercent: 0.01, // 1.0% do capital por operação
  martingaleMax: 4, // Máximo de 4 entradas (martingale)
  martingaleMultiplier: 2.5, // Multiplicador do martingale
  minTicks: 100, // Mínimo de ticks para análise
  minStake: 0.35, // Valor mínimo de stake permitido pela Deriv
  desequilibrioPercent: 0.857, // 85%+ para detectar desequilíbrio (6+ de 7)
  trendWindow: 20, // Janela para análise de tendência
  trendPercent: 0.60, // 60% para confirmar tendência (12+ de 20)
  anomalyWindow: 10, // Janela para detecção de anomalias
  anomalyAlternationMin: 6, // Mínimo de alternâncias para detectar anomalia
  anomalyRepetitionMin: 6, // Mínimo de repetições para detectar anomalia
  anomalyHomogeneityMin: 8, // Mínimo de homogeneidade para detectar anomalia
};

// ============================================
// SISTEMA UNIFICADO DE MARTINGALE
// ============================================
type ModoMartingale = 'conservador' | 'moderado' | 'agressivo';

interface ConfigMartingale {
  maxEntradas: number;
  multiplicadorLucro: number; // 0 = break-even, 0.5 = 50%, 1.0 = 100%
}

const CONFIGS_MARTINGALE: Record<ModoMartingale, ConfigMartingale> = {
  conservador: {
    maxEntradas: 2,
    multiplicadorLucro: 0, // Break-even (apenas recupera capital)
  },
  moderado: {
    maxEntradas: 3,
    multiplicadorLucro: 0.5, // 50% da aposta inicial
  },
  agressivo: {
    maxEntradas: 4,
    multiplicadorLucro: 1.0, // 100% da aposta inicial
  },
};

const PAYOUT_DERIV = 0.98; // Payout padrão da Deriv (98%)

/**
 * Calcula a próxima aposta baseado no modo de martingale
 * 
 * CONSERVADOR: Próxima Aposta = Perda Acumulada / 0.98
 * MODERADO: Próxima Aposta = (Perda Acumulada + 0.5 × Aposta Inicial) / 0.98
 * AGRESSIVO: Próxima Aposta = (Perda Acumulada + 1.0 × Aposta Inicial) / 0.98
 */
function calcularProximaAposta(
  perdaAcumulada: number,
  apostaInicial: number,
  modo: ModoMartingale,
): number {
  const config = CONFIGS_MARTINGALE[modo];
  const lucroDesejado = apostaInicial * config.multiplicadorLucro;
  const aposta = (perdaAcumulada + lucroDesejado) / PAYOUT_DERIV;
  
  return Math.round(aposta * 100) / 100; // 2 casas decimais
}

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private ws: WebSocket.WebSocket | null = null;
  private ticks: Tick[] = [];
  private maxTicks = 2000; // Armazena os últimos 2000 preços para gráficos maiores
  private appId: string;
  private symbol = 'R_10';
  private isConnected = false;
  private subscriptionId: string | null = null;
  private velozUsers = new Map<string, VelozUserState>();
  private moderadoUsers = new Map<string, ModeradoUserState>();
  private precisoUsers = new Map<string, PrecisoUserState>();

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private readonly statsIAsService: StatsIAsService,
    @Inject(forwardRef(() => CopyTradingService))
    private readonly copyTradingService?: CopyTradingService,
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async onModuleInit() {
    this.logger.log('🚀 Inicializando AiService...');
    try {
      await this.initializeTables();
      this.logger.log('✅ Tabelas da IA inicializadas com sucesso');
    } catch (error) {
      this.logger.error('❌ Erro ao inicializar tabelas da IA:', error.message);
    }
  }

  async initialize() {
    if (this.isConnected) {
      this.logger.log('Já está conectado ao Deriv API');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.logger.log('Inicializando conexão com Deriv API...');

      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.ws = new WebSocket.WebSocket(endpoint);

      this.ws.on('open', () => {
        this.logger.log('✅ Conexão WebSocket estabelecida');
        this.isConnected = true;
        this.subscribeToTicks();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error('Erro no WebSocket:', error.message);
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.log('Conexão WebSocket fechada');
        this.isConnected = false;
        this.ws = null;
      });

      // Timeout de 10 segundos
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Timeout ao conectar com Deriv API'));
        }
      }, 10000);
    });
  }

  private subscribeToTicks() {
    this.logger.log(`Inscrevendo-se nos ticks de ${this.symbol}...`);
    this.send({
      ticks_history: this.symbol,
      adjust_start_time: 1,
      count: this.maxTicks,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    });
  }

  private handleMessage(msg: any) {
    if (msg.error) {
      this.logger.error('Erro da API:', msg.error.message);
      return;
    }

    switch (msg.msg_type) {
      case 'history':
        this.processHistory(msg.history, msg.subscription?.id);
        break;

      case 'tick':
        this.processTick(msg.tick);
        break;
    }
  }

  private processHistory(history: any, subscriptionId?: string) {
    if (!history || !history.prices) {
      return;
    }

    if (subscriptionId) {
      this.subscriptionId = subscriptionId;
    }

    this.logger.log('Histórico recebido');

    this.ticks = history.prices.map((price: string, index: number) => {
      const value = parseFloat(price);
      const digit = this.extractLastDigit(value);
      const parity = this.getParityFromDigit(digit);

      return {
        value,
      epoch: history.times ? history.times[index] : Date.now() / 1000,
      timestamp: history.times
        ? new Date(history.times[index] * 1000).toLocaleTimeString('pt-BR')
        : new Date().toLocaleTimeString('pt-BR'),
        digit,
        parity,
      };
    });

    this.logger.log(`${this.ticks.length} ticks carregados`);
  }

  private processTick(tick: any) {
    if (!tick || !tick.quote) {
      return;
    }

    const value = parseFloat(tick.quote);
    const digit = this.extractLastDigit(value);
    const parity = this.getParityFromDigit(digit);

    const newTick: Tick = {
      value,
      epoch: tick.epoch || Date.now() / 1000,
      timestamp: new Date(
        (tick.epoch || Date.now() / 1000) * 1000,
      ).toLocaleTimeString('pt-BR'),
      digit,
      parity,
    };

    this.ticks.push(newTick);

    // Manter apenas os últimos 20 ticks
    if (this.ticks.length > this.maxTicks) {
      this.ticks.shift();
    }

    this.logger.debug(
      `[Tick] valor=${newTick.value} | dígito=${digit} | paridade=${parity}`,
    );

    // Processar estratégias de todos os modos ativos
    this.processVelozStrategies(newTick).catch((error) => {
      this.logger.error(`[ProcessVelozStrategies] Erro:`, error);
    });
    this.processModeradoStrategies(newTick).catch((error) => {
      this.logger.error(`[ProcessModeradoStrategies] Erro:`, error);
    });
    this.processPrecisoStrategies(newTick).catch((error) => {
      this.logger.error(`[ProcessPrecisoStrategies] Erro:`, error);
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

  private async processVelozStrategies(latestTick: Tick) {
    if (this.velozUsers.size === 0) {
      return;
    }

    const windowTicks = this.ticks.slice(-VELOZ_CONFIG.window);
    if (windowTicks.length < VELOZ_CONFIG.window) {
      this.logger.debug(
        `[Veloz] Aguardando preencher janela (${windowTicks.length}/${VELOZ_CONFIG.window})`,
      );
      return;
    }

    const evenCount = windowTicks.filter((t) => t.parity === 'PAR').length;
    const oddCount = VELOZ_CONFIG.window - evenCount;

    let proposal: DigitParity | null = null;
    if (evenCount === VELOZ_CONFIG.window) {
      proposal = 'IMPAR';
    } else if (oddCount === VELOZ_CONFIG.window) {
      proposal = 'PAR';
    } else {
      this.logger.debug(
        `[Veloz] Janela mista ${windowTicks
          .map((t) => t.parity)
          .join('-')} - aguardando desequilíbrio`,
      );
      return;
    }

    const dvx = this.calculateDVX(this.ticks);
    this.logger.log(
      `[Veloz] Janela ${windowTicks
        .map((t) => t.parity)
        .join('-')} | Proposta: ${proposal} | DVX: ${dvx}`,
    );

    if (dvx > VELOZ_CONFIG.dvxMax) {
      this.logger.warn(
        `[Veloz] DVX alto (${dvx}) > ${VELOZ_CONFIG.dvxMax} - bloqueando operação`,
      );
      return;
    }

    for (const state of this.velozUsers.values()) {
      const canProcess = await this.canProcessVelozState(state);
      if (!canProcess) {
        continue;
      }
      this.handleLossVirtualState(state, proposal, latestTick, dvx);
    }
  }

  private calculateDVX(ticks: Tick[]): number {
    const relevantTicks = ticks.slice(-Math.min(100, ticks.length));
    if (relevantTicks.length === 0) {
      return 0;
    }

    const frequencies = new Array(10).fill(0);
    for (const item of relevantTicks) {
      const digit =
        typeof item.digit === 'number' ? item.digit : this.extractLastDigit(item.value);
      frequencies[digit]++;
    }

    const mean = relevantTicks.length / 10;
    if (mean === 0) {
      return 0;
    }

    let sumSquares = 0;
    for (const freq of frequencies) {
      sumSquares += Math.pow(freq - mean, 2);
    }

    const variance = sumSquares / 10;
    const dvx = Math.min(100, (variance / mean) * 10);
    return Math.round(dvx);
  }

  private async canProcessVelozState(state: VelozUserState): Promise<boolean> {
    if (state.isOperationActive) {
      this.logger.debug(
        `[Veloz][${state.userId}] Operação em andamento - aguardando finalização`,
      );
      return false;
    }
    if (!state.derivToken) {
      this.logger.warn(
        `[Veloz][${state.userId}] Usuário sem token Deriv configurado - ignorando`,
      );
      return false;
    }
    if ((state.virtualCapital || state.capital) <= 0) {
      this.logger.warn(
        `[Veloz][${state.userId}] Usuário sem capital configurado - ignorando`,
      );
      return false;
    }
    
    // Verificar se a sessão foi parada por stop loss/win
    try {
      const configResult = await this.dataSource.query(
        `SELECT session_status, is_active 
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [state.userId],
      );
      
      if (!configResult || configResult.length === 0) {
        // Não há sessão ativa
        this.logger.warn(
          `[Veloz][${state.userId}] Nenhuma sessão ativa encontrada - não executando novos trades`,
        );
        return false;
      }
      
      const config = configResult[0];
      if (config.session_status === 'stopped_profit' || config.session_status === 'stopped_loss') {
        this.logger.warn(
          `[Veloz][${state.userId}] Sessão parada (${config.session_status}) - não executando novos trades`,
        );
        return false;
      }
    } catch (error) {
      this.logger.error(`[Veloz][${state.userId}] Erro ao verificar status da sessão:`, error);
      return false;
    }
    
    return true;
  }

  private handleLossVirtualState(
    state: VelozUserState,
    proposal: DigitParity,
    tick: Tick,
    dvx: number,
  ) {
    if (!state.lossVirtualActive || state.lossVirtualOperation !== proposal) {
      state.lossVirtualActive = true;
      state.lossVirtualOperation = proposal;
      state.lossVirtualCount = 0;
      this.logger.debug(
        `[Veloz][${state.userId}] Iniciando ciclo de loss virtual para ${proposal}`,
      );
    }

    const simulatedWin = tick.parity === proposal;

    if (simulatedWin) {
      if (state.lossVirtualCount > 0) {
        this.logger.debug(
          `[Veloz][${state.userId}] Simulação venceria | Resetando contador`,
        );
      }
      state.lossVirtualCount = 0;
      return;
    }

    state.lossVirtualCount += 1;
    this.logger.log(
      `[Veloz][${state.userId}] Loss virtual ${state.lossVirtualCount}/${VELOZ_CONFIG.lossVirtualTarget} | tick=${tick.value} (${tick.parity}) | proposta=${proposal} | DVX=${dvx}`,
    );

    if (state.lossVirtualCount < VELOZ_CONFIG.lossVirtualTarget) {
      return;
    }

    state.lossVirtualActive = false;
    state.lossVirtualCount = 0;

    this.logger.log(
      `[Veloz][${state.userId}] ✅ Loss virtual completo -> executando operação ${proposal}`,
    );

    this.executeVelozOperation(state, proposal).catch((error) => {
      this.logger.error(
        `[Veloz] Erro ao executar operação para usuário ${state.userId}:`,
        error,
      );
    });
  }

  private calculateVelozStake(state: VelozUserState, entry: number): number {
    const baseStake = state.capital || 0.35; // Valor mínimo da Deriv é 0.35
    
    // Se é primeira entrada, usar a aposta base
    if (entry <= 1) {
      return baseStake;
    }

    // SISTEMA UNIFICADO DE MARTINGALE
    const config = CONFIGS_MARTINGALE[state.modoMartingale];
    const proximaAposta = calcularProximaAposta(
      state.perdaAcumulada,
      state.apostaInicial,
      state.modoMartingale,
    );

    const lucroDesejado = state.apostaInicial * config.multiplicadorLucro;
    
    this.logger.debug(
      `[Veloz][Martingale ${state.modoMartingale.toUpperCase()}] ` +
      `Perda: $${state.perdaAcumulada.toFixed(2)} | ` +
      `Lucro desejado: $${lucroDesejado.toFixed(2)} | ` +
      `Próxima aposta: $${proximaAposta.toFixed(2)}`,
    );

    return Math.max(0.35, proximaAposta); // Mínimo da Deriv: 0.35
  }

  private async executeVelozOperation(
    state: VelozUserState,
    proposal: DigitParity,
    entry: number = 1,
  ): Promise<number> {
    if (entry === 1 && state.isOperationActive) {
      this.logger.warn(`[Veloz] Usuário ${state.userId} já possui operação ativa`);
      return -1;
    }

    state.isOperationActive = true;
    state.martingaleStep = entry;

    const stakeAmount = this.calculateVelozStake(state, entry);
    const currentPrice = this.getCurrentPrice() || 0;

    // Se é primeira entrada, inicializar martingale
    if (entry === 1) {
      state.apostaInicial = stakeAmount;
      state.perdaAcumulada = 0;
      const config = CONFIGS_MARTINGALE[state.modoMartingale];
      this.logger.log(
        `[Veloz][Martingale] Iniciado - Modo: ${state.modoMartingale.toUpperCase()} | ` +
        `Aposta inicial: $${stakeAmount.toFixed(2)} | ` +
        `Máx entradas: ${config.maxEntradas} | ` +
        `Multiplicador lucro: ${(config.multiplicadorLucro * 100).toFixed(0)}%`,
      );
    }

    const tradeId = await this.createVelozTradeRecord(
      state.userId,
      proposal,
      stakeAmount,
      currentPrice,
    );

    this.logger.log(
      `[Veloz][${state.userId}] Enviando operação ${proposal} | stake=${stakeAmount} | entrada=${entry}`,
    );

    try {
      const result = await this.executeDigitTradeOnDeriv({
        tradeId,
        derivToken: state.derivToken,
        currency: state.currency || 'USD',
        stakeAmount,
        contractType: proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
      });

      await this.handleVelozTradeOutcome(
        state,
        proposal,
        tradeId,
        stakeAmount,
        result,
        entry,
      );

      return tradeId;
    } catch (error: any) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error?.message || 'Erro no modo veloz', tradeId],
      );
      throw error;
    }
  }

  private async createVelozTradeRecord(
    userId: string,
    proposal: DigitParity,
    stakeAmount: number,
    fallbackEntryPrice: number,
  ): Promise<number> {
    const analysisPayload = {
      strategy: 'modo_veloz',
      dvx: this.calculateDVX(this.ticks),
      window: VELOZ_CONFIG.window,
      ticks: this.ticks.slice(-this.maxTicks),
    };

    const insertResult = await this.dataSource.query(
      `INSERT INTO ai_trades (
        user_id,
        analysis_data,
        gemini_signal,
        gemini_duration,
        gemini_reasoning,
        entry_price,
        stake_amount,
        contract_type,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        JSON.stringify(analysisPayload),
        proposal,
        1,
        'Modo Veloz - desequilíbrio de paridade',
        fallbackEntryPrice,
        stakeAmount,
        proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
        'PENDING',
      ],
    );

    return insertResult.insertId;
  }

  private async executeDigitTradeOnDeriv(params: {
    tradeId: number;
    derivToken: string;
    currency: string;
    stakeAmount: number;
    contractType: 'DIGITEVEN' | 'DIGITODD';
  }): Promise<DigitTradeResult> {
    const { tradeId, derivToken, currency, stakeAmount, contractType } = params;

    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);
      
      let proposalId: string | null = null;
      let proposalPrice: number | null = null;
      let contractId: string | null = null;
      let isCompleted = false;
      
      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          ws.close();
          reject(new Error('Timeout ao executar contrato dígito'));
        }
      }, 60000);

      const finalize = async (error?: Error, result?: DigitTradeResult) => {
        if (isCompleted) {
          return;
        }
        isCompleted = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (closeError) {
          this.logger.warn('Erro ao fechar WebSocket do modo veloz:', closeError);
        }
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        }
      };

      ws.on('open', () => {
        this.logger.log(
          `[Veloz] WS conectado para trade ${tradeId} | contrato=${contractType}`,
        );
        ws.send(JSON.stringify({ authorize: derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.error) {
            await this.dataSource.query(
              'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
              ['ERROR', msg.error.message || 'Erro da Deriv', tradeId],
            );
            finalize(new Error(msg.error.message || 'Erro da Deriv'));
            return;
          }

              if (msg.msg_type === 'authorize') {
                const proposalPayload = {
                  proposal: 1,
                  amount: stakeAmount,
                  basis: 'stake',
              contract_type: contractType,
              currency,
              duration: 1,
              duration_unit: 't',
                  symbol: this.symbol,
                };
                
            this.logger.log('[Veloz] Enviando proposal dígito', proposalPayload);
            ws.send(JSON.stringify(proposalPayload));
            return;
              }

          if (msg.msg_type === 'proposal') {
            const proposal = msg.proposal;
            if (!proposal || !proposal.id) {
              finalize(new Error('Proposta inválida para contrato dígito'));
              return;
            }

            proposalId = proposal.id;
            proposalPrice = Number(proposal.ask_price);
            const payout = Number(proposal.payout || 0);
            
            await this.dataSource.query(
              'UPDATE ai_trades SET payout = ? WHERE id = ?',
              [payout - stakeAmount, tradeId],
            );

            ws.send(
              JSON.stringify({
              buy: proposalId,
              price: proposalPrice,
              }),
            );
            return;
          }

          if (msg.msg_type === 'buy') {
            const buy = msg.buy;
            if (!buy || !buy.contract_id) {
              finalize(new Error('Compra de contrato dígito não confirmada'));
              return;
            }

            contractId = buy.contract_id;
            const buyPrice = Number(buy.buy_price);
            const entrySpot = Number(buy.entry_spot || this.getCurrentPrice() || 0);

            await this.dataSource.query(
              `UPDATE ai_trades 
               SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
               WHERE id = ?`,
              [contractId, entrySpot, tradeId],
            );

            ws.send(
              JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1,
              }),
            );
            this.logger.log(
              `[Veloz] Compra confirmada | trade=${tradeId} | contrato=${contractId} | preço=${buyPrice}`,
            );
            return;
          }

          if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            if (!contract || contract.is_sold !== 1) {
              return;
            }

            const profit = Number(contract.profit || 0);
            const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
            const status = profit >= 0 ? 'WON' : 'LOST';

            await this.dataSource.query(
              `UPDATE ai_trades
               SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
               WHERE id = ?`,
              [exitPrice, profit, status, tradeId],
            );

            // Buscar dados da operação para replicação
            const tradeData = await this.dataSource.query(
              `SELECT user_id, contract_type, stake_amount, created_at 
               FROM ai_trades WHERE id = ?`,
              [tradeId],
            );

            // Replicar operação para copiadores (assíncrono, não bloqueia)
            if (tradeData && tradeData.length > 0 && this.copyTradingService) {
              const trade = tradeData[0];
              this.copyTradingService.replicateTradeToFollowers(
                trade.user_id,
                {
                  operationType: trade.contract_type,
                  stakeAmount: parseFloat(trade.stake_amount) || 0,
                  result: status === 'WON' ? 'win' : 'loss',
                  profit: profit,
                  executedAt: trade.created_at,
                  closedAt: new Date(),
                  traderOperationId: tradeId.toString(),
                },
              ).catch((error: any) => {
                this.logger.error(`[ReplicateTrade] Erro ao replicar operação ${tradeId}: ${error.message}`);
              });
            }

            finalize(undefined, {
              profitLoss: profit,
              status,
              exitPrice,
              contractId: contract.contract_id || contractId || '',
            });
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (error) => {
        finalize(error);
      });

      ws.on('close', () => {
        if (!isCompleted) {
          finalize(new Error('WebSocket do contrato dígito fechado inesperadamente'));
        }
      });
    });
  }

  private async handleVelozTradeOutcome(
    state: VelozUserState,
    proposal: DigitParity,
    tradeId: number,
    stakeAmount: number,
    result: DigitTradeResult,
    entry: number,
  ): Promise<void> {
    const won = result.status === 'WON';
    const config = CONFIGS_MARTINGALE[state.modoMartingale];

    await this.incrementVelozStats(state.userId, won, result.profitLoss);

    if (won) {
      // ✅ VITÓRIA
      state.virtualCapital += result.profitLoss;
      const lucroLiquido = result.profitLoss - state.perdaAcumulada;
      
      this.logger.log(
        `[Veloz][${state.modoMartingale.toUpperCase()}] ✅ VITÓRIA na ${entry}ª entrada! | ` +
        `Ganho: $${result.profitLoss.toFixed(2)} | ` +
        `Perda recuperada: $${state.perdaAcumulada.toFixed(2)} | ` +
        `Lucro líquido: $${lucroLiquido.toFixed(2)} | ` +
        `Capital: $${state.virtualCapital.toFixed(2)}`,
      );
      
      // Resetar martingale
      state.isOperationActive = false;
      state.martingaleStep = 0;
      state.perdaAcumulada = 0;
      state.apostaInicial = 0;
      return;
    }

    // ❌ PERDA
    state.virtualCapital += result.profitLoss;
    state.perdaAcumulada += stakeAmount;

    this.logger.warn(
      `[Veloz][${state.modoMartingale.toUpperCase()}] ❌ PERDA na ${entry}ª entrada: -$${stakeAmount.toFixed(2)} | ` +
      `Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
    );

    // Verificar se pode continuar (respeitar o maxEntradas do modo)
    if (entry < config.maxEntradas) {
      const proximaAposta = calcularProximaAposta(
        state.perdaAcumulada,
        state.apostaInicial,
        state.modoMartingale,
      );
      
      const lucroEsperado = state.apostaInicial * config.multiplicadorLucro;
      
      this.logger.log(
        `[Veloz][${state.modoMartingale.toUpperCase()}] 🔁 Próxima entrada: $${proximaAposta.toFixed(2)} | ` +
        (lucroEsperado > 0
          ? `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} + Lucro $${lucroEsperado.toFixed(2)}`
          : `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} (break-even)`),
      );
      
      // Executar próxima entrada
      await this.executeVelozOperation(state, proposal, entry + 1);
      return;
    }

    // 🛑 STOP-LOSS DE MARTINGALE
    this.logger.warn(
      `[Veloz][${state.modoMartingale.toUpperCase()}] 🛑 Stop-loss: ${entry} entradas | ` +
      `Perda total: -$${state.perdaAcumulada.toFixed(2)}`,
    );
    
    // Resetar martingale
    state.isOperationActive = false;
    state.martingaleStep = 0;
    state.perdaAcumulada = 0;
    state.apostaInicial = 0;
  }

  private async incrementVelozStats(
    userId: string,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins = total_wins + 1' : 'total_losses = total_losses + 1';
    
    // Buscar saldo atual da sessão
    const currentBalanceResult = await this.dataSource.query(
      `SELECT COALESCE(session_balance, 0) as currentBalance
       FROM ai_user_config
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );
    
    const currentBalance = parseFloat(currentBalanceResult[0]?.currentBalance) || 0;
    const newBalance = currentBalance + profitLoss;
    
    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column},
           session_balance = ?,
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [newBalance, userId],
    );
    
    this.logger.debug(`[IncrementVelozStats][${userId}] Saldo atualizado: $${currentBalance.toFixed(2)} + $${profitLoss.toFixed(2)} = $${newBalance.toFixed(2)}`);
    
    // ✅ Verificar limites de lucro/perda após atualizar stats
    await this.checkAndEnforceLimits(userId);
  }
  
  /**
   * Verifica se os limites de lucro/perda diários foram atingidos e desativa a IA automaticamente
   * Usa o session_balance que é atualizado após cada trade
   * Para imediatamente qualquer trade em andamento e grava o status da sessão
   */
  private async checkAndEnforceLimits(userId: string): Promise<void> {
    try {
      // Buscar configuração do usuário com o saldo atual da sessão
      const configResult = await this.dataSource.query(
        `SELECT profit_target, loss_limit, is_active, session_status, COALESCE(session_balance, 0) as sessionBalance
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE`,
        [userId],
      );
      
      if (!configResult || configResult.length === 0) {
        return;
      }
      
      const config = configResult[0];
      
      // Se já foi parada, não precisa verificar
      if (config.session_status && config.session_status !== 'active') {
        return;
      }
      
      const profitTarget = parseFloat(config.profit_target) || null;
      const lossLimit = parseFloat(config.loss_limit) || null;
      
      // Se não há limites configurados, não fazer nada
      if (!profitTarget && !lossLimit) {
        return;
      }
      
      // Usar o session_balance que já está atualizado após cada trade
      const sessionBalance = parseFloat(config.sessionBalance) || 0;
      
      this.logger.debug(`[CheckLimits][${userId}] Saldo: $${sessionBalance.toFixed(2)} | Alvo: ${profitTarget} | Limite: ${lossLimit}`);
      
      let shouldDeactivate = false;
      let deactivationReason = '';
      let sessionStatus: string | null = null;
      
      // Verificar se atingiu meta de lucro (stop win)
      if (profitTarget && sessionBalance >= profitTarget) {
        shouldDeactivate = true;
        sessionStatus = 'stopped_profit';
        deactivationReason = `Meta de lucro diária atingida: $${sessionBalance.toFixed(2)} (Meta: $${profitTarget})`;
        this.logger.log(`[CheckLimits][${userId}] 🎯 STOP WIN: ${deactivationReason}`);
      }
      
      // Verificar se atingiu limite de perda (stop loss)
      if (lossLimit && sessionBalance <= -lossLimit) {
        shouldDeactivate = true;
        sessionStatus = 'stopped_loss';
        deactivationReason = `Limite de perda diária atingido: -$${Math.abs(sessionBalance).toFixed(2)} (Limite: $${lossLimit})`;
        this.logger.warn(`[CheckLimits][${userId}] 🛑 STOP LOSS: ${deactivationReason}`);
      }
      
      // Desativar IA se necessário
      if (shouldDeactivate && sessionStatus) {
        // Atualizar configuração com status da sessão e desativar
        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET is_active = FALSE, 
               session_status = ?,
               deactivation_reason = ?,
               deactivated_at = NOW(),
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`,
          [sessionStatus, deactivationReason, userId],
        );
        
        // Parar imediatamente qualquer trade em andamento
        // Remover do mapa de usuários ativos para impedir novos trades
        if (this.velozUsers.has(userId)) {
          const state = this.velozUsers.get(userId);
          if (state) {
            // Marcar operação como inativa para parar qualquer trade em andamento
            state.isOperationActive = false;
          }
          this.velozUsers.delete(userId);
          this.logger.log(`[CheckLimits][${userId}] Usuário removido do mapa de usuários ativos (Veloz)`);
        }
        
        // Remover também dos outros modos se estiverem ativos
        if (this.moderadoUsers.has(userId)) {
          const state = this.moderadoUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.moderadoUsers.delete(userId);
          this.logger.log(`[CheckLimits][${userId}] Usuário removido do mapa de usuários ativos (Moderado)`);
        }
        
        if (this.precisoUsers.has(userId)) {
          const state = this.precisoUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.precisoUsers.delete(userId);
          this.logger.log(`[CheckLimits][${userId}] Usuário removido do mapa de usuários ativos (Preciso)`);
        }
        
        // Registrar log de desativação automática
        this.logger.log(`[CheckLimits][${userId}] 🚫 IA DESATIVADA AUTOMATICAMENTE: ${deactivationReason} | Status: ${sessionStatus} | Saldo final: $${sessionBalance.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.error(`[CheckLimits][${userId}] Erro ao verificar limites:`, error);
    }
  }

  private async syncVelozUsersFromDb(): Promise<void> {
    const configs = await this.dataSource.query(
      `SELECT 
        user_id as userId,
        stake_amount as stakeAmount,
        deriv_token as derivToken,
        currency,
        modo_martingale as modoMartingale
       FROM ai_user_config
       WHERE is_active = TRUE
         AND LOWER(mode) = 'veloz'`,
    );

    if (configs.length > 0) {
      this.logger.log(
        `[SyncVeloz] Sincronizando ${configs.length} usuários do banco`,
      );
    }

    const activeIds = new Set<string>();

    for (const config of configs) {
      activeIds.add(config.userId);
      this.logger.debug(
        `[SyncVeloz] Lido do banco: userId=${config.userId} | stake=${config.stakeAmount} | martingale=${config.modoMartingale}`,
      );
      this.upsertVelozUserState({
        userId: config.userId,
        stakeAmount: Number(config.stakeAmount) || 0,
        derivToken: config.derivToken,
        currency: config.currency || 'USD',
        modoMartingale: config.modoMartingale || 'conservador',
      });
    }

    for (const existingId of Array.from(this.velozUsers.keys())) {
      if (!activeIds.has(existingId)) {
        this.velozUsers.delete(existingId);
      }
    }
  }

  private upsertVelozUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }) {
    const { userId, stakeAmount, derivToken, currency, modoMartingale = 'conservador' } = params;
    
    this.logger.log(
      `[UpsertVelozState] userId=${userId} | capital=${stakeAmount} | currency=${currency} | martingale=${modoMartingale}`,
    );
    
    const existing = this.velozUsers.get(userId);

    if (existing) {
      this.logger.debug(
        `[UpsertVelozState] Atualizando usuário existente | capital antigo=${existing.capital} | capital novo=${stakeAmount} | martingale=${modoMartingale}`,
      );
      existing.capital = stakeAmount;
      existing.derivToken = derivToken;
      existing.currency = currency;
      existing.modoMartingale = modoMartingale;
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = stakeAmount;
      }
      this.velozUsers.set(userId, existing);
      return;
    }

    this.logger.debug(
      `[UpsertVelozState] Criando novo usuário | capital=${stakeAmount} | martingale=${modoMartingale}`,
    );
    this.velozUsers.set(userId, {
      userId,
      derivToken,
      currency,
      capital: stakeAmount,
      virtualCapital: stakeAmount,
      lossVirtualActive: false,
      lossVirtualCount: 0,
      lossVirtualOperation: null,
      isOperationActive: false,
      martingaleStep: 0,
      modoMartingale: modoMartingale,
      perdaAcumulada: 0,
      apostaInicial: 0,
    });
  }

  private removeVelozUserState(userId: string) {
    if (this.velozUsers.has(userId)) {
      this.velozUsers.delete(userId);
    }
  }

  getTicks(): Tick[] {
    return this.ticks;
  }

  getCurrentPrice(): number | null {
    if (this.ticks.length === 0) {
      return null;
    }
    return this.ticks[this.ticks.length - 1].value;
  }

  getStatistics() {
    if (this.ticks.length === 0) {
      return null;
    }

    const values = this.ticks.map((t) => t.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const current = values[values.length - 1];
    const first = values[0];
    const change = ((current - first) / first) * 100;

    return {
      min,
      max,
      avg,
      current,
      change,
    };
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      ticksCount: this.ticks.length,
      symbol: this.symbol,
      subscriptionId: this.subscriptionId,
    };
  }

  private send(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  disconnect() {
    this.logger.log('Desconectando...');
    if (this.ws) {
      this.ws.close();
    }
    this.isConnected = false;
    this.ticks = [];
  }

  private async ensureTickStreamReady(
    minTicks: number = VELOZ_CONFIG.window,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.initialize();
    }

    let attempts = 0;
    while (this.ticks.length < minTicks && attempts < 60) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }

    if (this.ticks.length < minTicks) {
      throw new Error(
        `Não foi possível obter ${minTicks} ticks recentes do símbolo ${this.symbol}`,
      );
    }
  }

  async getVelozDiagnostics(userId?: string) {
    await this.ensureTickStreamReady();

    const dvx = this.calculateDVX(this.ticks);
    const windowTicks = this.ticks.slice(-VELOZ_CONFIG.window);
    const evenCount = windowTicks.filter((t) => t.parity === 'PAR').length;
    const oddCount = VELOZ_CONFIG.window - evenCount;

    let proposal: DigitParity | null = null;
    if (evenCount === VELOZ_CONFIG.window) {
      proposal = 'IMPAR';
    } else if (oddCount === VELOZ_CONFIG.window) {
      proposal = 'PAR';
    }

    const userState = userId ? this.velozUsers.get(userId) : undefined;

    return {
      totalTicks: this.ticks.length,
      lastTick: this.ticks[this.ticks.length - 1] || null,
      windowParities: windowTicks.map((t) => t.parity),
      dvx,
      proposal,
      lossVirtual: userState
        ? {
            active: userState.lossVirtualActive,
            count: userState.lossVirtualCount,
            operation: userState.lossVirtualOperation,
          }
        : null,
    };
  }

  async triggerManualVelozOperation(
    userId: string,
    proposal: DigitParity,
  ): Promise<number> {
    const state = this.velozUsers.get(userId);
    if (!state) {
      throw new Error(
        'Usuário não está com o modo veloz ativo ou não possui configuração carregada',
      );
    }

    await this.ensureTickStreamReady();
    const tradeId = await this.executeVelozOperation(state, proposal);
    if (tradeId <= 0) {
      throw new Error('Já existe uma operação ativa para este usuário');
    }
    return tradeId;
  }

  async getSessionStats(userId: string) {
    // Buscar todas as trades do usuário do dia atual (timezone America/Sao_Paulo)
    this.logger.log(`[GetSessionStats] 📊 Buscando estatísticas do dia para userId=${userId}`);
    
    // Pegar data atual no timezone do Brasil
    const now = new Date();
    const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const startOfDay = new Date(brazilTime.getFullYear(), brazilTime.getMonth(), brazilTime.getDate(), 0, 0, 0);
    const endOfDay = new Date(brazilTime.getFullYear(), brazilTime.getMonth(), brazilTime.getDate(), 23, 59, 59);
    
    this.logger.log(`[GetSessionStats] 🕐 Filtrando trades do dia: ${startOfDay.toISOString()} até ${endOfDay.toISOString()}`);
    
    const query = `
      SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(profit_loss, 0)) as totalProfitLoss,
        SUM(COALESCE(stake_amount, 0)) as totalVolume
      FROM ai_trades
      WHERE user_id = ? 
        AND created_at >= ?
        AND created_at <= ?
        AND status IN ('WON', 'LOST')
    `;

    const result = await this.dataSource.query(query, [userId, startOfDay, endOfDay]);
    const stats = result[0];

    const totalTrades = parseInt(stats.totalTrades) || 0;
    const wins = parseInt(stats.wins) || 0;
    const losses = parseInt(stats.losses) || 0;
    const profitLoss = parseFloat(stats.totalProfitLoss) || 0;
    const totalVolume = parseFloat(stats.totalVolume) || 0;
    const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    // Buscar saldo da sessão ativa
    const sessionQuery = `
      SELECT 
        COALESCE(session_balance, 0) as sessionBalance,
        created_at as sessionCreatedAt
      FROM ai_user_config
      WHERE user_id = ? AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const sessionResult = await this.dataSource.query(sessionQuery, [userId]);
    const sessionBalance = sessionResult.length > 0 ? parseFloat(sessionResult[0].sessionBalance) || 0 : 0;
    const sessionCreatedAt = sessionResult.length > 0 ? sessionResult[0].sessionCreatedAt : null;

    // Calcular estatísticas da sessão (trades desde o início da sessão)
    let sessionProfitLoss = 0;
    let sessionTrades = 0;
    let sessionWins = 0;
    let sessionLosses = 0;
    let sessionWinrate = 0;
    
    if (sessionCreatedAt) {
      const sessionTradesQuery = `
        SELECT 
          COUNT(*) as sessionTrades,
          SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as sessionWins,
          SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as sessionLosses,
          SUM(COALESCE(profit_loss, 0)) as sessionProfitLoss
        FROM ai_trades
        WHERE user_id = ? 
          AND created_at >= ?
          AND status IN ('WON', 'LOST')
      `;
      const sessionTradesResult = await this.dataSource.query(sessionTradesQuery, [userId, sessionCreatedAt]);
      sessionTrades = parseInt(sessionTradesResult[0]?.sessionTrades) || 0;
      sessionWins = parseInt(sessionTradesResult[0]?.sessionWins) || 0;
      sessionLosses = parseInt(sessionTradesResult[0]?.sessionLosses) || 0;
      sessionProfitLoss = parseFloat(sessionTradesResult[0]?.sessionProfitLoss) || 0;
      sessionWinrate = sessionTrades > 0 ? (sessionWins / sessionTrades) * 100 : 0;
    }

    this.logger.log(`[GetSessionStats] ✅ Stats: trades=${totalTrades}, wins=${wins}, losses=${losses}, P&L=${profitLoss}, volume=${totalVolume}, winrate=${winrate.toFixed(2)}%, sessionBalance=${sessionBalance}, sessionProfit=${sessionProfitLoss}, sessionTrades=${sessionTrades}, sessionWinrate=${sessionWinrate.toFixed(2)}%`);

    return {
      totalTrades,
      wins,
      losses,
      profitLoss,
      totalVolume,
      winrate: parseFloat(winrate.toFixed(2)),
      sessionBalance,
      sessionProfitLoss,
      sessionTrades,
      sessionWins,
      sessionLosses,
      sessionWinrate: parseFloat(sessionWinrate.toFixed(2)),
    };
  }

  async getTradeHistory(userId: string, limit: number = 20) {
    // Buscar histórico de trades do usuário (últimas 20 por padrão)
    this.logger.log(`[GetTradeHistory] 🔍 Buscando histórico para userId=${userId}, limit=${limit}`);
    
    const query = `
      SELECT 
        id,
        gemini_signal as \`signal\`,
        contract_type as contractType,
        entry_price as entryPrice,
        exit_price as exitPrice,
        stake_amount as stakeAmount,
        profit_loss as profitLoss,
        gemini_duration as duration,
        gemini_reasoning as reasoning,
        status,
        created_at as createdAt,
        closed_at as closedAt
      FROM ai_trades
      WHERE user_id = ? 
      ORDER BY COALESCE(closed_at, created_at) DESC
      LIMIT ?
    `;

    this.logger.debug(`[GetTradeHistory] 📝 Query: ${query}`);
    this.logger.debug(`[GetTradeHistory] 📝 Params: userId=${userId}, limit=${limit}`);

    const result = await this.dataSource.query(query, [userId, limit]);
    
    this.logger.log(`[GetTradeHistory] ✅ Query executada, ${result.length} registros encontrados`);

    return result.map((trade: any) => ({
      id: trade.id,
      signal: trade.signal,
      contractType: trade.contractType,
      entryPrice: parseFloat(trade.entryPrice),
      exitPrice: parseFloat(trade.exitPrice),
      stakeAmount: parseFloat(trade.stakeAmount),
      profitLoss: parseFloat(trade.profitLoss),
      duration: trade.duration,
      reasoning: trade.reasoning,
      status: trade.status,
      createdAt: trade.createdAt,
      closedAt: trade.closedAt,
    }));
  }

  // ========== MÉTODOS PARA IA EM BACKGROUND ==========

  /**
   * Ativa a IA para um usuário (salva configuração no banco)
   */
  /**
   * Calcula o tempo de espera entre operações baseado no modo
   * @param mode - fast (1 min), moderate (5 min), slow (10 min)
   * @returns Tempo em milissegundos
   */
  private getWaitTimeByMode(mode: string): number {
    switch (mode) {
      case 'veloz':
        return 0;
      case 'fast':
        return 60000; // 1 minuto
      case 'slow':
        return 600000; // 10 minutos
      case 'moderate':
      default:
        return 300000; // 5 minutos (padrão)
    }
  }

  async initializeTables(): Promise<void> {
    this.logger.log('Inicializando tabelas da IA...');
    
    // Criar tabela ai_user_config
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS ai_user_config (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário',
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        stake_amount DECIMAL(10, 2) NOT NULL DEFAULT 10.00,
        deriv_token TEXT NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        mode VARCHAR(20) NOT NULL DEFAULT 'veloz' COMMENT 'Modo de operação: veloz, fast, moderate, slow',
        profit_target DECIMAL(10, 2) NULL COMMENT 'Meta de lucro diária',
        loss_limit DECIMAL(10, 2) NULL COMMENT 'Limite de perda diária',
        
        last_trade_at TIMESTAMP NULL,
        next_trade_at TIMESTAMP NULL,
        
        total_trades INT UNSIGNED DEFAULT 0,
        total_wins INT UNSIGNED DEFAULT 0,
        total_losses INT UNSIGNED DEFAULT 0,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deactivation_reason TEXT NULL COMMENT 'Motivo da desativação',
        deactivated_at TIMESTAMP NULL COMMENT 'Data/hora da desativação',
        
        INDEX idx_user_id (user_id),
        INDEX idx_is_active (is_active),
        INDEX idx_next_trade_at (next_trade_at),
        INDEX idx_mode (mode),
        INDEX idx_user_active (user_id, is_active, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Configuração de IA de trading por usuário - múltiplas sessões permitidas'
    `);
    
    // Verificar tipo da coluna user_id
    const userIdColumn = await this.dataSource.query(`
      SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'ai_user_config'
      AND COLUMN_NAME = 'user_id'
    `);
    
    // Se user_id for INT, migrar para VARCHAR
    if (userIdColumn.length > 0 && userIdColumn[0].DATA_TYPE !== 'varchar') {
      this.logger.warn('🔄 Migrando user_id de INT para VARCHAR(36)...');
      
      try {
        // Remover índice temporariamente
        await this.dataSource.query(`ALTER TABLE ai_user_config DROP INDEX idx_user_id`);
      } catch (error) {
        // Índice pode não existir, continuar
      }
      
      // Alterar tipo da coluna
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário'
      `);
      
      // Recriar índice (não-unique para permitir múltiplas sessões)
      await this.dataSource.query(`ALTER TABLE ai_user_config ADD INDEX idx_user_id (user_id)`);
      
      this.logger.log('✅ Migração concluída: user_id agora é VARCHAR(36)');
    }
    
    // Verificar se as colunas profit_target e loss_limit existem antes de adicionar
    // (Compatível com MySQL 5.7+)
    const columns = await this.dataSource.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'ai_user_config'
    `);
    
    const columnNames = columns.map((col: any) => col.COLUMN_NAME);
    
    // Adicionar profit_target se não existir
    if (!columnNames.includes('profit_target')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN profit_target DECIMAL(10, 2) NULL COMMENT 'Meta de lucro diária' AFTER mode
      `);
      this.logger.log('✅ Coluna profit_target adicionada');
    }
    
    // Adicionar loss_limit se não existir
    if (!columnNames.includes('loss_limit')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN loss_limit DECIMAL(10, 2) NULL COMMENT 'Limite de perda diária' AFTER profit_target
      `);
      this.logger.log('✅ Coluna loss_limit adicionada');
    }
    
    // Adicionar deactivation_reason se não existir
    if (!columnNames.includes('deactivation_reason')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN deactivation_reason TEXT NULL COMMENT 'Motivo da desativação' AFTER updated_at
      `);
      this.logger.log('✅ Coluna deactivation_reason adicionada');
    }
    
    // Adicionar deactivated_at se não existir
    if (!columnNames.includes('deactivated_at')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN deactivated_at TIMESTAMP NULL COMMENT 'Data/hora da desativação' AFTER deactivation_reason
      `);
      this.logger.log('✅ Coluna deactivated_at adicionada');
    }
    
    // Adicionar modo_martingale se não existir
    if (!columnNames.includes('modo_martingale')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN modo_martingale VARCHAR(20) NOT NULL DEFAULT 'conservador' 
        COMMENT 'Modo de martingale: conservador, moderado, agressivo' 
        AFTER mode
      `);
      this.logger.log('✅ Coluna modo_martingale adicionada');
    }
    
    // 🔄 Remover constraint UNIQUE de user_id se existir (para permitir múltiplas sessões)
    const indexesResult = await this.dataSource.query(`
      SELECT INDEX_NAME, NON_UNIQUE
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ai_user_config'
      AND INDEX_NAME = 'idx_user_id'
    `);
    
    if (indexesResult.length > 0 && indexesResult[0].NON_UNIQUE === 0) {
      this.logger.warn('🔄 Removendo constraint UNIQUE de idx_user_id para permitir múltiplas sessões...');
      
      // Remover índice UNIQUE
      await this.dataSource.query(`ALTER TABLE ai_user_config DROP INDEX idx_user_id`);
      
      // Recriar como índice normal
      await this.dataSource.query(`ALTER TABLE ai_user_config ADD INDEX idx_user_id (user_id)`);
      
      this.logger.log('✅ Índice idx_user_id convertido de UNIQUE para normal');
    }
    
    // Adicionar índice composto se não existir
    const compositeIndexResult = await this.dataSource.query(`
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ai_user_config'
      AND INDEX_NAME = 'idx_user_active'
    `);
    
    if (compositeIndexResult.length === 0) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD INDEX idx_user_active (user_id, is_active, created_at)
      `);
      this.logger.log('✅ Índice composto idx_user_active adicionado');
    }
    
    // Verificar e migrar tabela ai_trades também
    const aiTradesUserIdColumn = await this.dataSource.query(`
      SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'ai_trades'
      AND COLUMN_NAME = 'user_id'
    `);
    
    // Se user_id em ai_trades for INT, migrar para VARCHAR
    if (aiTradesUserIdColumn.length > 0 && aiTradesUserIdColumn[0].DATA_TYPE !== 'varchar') {
      this.logger.warn('🔄 Migrando user_id na tabela ai_trades de INT para VARCHAR(36)...');
      
      // Alterar tipo da coluna em ai_trades
      await this.dataSource.query(`
        ALTER TABLE ai_trades 
        MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário'
      `);
      
      this.logger.log('✅ Migração concluída: ai_trades.user_id agora é VARCHAR(36)');
    }
    
    this.logger.log('✅ Tabelas da IA inicializadas com sucesso');
  }

  async activateUserAI(
    userId: string,
    stakeAmount: number,
    derivToken: string,
    currency: string,
    mode: string = 'veloz',
    profitTarget?: number,
    lossLimit?: number,
    modoMartingale: ModoMartingale = 'conservador',
  ): Promise<void> {
    this.logger.log(
      `[ActivateAI] userId=${userId} | stake=${stakeAmount} | currency=${currency} | mode=${mode} | martingale=${modoMartingale}`,
    );

    // 🔄 NOVA LÓGICA: Sempre criar nova sessão (INSERT)
    // 1. Desativar todas as sessões anteriores deste usuário
    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET is_active = FALSE,
           deactivation_reason = 'Nova sessão iniciada',
           deactivated_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [userId],
    );
    
    this.logger.log(
      `[ActivateAI] 🔄 Sessões anteriores desativadas para userId=${userId}`,
    );
    
    const nextTradeAt = new Date(Date.now() + 60000); // 1 minuto a partir de agora (primeira operação)
    
    // 2. Criar nova sessão (sempre INSERT)
    await this.dataSource.query(
      `INSERT INTO ai_user_config 
       (user_id, is_active, session_status, session_balance, stake_amount, deriv_token, currency, mode, modo_martingale, profit_target, loss_limit, next_trade_at, created_at, updated_at) 
       VALUES (?, TRUE, 'active', 0.00, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURRENT_TIMESTAMP)`,
      [userId, stakeAmount, derivToken, currency, mode, modoMartingale, profitTarget || null, lossLimit || null, nextTradeAt],
    );

    this.logger.log(
      `[ActivateAI] ✅ Nova sessão criada | userId=${userId} | stake=${stakeAmount} | currency=${currency}`,
    );

    if ((mode || '').toLowerCase() === 'veloz') {
      this.logger.log(
        `[ActivateAI] Sincronizando estado Veloz | stake=${stakeAmount}`,
      );
      this.upsertVelozUserState({
        userId,
        stakeAmount,
        derivToken,
        currency,
      });
      this.removeModeradoUserState(userId);
      this.removePrecisoUserState(userId);
    } else if ((mode || '').toLowerCase() === 'moderado') {
      this.logger.log(
        `[ActivateAI] Sincronizando estado Moderado | stake=${stakeAmount}`,
      );
      this.upsertModeradoUserState({
        userId,
        stakeAmount,
        derivToken,
        currency,
      });
      this.removeVelozUserState(userId);
      this.removePrecisoUserState(userId);
    } else if ((mode || '').toLowerCase() === 'preciso') {
      this.logger.log(
        `[ActivateAI] Sincronizando estado Preciso | stake=${stakeAmount}`,
      );
      this.upsertPrecisoUserState({
        userId,
        stakeAmount,
        derivToken,
        currency,
      });
      this.removeVelozUserState(userId);
      this.removeModeradoUserState(userId);
    } else {
      this.removeVelozUserState(userId);
      this.removeModeradoUserState(userId);
      this.removePrecisoUserState(userId);
    }
  }

  /**
   * Desativa a IA para um usuário (desativa apenas a sessão ativa)
   */
  async deactivateUserAI(userId: string): Promise<void> {
    this.logger.log(`Desativando IA para usuário ${userId}`);

    // Desativar apenas a sessão ativa (is_active = TRUE)
    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET is_active = FALSE, 
           deactivation_reason = 'Desativação manual pelo usuário',
           deactivated_at = NOW(),
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND is_active = TRUE`,
      [userId],
    );

    this.logger.log(`IA desativada para usuário ${userId}`);
    this.removeVelozUserState(userId);
    this.removeModeradoUserState(userId);
    this.removePrecisoUserState(userId);
  }

  /**
   * Atualiza configuração da IA de um usuário
   */
  async updateUserAIConfig(
    userId: string,
    stakeAmount?: number,
  ): Promise<void> {
    this.logger.log(`Atualizando configuração da IA para usuário ${userId}`);

    const updates: string[] = [];
    const values: any[] = [];

    if (stakeAmount !== undefined) {
      if (stakeAmount < 0.35) {
        throw new Error('Valor de entrada deve ser no mínimo $0.35');
      }
      updates.push('stake_amount = ?');
      values.push(stakeAmount);
    }

    if (updates.length === 0) {
      throw new Error('Nenhuma configuração fornecida para atualizar');
    }

    values.push(userId);

    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ?`,
      values,
    );

    // Se a IA está ativa e em modo veloz, atualizar o estado em memória
    const config = await this.getUserAIConfig(userId);
    if (config.isActive && (config.mode || '').toLowerCase() === 'veloz') {
      const state = this.velozUsers.get(userId);
      if (state && stakeAmount !== undefined) {
        state.capital = stakeAmount;
        if (state.virtualCapital <= 0) {
          state.virtualCapital = stakeAmount;
        }
        this.logger.log(
          `Estado em memória atualizado para usuário ${userId}: capital=${stakeAmount}`,
        );
      }
    }

    this.logger.log(`Configuração da IA atualizada para usuário ${userId}`);
  }

  /**
   * Busca configuração da IA de um usuário (apenas sessão ativa)
   */
  async getUserAIConfig(userId: string): Promise<any> {
    const result = await this.dataSource.query(
      `SELECT 
        id,
        user_id as userId,
        is_active as isActive,
        session_status as sessionStatus,
        session_balance as sessionBalance,
        stake_amount as stakeAmount,
        currency,
        mode,
        modo_martingale as modoMartingale,
        profit_target as profitTarget,
        loss_limit as lossLimit,
        last_trade_at as lastTradeAt,
        next_trade_at as nextTradeAt,
        total_trades as totalTrades,
        total_wins as totalWins,
        total_losses as totalLosses,
        deactivation_reason as deactivationReason,
        deactivated_at as deactivatedAt,
        created_at as createdAt,
        updated_at as updatedAt
       FROM ai_user_config 
       WHERE user_id = ? AND is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );

    if (result.length === 0) {
      return {
        userId,
        isActive: false,
        stakeAmount: 10,
        currency: 'USD',
        mode: 'veloz',
        modoMartingale: 'conservador',
        profitTarget: null,
        lossLimit: null,
        sessionBalance: 0,
        sessionStatus: null,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        deactivationReason: null,
        deactivatedAt: null,
      };
    }

    return result[0];
  }

  /**
   * Conta quantos usuários têm IA ativa
   */
  async getActiveUsersCount(): Promise<number> {
    const result = await this.dataSource.query(
      'SELECT COUNT(*) as count FROM ai_user_config WHERE is_active = TRUE',
    );
    return result[0]?.count || 0;
  }

  /**
   * Processa apenas usuários em modo fast (chamado a cada 5 segundos para operação contínua)
   */
  async processFastModeUsers(): Promise<void> {
    try {
        const fastModeUsers = await this.dataSource.query(
            `SELECT 
                user_id as userId,
                stake_amount as stakeAmount,
                deriv_token as derivToken,
                currency,
                mode
             FROM ai_user_config 
             WHERE is_active = TRUE 
             AND LOWER(mode) = 'fast'`
        );

        if (fastModeUsers.length > 0) {
            for (const user of fastModeUsers) {
                try {
                    await this.processFastMode(user);
                } catch (error) {
                    this.logger.error(
                        `[Fast Mode] Erro ao processar usuário ${user.userId}:`,
                        error,
                    );
                }
            }
        }
    } catch (error) {
        this.logger.error('[Fast Mode] Erro no processamento:', error);
    }
  }

  /**
   * Processa IAs em background (chamado pelo scheduler)
   * Verifica todos os usuários com IA ativa e executa operações quando necessário
   */
  async processBackgroundAIs(): Promise<void> {
    try {
        // Sincronizar usuários dos modos em tempo real
        await this.syncVelozUsersFromDb();
        await this.syncModeradoUsersFromDb();
        await this.syncPrecisoUsersFromDb();

        // Process other users with trade timing logic (fast/moderado/preciso modes are handled separately)
        const usersToProcess = await this.dataSource.query(
            `SELECT 
                user_id as userId,
                stake_amount as stakeAmount,
                deriv_token as derivToken,
                currency,
                mode,
                next_trade_at as nextTradeAt
             FROM ai_user_config 
             WHERE is_active = TRUE 
             AND LOWER(mode) != 'fast'
             AND (next_trade_at IS NULL OR next_trade_at <= NOW())
             LIMIT 10`
        );

        if (usersToProcess.length > 0) {
            this.logger.log(
                `[Background AI] Processando ${usersToProcess.length} usuários agendados`
            );

            for (const user of usersToProcess) {
                try {
                    await this.processUserAI(user);
                } catch (error) {
                    this.logger.error(
                        `[Background AI] Erro ao processar usuário ${user.userId}:`,
                        error,
                    );
                }
            }
        }
    } catch (error) {
        this.logger.error('[Background AI] Erro no processamento:', error);
    }
}
  /**
   * Processa a IA de um único usuário
   */
 private async processUserAI(user: any): Promise<void> {
    const { userId, stakeAmount, derivToken, currency, mode } = user;
    const normalizedMode = (mode || 'moderate').toLowerCase();
    
    this.logger.log(
        `[Background AI] Processando usuário ${userId} (modo: ${normalizedMode})`,
    );

    if (normalizedMode === 'veloz') {
        await this.prepareVelozUser(user);
        return;
    }

    if (normalizedMode === 'fast') {
        await this.processFastMode(user);
        return;
    }

    this.logger.warn(
        `[Background AI] Modo ${normalizedMode} não suportado`,
    );

    await this.dataSource.query(
        'UPDATE ai_user_config SET next_trade_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE user_id = ?',
        [userId],
    );
}
private async processFastMode(user: any): Promise<void> {
    const { userId, stakeAmount, derivToken, currency } = user;
    
    try {
        // Garantir que temos dados suficientes
        await this.ensureTickStreamReady(FAST_MODE_CONFIG.window);
        
        // Obter os últimos ticks
        const windowTicks = this.ticks.slice(-FAST_MODE_CONFIG.window);
        
        // Verificar se temos ticks suficientes
        if (windowTicks.length < FAST_MODE_CONFIG.window) {
            this.logger.warn(`[Fast] Aguardando mais ticks (${windowTicks.length}/${FAST_MODE_CONFIG.window})`);
            return;
        }
        
        // Contar pares e ímpares na janela
        const evenCount = windowTicks.filter(t => t.parity === 'PAR').length;
        const oddCount = FAST_MODE_CONFIG.window - evenCount;
        
        // Determinar operação proposta baseada na maioria
        let proposedOperation: DigitParity | null = null;
        
        // Se há mais pares, propõe ímpar e vice-versa
        if (evenCount > oddCount) {
            proposedOperation = 'IMPAR';
        } else if (oddCount > evenCount) {
            proposedOperation = 'PAR';
        }
        
        // Se estiver equilibrado, não faz nada
        if (!proposedOperation) {
            this.logger.debug(`[Fast] Janela equilibrada: ${windowTicks.map(t => t.parity).join('-')} - aguardando desequilíbrio`);
            return;
        }
        
        // Calcular DVX
        const dvx = this.calculateDVX(this.ticks);
        if (dvx > FAST_MODE_CONFIG.dvxMax) {
            this.logger.warn(`[Fast] DVX alto (${dvx}) - operação bloqueada`);
            return;
        }
        
        // Executar operação
        this.logger.log(`[Fast] Executando operação: ${proposedOperation} | DVX: ${dvx} | Janela: ${windowTicks.map(t => t.parity).join('-')}`);
        
        // Calcular valor da aposta: usar stakeAmount diretamente ou calcular percentual, garantindo mínimo
        let betAmount = Number(stakeAmount);
        
        // Se stakeAmount parece ser capital (valor alto), calcular percentual
        if (betAmount > 10) {
            betAmount = betAmount * FAST_MODE_CONFIG.betPercent;
        }
        
        // Garantir valor mínimo da Deriv
        if (betAmount < FAST_MODE_CONFIG.minStake) {
            betAmount = FAST_MODE_CONFIG.minStake;
            this.logger.warn(`[Fast] Valor da aposta ajustado para o mínimo: ${betAmount}`);
        }
        
        const contractType = proposedOperation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
        
        const result = await this.executeTrade(userId, {
            contract_type: contractType,
            amount: betAmount,
            symbol: 'R_10',
            duration: 1,
            duration_unit: 't',
            currency: currency || 'USD',
            token: derivToken
        });
        
        if (!result.success) {
            this.logger.error(`[Fast] Falha ao executar trade: ${result.error}`);
            return;
        }

        this.logger.log(`[Fast] Operação executada com sucesso: ${result.tradeId}`);
    } catch (error) {
        this.logger.error(`[Fast] Erro ao processar modo rápido: ${error.message}`, error.stack);
    } finally {
        // Removido o atraso para processamento contínuo
        await this.dataSource.query(
            `UPDATE ai_user_config 
             SET next_trade_at = NOW(), updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?`,
            [userId],
        );
    }
}

private async executeTrade(userId: string, params: any): Promise<{success: boolean; tradeId?: string; error?: string}> {
    const tradeStartTime = Date.now();
    const tradeId = `trade_${userId}_${tradeStartTime}`;
    
    try {
        this.logger.log(`[${tradeId}] Iniciando execução de trade`, {
            userId,
            contractType: params.contract_type,
            amount: params.amount,
            symbol: params.symbol,
            timestamp: new Date().toISOString()
        });

        // Use WebSocket to execute the trade
        const result = await this.executeTradeViaWebSocket(params.token, {
            price: params.amount,
            currency: params.currency || 'USD',
            symbol: params.symbol,
            contract_type: params.contract_type,
            duration: params.duration || 1,
            duration_unit: params.duration_unit || 't',
        }, tradeId);

        if (result.error) {
            throw new Error(result.error);
        }

        // Registrar a operação no banco de dados
        const tradeRecordId = await this.recordTrade({
            userId,
            contractType: params.contract_type,
            amount: params.amount,
            symbol: params.symbol,
            status: 'PENDING',
            entryPrice: this.ticks[this.ticks.length - 1]?.value || 0,
            duration: params.duration || 1,
            durationUnit: params.duration_unit || 't',
            contractId: result.contract_id
        });

        // Iniciar monitoramento do contrato
        if (result.contract_id && tradeRecordId) {
            this.monitorContract(result.contract_id, tradeRecordId, params.token).catch(error => {
                this.logger.error(`[${tradeId}] Erro ao iniciar monitoramento do contrato: ${error.message}`);
            });
        }

        return { 
            success: true,
            tradeId: result.contract_id || tradeId 
        };
    } catch (error) {
        const errorMessage = error.message || 'Erro desconhecido';
        this.logger.error(`[${tradeId}] Falha na execução do trade: ${errorMessage}`, error.stack);

        try {
            await this.recordTrade({
                userId,
                contractType: params.contract_type,
                amount: params.amount,
                symbol: params.symbol,
                status: 'ERROR',
                entryPrice: this.ticks[this.ticks.length - 1]?.value || 0,
                error: errorMessage.substring(0, 255),
                duration: params.duration || 1,
                durationUnit: params.duration_unit || 't'
            });
        } catch (dbError) {
            this.logger.error(`[${tradeId}] Falha ao registrar erro no banco de dados: ${dbError.message}`);
        }

        return { 
            success: false,
            error: errorMessage
        };
    }
}

private async executeTradeViaWebSocket(token: string, contractParams: any, tradeId: string): Promise<{contract_id?: string; error?: string}> {
    return new Promise((resolve, reject) => {
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        const ws = new WebSocket.WebSocket(endpoint, {
            headers: {
                Origin: 'https://app.deriv.com',
            },
        });

        let authorized = false;
        let proposalReceived = false;
        let proposalId: string | null = null;
        let proposalPrice: number | null = null;
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
            reject(new Error('Timeout ao executar trade'));
        }, 30000); // 30 seconds timeout

        ws.on('open', () => {
            this.logger.debug(`[${tradeId}] WebSocket conectado, autorizando...`);
            ws.send(JSON.stringify({ authorize: token }));
        });

        ws.on('message', (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString());
                
                if (msg.authorize) {
                    if (msg.authorize.error) {
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error(`Autorização falhou: ${msg.authorize.error.message || 'Erro desconhecido'}`));
                        return;
                    }
                    authorized = true;
                    this.logger.debug(`[${tradeId}] Autorizado, subscrevendo proposta...`);
                    
                    // Subscribe to proposal
                    const proposalPayload = {
                        proposal: 1,
                        amount: contractParams.price,
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
                    const proposal = msg.proposal;
                    if (proposal.error) {
                        clearTimeout(timeout);
                        if (proposalSubscriptionId) {
                            try {
                                ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
                            } catch (e) {
                                // Ignore
                            }
                        }
                        ws.close();
                        reject(new Error(proposal.error.message || 'Erro ao obter proposta'));
                        return;
                    }
                    
                    proposalId = proposal.id;
                    proposalPrice = Number(proposal.ask_price);
                    proposalReceived = true;
                    
                    if (msg.subscription?.id) {
                        proposalSubscriptionId = msg.subscription.id;
                    }
                    
                    this.logger.debug(`[${tradeId}] Proposta recebida`, {
                        proposal_id: proposalId,
                        price: proposalPrice
                    });
                    
                    // Now send buy request
                    const buyPayload = {
                        buy: proposalId,
                        price: proposalPrice,
                    };
                    
                    this.logger.debug(`[${tradeId}] Enviando buy request...`);
                    ws.send(JSON.stringify(buyPayload));
                    return;
                }

                if (msg.buy) {
                    clearTimeout(timeout);
                    
                    // Unsubscribe from proposal
                    if (proposalSubscriptionId) {
                        try {
                            ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
                        } catch (e) {
                            // Ignore
                        }
                    }
                    
                    ws.close();
                    
                    if (msg.buy.error) {
                        reject(new Error(msg.buy.error.message || 'Erro ao executar trade'));
                        return;
                    }
                    
                    this.logger.debug(`[${tradeId}] Trade executado com sucesso`, {
                        contract_id: msg.buy.contract_id,
                        buy_price: msg.buy.buy_price
                    });
                    
                    resolve({ contract_id: msg.buy.contract_id });
                    return;
                }

                if (msg.error) {
                    clearTimeout(timeout);
                    if (proposalSubscriptionId) {
                        try {
                            ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
                        } catch (e) {
                            // Ignore
                        }
                    }
                    ws.close();
                    reject(new Error(msg.error.message || 'Erro desconhecido'));
                    return;
                }
            } catch (error) {
                this.logger.error(`[${tradeId}] Erro ao processar mensagem: ${error.message}`);
            }
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            this.logger.error(`[${tradeId}] Erro no WebSocket: ${error.message}`);
            reject(new Error(`Erro de conexão: ${error.message}`));
        });

        ws.on('close', () => {
            clearTimeout(timeout);
            if (!authorized) {
                reject(new Error('Conexão fechada antes da autorização'));
            }
        });
    });
}

private async recordTrade(trade: any): Promise<number | null> {
    const insertResult: any = await this.dataSource.query(
        `INSERT INTO ai_trades 
         (user_id, gemini_signal, entry_price, stake_amount, status, 
          gemini_duration, contract_type, contract_id, created_at, analysis_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [
            trade.userId,
            trade.contractType,
            trade.entryPrice,
            trade.amount,
            trade.status,
            trade.duration || 1,
            trade.contractType,
            trade.contractId || null,
            JSON.stringify({ 
                mode: 'fast',
                timestamp: new Date().toISOString(),
                dvx: this.calculateDVX(this.ticks),
                duration_unit: trade.durationUnit || 't',
                ...(trade.error && { error: trade.error })
            })
        ]
    );
    
    // TypeORM pode retornar array ou objeto direto
    const result = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    return result?.insertId || null;
}

private async monitorContract(contractId: string, tradeId: number, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        const ws = new WebSocket.WebSocket(endpoint, {
            headers: {
                Origin: 'https://app.deriv.com',
            },
        });

        let authorized = false;
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
            reject(new Error('Timeout ao monitorar contrato'));
        }, 120000); // 2 minutes timeout (contratos de 1 tick duram pouco)

        ws.on('open', () => {
            this.logger.debug(`[Monitor] Conectando para monitorar contrato ${contractId}...`);
            ws.send(JSON.stringify({ authorize: token }));
        });

        ws.on('message', async (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString());
                
                if (msg.authorize) {
                    if (msg.authorize.error) {
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error(`Autorização falhou: ${msg.authorize.error.message || 'Erro desconhecido'}`));
                        return;
                    }
                    authorized = true;
                    this.logger.debug(`[Monitor] Autorizado, subscrevendo contrato ${contractId}...`);
                    
                    // Subscribe to contract
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
                    
                    // Check if contract is sold
                    if (contract.is_sold === 1) {
                        clearTimeout(timeout);
                        
                        const profit = Number(contract.profit || 0);
                        const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
                        const status = profit >= 0 ? 'WON' : 'LOST';
                        
                        this.logger.debug(`[Monitor] Contrato ${contractId} fechado`, {
                            status,
                            profit,
                            exitPrice
                        });
                        
                        // Update database
                        await this.dataSource.query(
                            `UPDATE ai_trades
                             SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
                             WHERE id = ?`,
                            [exitPrice, profit, status, tradeId],
                        );
                        
                        // Buscar dados da operação para replicação
                        const tradeData = await this.dataSource.query(
                            `SELECT user_id, contract_type, stake_amount, created_at 
                             FROM ai_trades WHERE id = ?`,
                            [tradeId],
                        );

                        // Replicar operação para copiadores (assíncrono, não bloqueia)
                        if (tradeData && tradeData.length > 0 && this.copyTradingService) {
                            const trade = tradeData[0];
                            this.copyTradingService.replicateTradeToFollowers(
                                trade.user_id,
                                {
                                    operationType: trade.contract_type,
                                    stakeAmount: parseFloat(trade.stake_amount) || 0,
                                    result: status === 'WON' ? 'win' : 'loss',
                                    profit: profit,
                                    executedAt: trade.created_at,
                                    closedAt: new Date(),
                                    traderOperationId: tradeId.toString(),
                                },
                            ).catch((error: any) => {
                                this.logger.error(`[ReplicateTrade] Erro ao replicar operação ${tradeId}: ${error.message}`);
                            });
                        }
                        
                        // Unsubscribe
                        if (contractSubscriptionId) {
                            try {
                                ws.send(JSON.stringify({ forget: contractSubscriptionId }));
                            } catch (e) {
                                // Ignore
                            }
                        }
                        
                        ws.close();
                        resolve();
                        return;
                    }
                }

                if (msg.error) {
                    clearTimeout(timeout);
                    if (contractSubscriptionId) {
                        try {
                            ws.send(JSON.stringify({ forget: contractSubscriptionId }));
                        } catch (e) {
                            // Ignore
                        }
                    }
                    ws.close();
                    reject(new Error(msg.error.message || 'Erro desconhecido'));
                    return;
                }
            } catch (error) {
                this.logger.error(`[Monitor] Erro ao processar mensagem: ${error.message}`);
            }
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            this.logger.error(`[Monitor] Erro no WebSocket: ${error.message}`);
            reject(new Error(`Erro de conexão: ${error.message}`));
        });

        ws.on('close', () => {
            clearTimeout(timeout);
            if (!authorized) {
                reject(new Error('Conexão fechada antes da autorização'));
            }
        });
    });
}

  private async prepareVelozUser(user: any): Promise<void> {
    const { userId, stakeAmount, derivToken, currency } = user;

    try {
      await this.ensureTickStreamReady(this.maxTicks);
    } catch (error) {
      this.logger.warn(
        `[Veloz] Não foi possível garantir histórico completo para usuário ${userId}: ${error.message}`,
      );
    }

    this.upsertVelozUserState({
      userId,
      stakeAmount: Number(stakeAmount) || 0,
      derivToken,
      currency: currency || 'USD',
    });

    const nextTradeAt = new Date(Date.now() + 15000); // Reprocessar em 15s

    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET next_trade_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [nextTradeAt, userId],
    );

    this.logger.log(
      `[Veloz] Usuário ${userId} sincronizado | capital=${stakeAmount} | acompanhados=${this.velozUsers.size}`,
    );
  }

  /**
   * Obtém estatísticas do StatsIAs (com fallback para estatísticas locais)
   */
  async getStatsIAsData() {
    try {
      // Tentar buscar da API externa primeiro
      const externalStats = await this.statsIAsService.fetchStats();
      
      if (externalStats) {
        return {
          source: 'external',
          data: externalStats,
        };
      }

      // Fallback para estatísticas locais
      const localStats = await this.statsIAsService.getLocalAggregatedStats(
        this.dataSource,
      );
      
      return {
        source: 'local',
        data: localStats,
      };
    } catch (error) {
      this.logger.error('Erro ao buscar estatísticas do StatsIAs:', error);
      
      // Último recurso: estatísticas locais
      try {
        const localStats = await this.statsIAsService.getLocalAggregatedStats(
          this.dataSource,
        );
        return {
          source: 'local',
          data: localStats,
        };
      } catch (localError) {
        this.logger.error('Erro ao buscar estatísticas locais:', localError);
        return {
          source: 'error',
          data: null,
          error: 'Não foi possível obter estatísticas',
        };
      }
    }
  }

  /**
   * Busca saldo da conta Deriv via WebSocket
   */
  async getDerivBalance(derivToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket.WebSocket(endpoint);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout ao buscar saldo da Deriv'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: derivToken }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.error.message || 'Erro ao buscar saldo'));
            return;
          }

          if (msg.authorize) {
            ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
            return;
          }

          if (msg.balance) {
            clearTimeout(timeout);
            ws.close();
            resolve({
              balance: Number(msg.balance.balance),
              currency: msg.balance.currency,
              loginid: msg.balance.loginid,
            });
            return;
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Busca estatísticas do dashboard do usuário
   */
  async getUserDashboardStats(userId: string): Promise<any> {
    const config = await this.getUserAIConfig(userId);
    const sessionStats = await this.getSessionStats(userId);

    // Buscar total de operações (não só do dia)
    const totalStats = await this.dataSource.query(
      `SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as totalWins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as totalLosses,
        SUM(COALESCE(profit_loss, 0)) as totalProfitLoss
      FROM ai_trades
      WHERE user_id = ? 
        AND status IN ('WON', 'LOST')`,
      [userId],
    );

    const stats = totalStats[0];

    return {
      isActive: config.isActive || false,
      stakeAmount: config.stakeAmount || 0,
      mode: config.mode || 'veloz',
      profitTarget: config.profitTarget,
      lossLimit: config.lossLimit,
      
      // Estatísticas do dia
      today: {
        trades: sessionStats.totalTrades,
        profitLoss: sessionStats.profitLoss,
        wins: sessionStats.wins,
        losses: sessionStats.losses,
      },
      
      // Estatísticas totais
      total: {
        trades: parseInt(stats.totalTrades) || 0,
        wins: parseInt(stats.totalWins) || 0,
        losses: parseInt(stats.totalLosses) || 0,
        profitLoss: parseFloat(stats.totalProfitLoss) || 0,
      },
    };
  }

  /**
   * Busca histórico de sessões do usuário
   */
  async getUserSessions(userId: string, limit: number = 10): Promise<any[]> {
    this.logger.log(`[GetUserSessions] 📊 Buscando histórico de sessões para userId=${userId}`);
    
    // Buscar todas as sessões (ativas e inativas)
    const sessions = await this.dataSource.query(
      `SELECT 
        id,
        is_active as isActive,
        session_status as sessionStatus,
        session_balance as sessionBalance,
        stake_amount as stakeAmount,
        currency,
        mode,
        profit_target as profitTarget,
        loss_limit as lossLimit,
        total_trades as totalTrades,
        total_wins as totalWins,
        total_losses as totalLosses,
        deactivation_reason as deactivationReason,
        deactivated_at as deactivatedAt,
        created_at as createdAt,
        updated_at as updatedAt
       FROM ai_user_config 
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit],
    );

    // Para cada sessão, buscar estatísticas de trades
    const sessionsWithStats = await Promise.all(
      sessions.map(async (session) => {
        const tradeStats = await this.dataSource.query(
          `SELECT 
            COUNT(*) as totalTrades,
            SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
            SUM(COALESCE(profit_loss, 0)) as profitLoss,
            SUM(COALESCE(stake_amount, 0)) as volume,
            MIN(created_at) as firstTrade,
            MAX(COALESCE(closed_at, created_at)) as lastTrade
           FROM ai_trades
           WHERE user_id = ?
             AND created_at >= ?
             AND (? IS NULL OR created_at <= ?)
             AND status IN ('WON', 'LOST')`,
          [
            userId,
            session.createdAt,
            session.deactivatedAt || null,
            session.deactivatedAt || null,
          ],
        );

        const stats = tradeStats[0];
        const totalTrades = parseInt(stats.totalTrades) || 0;
        const wins = parseInt(stats.wins) || 0;
        const losses = parseInt(stats.losses) || 0;
        const profitLoss = parseFloat(stats.profitLoss) || 0;
        const volume = parseFloat(stats.volume) || 0;
        const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        // Calcular duração da sessão
        const startTime = new Date(session.createdAt);
        const endTime = session.deactivatedAt 
          ? new Date(session.deactivatedAt) 
          : new Date();
        const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000);

        return {
          sessionId: session.id,
          isActive: Boolean(session.isActive),
          sessionStatus: session.sessionStatus || 'active',
          sessionBalance: session.sessionBalance ? parseFloat(session.sessionBalance) : profitLoss, // Usar saldo do banco ou calcular
          stakeAmount: parseFloat(session.stakeAmount),
          currency: session.currency,
          mode: session.mode,
          profitTarget: session.profitTarget ? parseFloat(session.profitTarget) : null,
          lossLimit: session.lossLimit ? parseFloat(session.lossLimit) : null,
          
          // Estatísticas
          stats: {
            totalTrades,
            wins,
            losses,
            profitLoss,
            volume,
            winrate: parseFloat(winrate.toFixed(2)),
          },
          
          // Datas
          createdAt: session.createdAt,
          deactivatedAt: session.deactivatedAt,
          durationMinutes,
          
          // Motivo de desativação
          deactivationReason: session.deactivationReason,
        };
      }),
    );

    this.logger.log(`[GetUserSessions] ✅ ${sessionsWithStats.length} sessões processadas`);
    
    return sessionsWithStats;
  }

  /**
   * Usa estatísticas do StatsIAs para ajustar parâmetros de trading
   * (pode ser usado para ajustar dinamicamente DVX, window, etc.)
   */
  async getAdjustedTradingParams(): Promise<{
    dvxMax: number;
    window: number;
    betPercent: number;
  }> {
    try {
      const stats = await this.statsIAsService.fetchStats();
      
      if (!stats || !stats.winRate) {
        // Retornar valores padrão se não houver estatísticas
        return {
          dvxMax: VELOZ_CONFIG.dvxMax,
          window: VELOZ_CONFIG.window,
          betPercent: VELOZ_CONFIG.betPercent,
        };
      }

      // Ajustar parâmetros baseado no win rate
      // Se win rate está alto (>60%), podemos ser mais agressivos
      // Se win rate está baixo (<50%), ser mais conservador
      let dvxMax = VELOZ_CONFIG.dvxMax;
      let betPercent = VELOZ_CONFIG.betPercent;

      if (stats.winRate > 60) {
        // Win rate alto: ser mais agressivo
        dvxMax = Math.min(80, VELOZ_CONFIG.dvxMax + 10);
        betPercent = Math.min(0.01, VELOZ_CONFIG.betPercent * 1.5);
      } else if (stats.winRate < 50) {
        // Win rate baixo: ser mais conservador
        dvxMax = Math.max(50, VELOZ_CONFIG.dvxMax - 10);
        betPercent = Math.max(0.003, VELOZ_CONFIG.betPercent * 0.7);
      }

      this.logger.debug(
        `Parâmetros ajustados baseados em win rate ${stats.winRate}%: DVX=${dvxMax}, Bet=${betPercent}`,
      );

      return {
        dvxMax,
        window: VELOZ_CONFIG.window,
        betPercent,
      };
    } catch (error) {
      this.logger.error('Erro ao ajustar parâmetros de trading:', error);
      return {
        dvxMax: VELOZ_CONFIG.dvxMax,
        window: VELOZ_CONFIG.window,
        betPercent: VELOZ_CONFIG.betPercent,
      };
    }
  }

  // ======================== MODO MODERADO ========================

  /**
   * Processa estratégias do modo MODERADO para todos os usuários ativos
   */
  private async processModeradoStrategies(latestTick: Tick): Promise<void> {
    if (this.ticks.length < MODERADO_CONFIG.minTicks) {
      return;
    }

    // Análise de desequilíbrio (janela de 5 ticks)
    const windowTicks = this.ticks.slice(-MODERADO_CONFIG.window);
    const parCount = windowTicks.filter(t => t.parity === 'PAR').length;
    const imparCount = windowTicks.filter(t => t.parity === 'IMPAR').length;

    const totalInWindow = windowTicks.length;
    const parPercent = parCount / totalInWindow;
    const imparPercent = imparCount / totalInWindow;

    // Se não há desequilíbrio >= 80%, aguardar
    if (parPercent < MODERADO_CONFIG.desequilibrioPercent && 
        imparPercent < MODERADO_CONFIG.desequilibrioPercent) {
      this.logger.debug(
        `[Moderado] Sem desequilíbrio suficiente | PAR: ${(parPercent * 100).toFixed(0)}% | IMPAR: ${(imparPercent * 100).toFixed(0)}%`,
      );
      return;
    }

    // Determinar proposta baseada no desequilíbrio
    let proposal: DigitParity;
    if (parPercent >= MODERADO_CONFIG.desequilibrioPercent) {
      proposal = 'IMPAR'; // Se 80%+ PAR, entrar em ÍMPAR
    } else {
      proposal = 'PAR'; // Se 80%+ ÍMPAR, entrar em PAR
    }

    // Validação DVX
    const dvx = this.calculateDVX(this.ticks);
    if (dvx > MODERADO_CONFIG.dvxMax) {
      this.logger.warn(
        `[Moderado] DVX alto (${dvx}) > ${MODERADO_CONFIG.dvxMax} - bloqueando operação`,
      );
      return;
    }

    // Detector de Anomalias (10 ticks)
    const hasAnomaly = this.detectAnomalies(this.ticks.slice(-MODERADO_CONFIG.anomalyWindow));
    if (hasAnomaly) {
      this.logger.warn(`[Moderado] Anomalia detectada - bloqueando operação`);
      return;
    }

    // Validação de Tendência Geral (20 ticks)
    const trendValid = this.validateTrend(proposal, this.ticks.slice(-MODERADO_CONFIG.trendWindow));
    if (!trendValid) {
      this.logger.warn(`[Moderado] Tendência não confirma proposta ${proposal} - bloqueando`);
      return;
    }

    this.logger.log(
      `[Moderado] Condições OK | Proposta: ${proposal} | DVX: ${dvx} | Deseq: ${(Math.max(parPercent, imparPercent) * 100).toFixed(0)}%`,
    );

    // Processar loss virtual para cada usuário ativo no modo moderado
    for (const state of this.moderadoUsers.values()) {
      const canProcess = await this.canProcessModeradoState(state);
      if (!canProcess) {
        continue;
      }
      await this.handleModeradoLossVirtual(state, proposal, latestTick, dvx);
    }
  }

  /**
   * Detecta anomalias nos últimos N ticks
   */
  private detectAnomalies(recentTicks: Tick[]): boolean {
    if (recentTicks.length < MODERADO_CONFIG.anomalyWindow) {
      return false;
    }

    // 1. Verificar alternância perfeita (P-I-P-I-P-I...)
    let alternations = 0;
    for (let i = 1; i < recentTicks.length; i++) {
      if (recentTicks[i].parity !== recentTicks[i - 1].parity) {
        alternations++;
      }
    }
    if (alternations >= MODERADO_CONFIG.anomalyAlternationMin) {
      this.logger.warn(`[Moderado][Anomalia] Alternância perfeita detectada: ${alternations} alternâncias`);
      return true;
    }

    // 2. Verificar repetição excessiva do mesmo dígito
    const digitCounts = new Map<number, number>();
    for (const tick of recentTicks) {
      digitCounts.set(tick.digit, (digitCounts.get(tick.digit) || 0) + 1);
    }
    for (const [digit, count] of digitCounts.entries()) {
      if (count >= MODERADO_CONFIG.anomalyRepetitionMin) {
        this.logger.warn(`[Moderado][Anomalia] Repetição excessiva: dígito ${digit} apareceu ${count} vezes`);
        return true;
      }
    }

    // 3. Verificar homogeneidade (todos PAR ou todos ÍMPAR)
    const parCount = recentTicks.filter(t => t.parity === 'PAR').length;
    const imparCount = recentTicks.filter(t => t.parity === 'IMPAR').length;
    if (parCount >= MODERADO_CONFIG.anomalyHomogeneityMin || 
        imparCount >= MODERADO_CONFIG.anomalyHomogeneityMin) {
      this.logger.warn(`[Moderado][Anomalia] Homogeneidade detectada: PAR=${parCount}, IMPAR=${imparCount}`);
      return true;
    }

    return false;
  }

  /**
   * Valida tendência geral nos últimos N ticks
   */
  private validateTrend(proposal: DigitParity, trendTicks: Tick[]): boolean {
    if (trendTicks.length < MODERADO_CONFIG.trendWindow) {
      return false;
    }

    const parCount = trendTicks.filter(t => t.parity === 'PAR').length;
    const imparCount = trendTicks.filter(t => t.parity === 'IMPAR').length;
    const total = trendTicks.length;

    const parPercent = parCount / total;
    const imparPercent = imparCount / total;

    // Se vai entrar em ÍMPAR, precisa ter 60%+ de PAR na tendência
    if (proposal === 'IMPAR') {
      if (parPercent >= MODERADO_CONFIG.trendPercent) {
        this.logger.debug(`[Moderado][Tendência] OK para IMPAR: ${(parPercent * 100).toFixed(0)}% PAR nos últimos ${total} ticks`);
        return true;
      }
      this.logger.warn(`[Moderado][Tendência] Insuficiente para IMPAR: apenas ${(parPercent * 100).toFixed(0)}% PAR`);
      return false;
    }

    // Se vai entrar em PAR, precisa ter 60%+ de ÍMPAR na tendência
    if (proposal === 'PAR') {
      if (imparPercent >= MODERADO_CONFIG.trendPercent) {
        this.logger.debug(`[Moderado][Tendência] OK para PAR: ${(imparPercent * 100).toFixed(0)}% IMPAR nos últimos ${total} ticks`);
        return true;
      }
      this.logger.warn(`[Moderado][Tendência] Insuficiente para PAR: apenas ${(imparPercent * 100).toFixed(0)}% IMPAR`);
      return false;
    }

    return false;
  }

  /**
   * Verifica se pode processar o estado do usuário no modo moderado
   */
  private async canProcessModeradoState(state: ModeradoUserState): Promise<boolean> {
    if (state.isOperationActive) {
      this.logger.debug(
        `[Moderado][${state.userId}] Operação em andamento - aguardando finalização`,
      );
      return false;
    }
    if (!state.derivToken) {
      this.logger.warn(
        `[Moderado][${state.userId}] Usuário sem token Deriv configurado - ignorando`,
      );
      return false;
    }
    if ((state.virtualCapital || state.capital) <= 0) {
      this.logger.warn(
        `[Moderado][${state.userId}] Usuário sem capital configurado - ignorando`,
      );
      return false;
    }
    
    // Verificar se a sessão foi parada por stop loss/win
    try {
      const configResult = await this.dataSource.query(
        `SELECT session_status, is_active 
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [state.userId],
      );
      
      if (!configResult || configResult.length === 0) {
        // Não há sessão ativa
        this.logger.warn(
          `[Moderado][${state.userId}] Nenhuma sessão ativa encontrada - não executando novos trades`,
        );
        return false;
      }
      
      const config = configResult[0];
      if (config.session_status === 'stopped_profit' || config.session_status === 'stopped_loss') {
        this.logger.warn(
          `[Moderado][${state.userId}] Sessão parada (${config.session_status}) - não executando novos trades`,
        );
        return false;
      }
    } catch (error) {
      this.logger.error(`[Moderado][${state.userId}] Erro ao verificar status da sessão:`, error);
      return false;
    }
    
    return true;
  }

  /**
   * Gerencia o sistema de loss virtual do modo moderado (3 perdas)
   */
  private async handleModeradoLossVirtual(
    state: ModeradoUserState,
    proposal: DigitParity,
    tick: Tick,
    dvx: number,
  ): Promise<void> {
    // Se ainda não iniciou o ciclo de loss virtual, iniciar agora
    if (!state.lossVirtualActive) {
      state.lossVirtualActive = true;
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Moderado][${state.userId}] Iniciando ciclo de loss virtual para ${proposal}`,
      );
    }

    // Se mudou a proposta, resetar
    if (state.lossVirtualOperation !== proposal) {
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Moderado][${state.userId}] Proposta mudou, resetando loss virtual`,
      );
    }

    // Verificar resultado do tick atual contra a proposta
    const tickResult = tick.parity;
    const wouldWin = tickResult === proposal;

    if (wouldWin) {
      // Se venceria, resetar contador
      this.logger.log(
        `[Moderado][${state.userId}] Vitória virtual | tick=${tick.value} (${tickResult}) | proposta=${proposal} | resetando contador`,
      );
      state.lossVirtualCount = 0;
      return;
    }

    // Perdeu virtualmente, incrementar contador
    state.lossVirtualCount++;
    this.logger.log(
      `[Moderado][${state.userId}] Loss virtual ${state.lossVirtualCount}/${MODERADO_CONFIG.lossVirtualTarget} | tick=${tick.value} (${tickResult}) | proposta=${proposal} | DVX: ${dvx}`,
    );

    // Se atingiu 3 perdas virtuais, executar operação real
    if (state.lossVirtualCount >= MODERADO_CONFIG.lossVirtualTarget) {
      this.logger.log(
        `[Moderado][${state.userId}] ✅ Loss virtual completo -> executando operação ${proposal}`,
      );

      // Resetar contadores antes de executar
      state.lossVirtualCount = 0;
      state.lossVirtualActive = false;
      state.lossVirtualOperation = null;

      // Executar operação real (async)
      this.executeModeradoOperation(state, proposal).catch((error) => {
        this.logger.error(
          `[Moderado] Erro ao executar operação para usuário ${state.userId}:`,
          error,
        );
      });
    }
  }

  /**
   * Executa operação real no modo moderado
   */
  private async executeModeradoOperation(
    state: ModeradoUserState,
    proposal: DigitParity,
    entry: number = 1,
  ): Promise<number> {
    if (entry === 1 && state.isOperationActive) {
      this.logger.warn(`[Moderado] Usuário ${state.userId} já possui operação ativa`);
      return -1;
    }

    state.isOperationActive = true;
    state.martingaleStep = entry;

    const stakeAmount = this.calculateModeradoStake(state);
    const currentPrice = this.getCurrentPrice() || 0;

    const tradeId = await this.createModeradoTradeRecord(
      state.userId,
      proposal,
      stakeAmount,
      currentPrice,
    );

    this.logger.log(
      `[Moderado][${state.userId}] Enviando operação ${proposal} | stake=${stakeAmount} | entrada=${entry}`,
    );

    try {
      const result = await this.executeDigitTradeOnDeriv({
        tradeId,
        derivToken: state.derivToken,
        currency: state.currency || 'USD',
        stakeAmount,
        contractType: proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
      });

      await this.handleModeradoTradeOutcome(
        state,
        proposal,
        tradeId,
        stakeAmount,
        result,
        entry,
      );

      return tradeId;
    } catch (error: any) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error.message || 'Unknown error', tradeId],
      );
      throw error;
    }
  }

  /**
   * Cria registro de trade do modo moderado no banco
   */
  private async createModeradoTradeRecord(
    userId: string,
    proposal: DigitParity,
    stakeAmount: number,
    entryPrice: number,
  ): Promise<number> {
    const analysisData = {
      strategy: 'modo_moderado',
      dvx: this.calculateDVX(this.ticks),
      window: MODERADO_CONFIG.window,
      ticks: this.ticks.slice(-MODERADO_CONFIG.window).map(t => ({
        value: t.value,
        epoch: t.epoch,
        timestamp: t.timestamp,
        digit: t.digit,
        parity: t.parity,
      })),
    };

    const result = await this.dataSource.query(
      `INSERT INTO ai_trades (
        user_id,
        analysis_data,
        gemini_signal,
        gemini_duration,
        gemini_reasoning,
        entry_price,
        stake_amount,
        contract_type,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        JSON.stringify(analysisData),
        proposal,
        1,
        'Modo Moderado - desequilíbrio de paridade + validações',
        entryPrice,
        stakeAmount,
        proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
        'PENDING',
      ],
    );

    return result.insertId;
  }

  /**
   * Trata o resultado de um trade do modo moderado
   */
  private async handleModeradoTradeOutcome(
    state: ModeradoUserState,
    proposal: DigitParity,
    tradeId: number,
    stakeAmount: number,
    result: DigitTradeResult,
    entry: number,
  ): Promise<void> {
    const won = result.status === 'WON';

    this.logger.log(
      `[Moderado][${state.userId}] ${won ? '✅ Vitória' : '❌ Loss'} | Lucro ${result.profitLoss} | entrada=${entry}`,
    );

    await this.incrementModeradoStats(state.userId, won, result.profitLoss);

    if (won) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      state.virtualCapital += result.profitLoss;
      this.logger.log(
        `[Moderado][${state.userId}] ✅ Vitória | Lucro ${result.profitLoss} | capital virtual: ${state.virtualCapital}`,
      );
    } else {
      state.virtualCapital += result.profitLoss;

      if (entry < MODERADO_CONFIG.martingaleMax) {
        const nextEntry = entry + 1;
        this.logger.log(
          `[Moderado][${state.userId}] Aplicando martingale ${nextEntry}/${MODERADO_CONFIG.martingaleMax}`,
        );

        setTimeout(() => {
          this.executeModeradoOperation(state, proposal, nextEntry).catch(
            (error) => {
              this.logger.error(
                `[Moderado] Erro no martingale ${nextEntry}:`,
                error,
              );
            },
          );
        }, 4000);
      } else {
        state.isOperationActive = false;
        state.martingaleStep = 0;
        this.logger.warn(
          `[Moderado][${state.userId}] Martingale esgotado após ${entry} tentativas | capital virtual: ${state.virtualCapital}`,
        );
      }
    }
  }

  /**
   * Incrementa estatísticas do modo moderado
   */
  private async incrementModeradoStats(
    userId: string,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins' : 'total_losses';
    
    // Buscar saldo atual da sessão
    const currentBalanceResult = await this.dataSource.query(
      `SELECT COALESCE(session_balance, 0) as currentBalance
       FROM ai_user_config
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );
    
    const currentBalance = parseFloat(currentBalanceResult[0]?.currentBalance) || 0;
    const newBalance = currentBalance + profitLoss;
    
    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column} = ${column} + 1,
           session_balance = ?,
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [newBalance, userId],
    );
    
    this.logger.debug(`[IncrementModeradoStats][${userId}] Saldo atualizado: $${currentBalance.toFixed(2)} + $${profitLoss.toFixed(2)} = $${newBalance.toFixed(2)}`);

    // Verificar e enforçar limites após cada trade
    await this.checkAndEnforceLimits(userId);
  }

  /**
   * Calcula stake para o modo moderado (0.75% + martingale unificado)
   */
  private calculateModeradoStake(state: ModeradoUserState): number {
    const baseStake = state.capital * MODERADO_CONFIG.betPercent;
    
    // Se é primeira entrada, usar a aposta base
    if (state.martingaleStep === 0) {
      return Math.max(MODERADO_CONFIG.minStake, baseStake);
    }

    // SISTEMA UNIFICADO DE MARTINGALE
    const config = CONFIGS_MARTINGALE[state.modoMartingale];
    const proximaAposta = calcularProximaAposta(
      state.perdaAcumulada,
      state.apostaInicial,
      state.modoMartingale,
    );

    const lucroDesejado = state.apostaInicial * config.multiplicadorLucro;
    
    this.logger.debug(
      `[Moderado][Martingale ${state.modoMartingale.toUpperCase()}] ` +
      `Perda: $${state.perdaAcumulada.toFixed(2)} | ` +
      `Lucro desejado: $${lucroDesejado.toFixed(2)} | ` +
      `Próxima aposta: $${proximaAposta.toFixed(2)}`,
    );

    return Math.max(MODERADO_CONFIG.minStake, proximaAposta);
  }

  /**
   * Sincroniza usuários do modo moderado do banco de dados
   */
  async syncModeradoUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT 
          user_id as userId,
          stake_amount as stakeAmount,
          deriv_token as derivToken,
          currency,
          modo_martingale as modoMartingale
         FROM ai_user_config
         WHERE is_active = TRUE
           AND LOWER(mode) = 'moderado'`,
      );

      this.logger.log(`[SyncModerado] Sincronizando ${activeUsers.length} usuários do banco`);

      const activeIds = new Set(activeUsers.map((u: any) => u.userId));

      // Remover usuários que não estão mais ativos
      for (const existingId of this.moderadoUsers.keys()) {
        if (!activeIds.has(existingId)) {
          this.moderadoUsers.delete(existingId);
          this.logger.log(`[SyncModerado] Removido usuário ${existingId} (não mais ativo)`);
        }
      }

      // Adicionar/atualizar usuários ativos
      for (const user of activeUsers) {
        this.logger.debug(
          `[SyncModerado] Lido do banco: userId=${user.userId} | stake=${user.stakeAmount} | martingale=${user.modoMartingale}`,
        );

        this.upsertModeradoUserState({
          userId: user.userId,
          stakeAmount: parseFloat(user.stakeAmount),
          derivToken: user.derivToken,
          currency: user.currency,
          modoMartingale: user.modoMartingale || 'conservador',
        });
      }
    } catch (error) {
      this.logger.error('[SyncModerado] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Adiciona ou atualiza estado de usuário no modo moderado
   */
  private upsertModeradoUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const modoMartingale = params.modoMartingale || 'conservador';
    
    this.logger.log(
      `[UpsertModeradoState] userId=${params.userId} | capital=${params.stakeAmount} | currency=${params.currency} | martingale=${modoMartingale}`,
    );

    const existing = this.moderadoUsers.get(params.userId);

    if (existing) {
      // Atualizar existente
      this.logger.debug(
        `[UpsertModeradoState] Atualizando usuário existente | capital antigo=${existing.capital} | capital novo=${params.stakeAmount} | martingale=${modoMartingale}`,
      );

      existing.capital = params.stakeAmount;
      existing.derivToken = params.derivToken;
      existing.currency = params.currency;
      existing.modoMartingale = modoMartingale;

      // Resetar capital virtual se necessário
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = params.stakeAmount;
      }
    } else {
      // Criar novo
      this.logger.debug(`[UpsertModeradoState] Criando novo usuário | capital=${params.stakeAmount} | martingale=${modoMartingale}`);

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
        modoMartingale: modoMartingale,
        perdaAcumulada: 0,
        apostaInicial: 0,
      });
    }
  }

  /**
   * Remove usuário do modo moderado
   */
  private removeModeradoUserState(userId: string): void {
    if (this.moderadoUsers.has(userId)) {
      this.moderadoUsers.delete(userId);
      this.logger.log(`[Moderado] Estado removido para usuário ${userId}`);
    }
  }

  // ======================== MODO PRECISO ========================

  /**
   * Processa estratégias do modo PRECISO para todos os usuários ativos
   */
  private async processPrecisoStrategies(latestTick: Tick): Promise<void> {
    if (this.ticks.length < PRECISO_CONFIG.minTicks) {
      return;
    }

    // Análise de desequilíbrio (janela de 7 ticks)
    const windowTicks = this.ticks.slice(-PRECISO_CONFIG.window);
    const parCount = windowTicks.filter(t => t.parity === 'PAR').length;
    const imparCount = windowTicks.filter(t => t.parity === 'IMPAR').length;

    const totalInWindow = windowTicks.length;
    const parPercent = parCount / totalInWindow;
    const imparPercent = imparCount / totalInWindow;

    // Se não há desequilíbrio >= 85%, aguardar
    if (parPercent < PRECISO_CONFIG.desequilibrioPercent && 
        imparPercent < PRECISO_CONFIG.desequilibrioPercent) {
      this.logger.debug(
        `[Preciso] Sem desequilíbrio suficiente | PAR: ${(parPercent * 100).toFixed(0)}% | IMPAR: ${(imparPercent * 100).toFixed(0)}%`,
      );
      return;
    }

    // Determinar proposta baseada no desequilíbrio
    let proposal: DigitParity;
    if (parPercent >= PRECISO_CONFIG.desequilibrioPercent) {
      proposal = 'IMPAR'; // Se 85%+ PAR (6+ de 7), entrar em ÍMPAR
    } else {
      proposal = 'PAR'; // Se 85%+ ÍMPAR (6+ de 7), entrar em PAR
    }

    // Validação DVX (mais rigoroso: máximo 50)
    const dvx = this.calculateDVX(this.ticks);
    if (dvx > PRECISO_CONFIG.dvxMax) {
      this.logger.warn(
        `[Preciso] DVX alto (${dvx}) > ${PRECISO_CONFIG.dvxMax} - bloqueando operação`,
      );
      return;
    }

    // Detector de Anomalias (10 ticks) - mesma lógica do moderado
    const hasAnomaly = this.detectAnomalies(this.ticks.slice(-PRECISO_CONFIG.anomalyWindow));
    if (hasAnomaly) {
      this.logger.warn(`[Preciso] Anomalia detectada - bloqueando operação`);
      return;
    }

    // Validação de Tendência Geral (20 ticks) - mesma lógica do moderado
    const trendValid = this.validateTrend(proposal, this.ticks.slice(-PRECISO_CONFIG.trendWindow));
    if (!trendValid) {
      this.logger.warn(`[Preciso] Tendência não confirma proposta ${proposal} - bloqueando`);
      return;
    }

    this.logger.log(
      `[Preciso] Condições OK | Proposta: ${proposal} | DVX: ${dvx} | Deseq: ${(Math.max(parPercent, imparPercent) * 100).toFixed(0)}%`,
    );

    // Processar loss virtual para cada usuário ativo no modo preciso
    for (const state of this.precisoUsers.values()) {
      const canProcess = await this.canProcessPrecisoState(state);
      if (!canProcess) {
        continue;
      }
      await this.handlePrecisoLossVirtual(state, proposal, latestTick, dvx);
    }
  }

  /**
   * Verifica se pode processar o estado do usuário no modo preciso
   */
  private async canProcessPrecisoState(state: PrecisoUserState): Promise<boolean> {
    if (state.isOperationActive) {
      this.logger.debug(
        `[Preciso][${state.userId}] Operação em andamento - aguardando finalização`,
      );
      return false;
    }
    if (!state.derivToken) {
      this.logger.warn(
        `[Preciso][${state.userId}] Usuário sem token Deriv configurado - ignorando`,
      );
      return false;
    }
    if ((state.virtualCapital || state.capital) <= 0) {
      this.logger.warn(
        `[Preciso][${state.userId}] Usuário sem capital configurado - ignorando`,
      );
      return false;
    }
    
    // Verificar se a sessão foi parada por stop loss/win
    try {
      const configResult = await this.dataSource.query(
        `SELECT session_status, is_active 
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [state.userId],
      );
      
      if (!configResult || configResult.length === 0) {
        // Não há sessão ativa
        this.logger.warn(
          `[Preciso][${state.userId}] Nenhuma sessão ativa encontrada - não executando novos trades`,
        );
        return false;
      }
      
      const config = configResult[0];
      if (config.session_status === 'stopped_profit' || config.session_status === 'stopped_loss') {
        this.logger.warn(
          `[Preciso][${state.userId}] Sessão parada (${config.session_status}) - não executando novos trades`,
        );
        return false;
      }
    } catch (error) {
      this.logger.error(`[Preciso][${state.userId}] Erro ao verificar status da sessão:`, error);
      return false;
    }
    
    return true;
  }

  /**
   * Gerencia o sistema de loss virtual do modo preciso (4 perdas)
   */
  private async handlePrecisoLossVirtual(
    state: PrecisoUserState,
    proposal: DigitParity,
    tick: Tick,
    dvx: number,
  ): Promise<void> {
    // Se ainda não iniciou o ciclo de loss virtual, iniciar agora
    if (!state.lossVirtualActive) {
      state.lossVirtualActive = true;
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Preciso][${state.userId}] Iniciando ciclo de loss virtual para ${proposal}`,
      );
    }

    // Se mudou a proposta, resetar
    if (state.lossVirtualOperation !== proposal) {
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Preciso][${state.userId}] Proposta mudou, resetando loss virtual`,
      );
    }

    // Verificar resultado do tick atual contra a proposta
    const tickResult = tick.parity;
    const wouldWin = tickResult === proposal;

    if (wouldWin) {
      // Se venceria, resetar contador
      this.logger.log(
        `[Preciso][${state.userId}] Vitória virtual | tick=${tick.value} (${tickResult}) | proposta=${proposal} | resetando contador`,
      );
      state.lossVirtualCount = 0;
      return;
    }

    // Perdeu virtualmente, incrementar contador
    state.lossVirtualCount++;
    this.logger.log(
      `[Preciso][${state.userId}] Loss virtual ${state.lossVirtualCount}/${PRECISO_CONFIG.lossVirtualTarget} | tick=${tick.value} (${tickResult}) | proposta=${proposal} | DVX: ${dvx}`,
    );

    // Se atingiu 4 perdas virtuais, executar operação real
    if (state.lossVirtualCount >= PRECISO_CONFIG.lossVirtualTarget) {
      this.logger.log(
        `[Preciso][${state.userId}] ✅ Loss virtual completo (4/4) -> executando operação ${proposal}`,
      );

      // Resetar contadores antes de executar
      state.lossVirtualCount = 0;
      state.lossVirtualActive = false;
      state.lossVirtualOperation = null;

      // Executar operação real (async)
      this.executePrecisoOperation(state, proposal).catch((error) => {
        this.logger.error(
          `[Preciso] Erro ao executar operação para usuário ${state.userId}:`,
          error,
        );
      });
    }
  }

  /**
   * Executa operação real no modo preciso
   */
  private async executePrecisoOperation(
    state: PrecisoUserState,
    proposal: DigitParity,
    entry: number = 1,
  ): Promise<number> {
    if (entry === 1 && state.isOperationActive) {
      this.logger.warn(`[Preciso] Usuário ${state.userId} já possui operação ativa`);
      return -1;
    }

    state.isOperationActive = true;
    state.martingaleStep = entry;

    const stakeAmount = this.calculatePrecisoStake(state);
    const currentPrice = this.getCurrentPrice() || 0;

    const tradeId = await this.createPrecisoTradeRecord(
      state.userId,
      proposal,
      stakeAmount,
      currentPrice,
    );

    this.logger.log(
      `[Preciso][${state.userId}] Enviando operação ${proposal} | stake=${stakeAmount} | entrada=${entry}`,
    );

    try {
      const result = await this.executeDigitTradeOnDeriv({
        tradeId,
        derivToken: state.derivToken,
        currency: state.currency || 'USD',
        stakeAmount,
        contractType: proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
      });

      await this.handlePrecisoTradeOutcome(
        state,
        proposal,
        tradeId,
        stakeAmount,
        result,
        entry,
      );

      return tradeId;
    } catch (error: any) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error.message || 'Unknown error', tradeId],
      );
      throw error;
    }
  }

  /**
   * Cria registro de trade do modo preciso no banco
   */
  private async createPrecisoTradeRecord(
    userId: string,
    proposal: DigitParity,
    stakeAmount: number,
    entryPrice: number,
  ): Promise<number> {
    const analysisData = {
      strategy: 'modo_preciso',
      dvx: this.calculateDVX(this.ticks),
      window: PRECISO_CONFIG.window,
      ticks: this.ticks.slice(-PRECISO_CONFIG.window).map(t => ({
        value: t.value,
        epoch: t.epoch,
        timestamp: t.timestamp,
        digit: t.digit,
        parity: t.parity,
      })),
    };

    const result = await this.dataSource.query(
      `INSERT INTO ai_trades (
        user_id,
        analysis_data,
        gemini_signal,
        gemini_duration,
        gemini_reasoning,
        entry_price,
        stake_amount,
        contract_type,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        JSON.stringify(analysisData),
        proposal,
        1,
        'Modo Preciso - desequilíbrio rigoroso + validações múltiplas',
        entryPrice,
        stakeAmount,
        proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
        'PENDING',
      ],
    );

    return result.insertId;
  }

  /**
   * Trata o resultado de um trade do modo preciso
   */
  private async handlePrecisoTradeOutcome(
    state: PrecisoUserState,
    proposal: DigitParity,
    tradeId: number,
    stakeAmount: number,
    result: DigitTradeResult,
    entry: number,
  ): Promise<void> {
    const won = result.status === 'WON';

    this.logger.log(
      `[Preciso][${state.userId}] ${won ? '✅ Vitória' : '❌ Loss'} | Lucro ${result.profitLoss} | entrada=${entry}`,
    );

    await this.incrementPrecisoStats(state.userId, won, result.profitLoss);

    if (won) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      state.virtualCapital += result.profitLoss;
      this.logger.log(
        `[Preciso][${state.userId}] ✅ Vitória | Lucro ${result.profitLoss} | capital virtual: ${state.virtualCapital}`,
      );
    } else {
      state.virtualCapital += result.profitLoss;

      if (entry < PRECISO_CONFIG.martingaleMax) {
        const nextEntry = entry + 1;
        this.logger.log(
          `[Preciso][${state.userId}] Aplicando martingale ${nextEntry}/${PRECISO_CONFIG.martingaleMax}`,
        );

        setTimeout(() => {
          this.executePrecisoOperation(state, proposal, nextEntry).catch(
            (error) => {
              this.logger.error(
                `[Preciso] Erro no martingale ${nextEntry}:`,
                error,
              );
            },
          );
        }, 4000);
      } else {
        state.isOperationActive = false;
        state.martingaleStep = 0;
        this.logger.warn(
          `[Preciso][${state.userId}] Martingale esgotado após ${entry} tentativas | capital virtual: ${state.virtualCapital}`,
        );
      }
    }
  }

  /**
   * Incrementa estatísticas do modo preciso
   */
  private async incrementPrecisoStats(
    userId: string,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins' : 'total_losses';
    
    // Buscar saldo atual da sessão
    const currentBalanceResult = await this.dataSource.query(
      `SELECT COALESCE(session_balance, 0) as currentBalance
       FROM ai_user_config
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );
    
    const currentBalance = parseFloat(currentBalanceResult[0]?.currentBalance) || 0;
    const newBalance = currentBalance + profitLoss;
    
    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column} = ${column} + 1,
           session_balance = ?,
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [newBalance, userId],
    );
    
    this.logger.debug(`[IncrementPrecisoStats][${userId}] Saldo atualizado: $${currentBalance.toFixed(2)} + $${profitLoss.toFixed(2)} = $${newBalance.toFixed(2)}`);

    // Verificar e enforçar limites após cada trade
    await this.checkAndEnforceLimits(userId);
  }

  /**
   * Calcula stake para o modo preciso (1.0% + martingale unificado)
   */
  private calculatePrecisoStake(state: PrecisoUserState): number {
    const baseStake = state.capital * PRECISO_CONFIG.betPercent;
    
    // Se é primeira entrada, usar a aposta base
    if (state.martingaleStep === 0) {
      return Math.max(PRECISO_CONFIG.minStake, baseStake);
    }

    // SISTEMA UNIFICADO DE MARTINGALE
    const config = CONFIGS_MARTINGALE[state.modoMartingale];
    const proximaAposta = calcularProximaAposta(
      state.perdaAcumulada,
      state.apostaInicial,
      state.modoMartingale,
    );

    const lucroDesejado = state.apostaInicial * config.multiplicadorLucro;
    
    this.logger.debug(
      `[Preciso][Martingale ${state.modoMartingale.toUpperCase()}] ` +
      `Perda: $${state.perdaAcumulada.toFixed(2)} | ` +
      `Lucro desejado: $${lucroDesejado.toFixed(2)} | ` +
      `Próxima aposta: $${proximaAposta.toFixed(2)}`,
    );

    return Math.max(PRECISO_CONFIG.minStake, proximaAposta);
  }

  /**
   * Sincroniza usuários do modo preciso do banco de dados
   */
  async syncPrecisoUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT 
          user_id as userId,
          stake_amount as stakeAmount,
          deriv_token as derivToken,
          currency,
          modo_martingale as modoMartingale
         FROM ai_user_config
         WHERE is_active = TRUE
           AND LOWER(mode) = 'preciso'`,
      );

      this.logger.log(`[SyncPreciso] Sincronizando ${activeUsers.length} usuários do banco`);

      const activeIds = new Set(activeUsers.map((u: any) => u.userId));

      // Remover usuários que não estão mais ativos
      for (const existingId of this.precisoUsers.keys()) {
        if (!activeIds.has(existingId)) {
          this.precisoUsers.delete(existingId);
          this.logger.log(`[SyncPreciso] Removido usuário ${existingId} (não mais ativo)`);
        }
      }

      // Adicionar/atualizar usuários ativos
      for (const user of activeUsers) {
        this.logger.debug(
          `[SyncPreciso] Lido do banco: userId=${user.userId} | stake=${user.stakeAmount} | martingale=${user.modoMartingale}`,
        );

        this.upsertPrecisoUserState({
          userId: user.userId,
          stakeAmount: parseFloat(user.stakeAmount),
          derivToken: user.derivToken,
          currency: user.currency,
          modoMartingale: user.modoMartingale || 'conservador',
        });
      }
    } catch (error) {
      this.logger.error('[SyncPreciso] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Adiciona ou atualiza estado de usuário no modo preciso
   */
  private upsertPrecisoUserState(params: {
    userId: string;
    stakeAmount: number;
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const modoMartingale = params.modoMartingale || 'conservador';
    
    this.logger.log(
      `[UpsertPrecisoState] userId=${params.userId} | capital=${params.stakeAmount} | currency=${params.currency} | martingale=${modoMartingale}`,
    );

    const existing = this.precisoUsers.get(params.userId);

    if (existing) {
      // Atualizar existente
      this.logger.debug(
        `[UpsertPrecisoState] Atualizando usuário existente | capital antigo=${existing.capital} | capital novo=${params.stakeAmount} | martingale=${modoMartingale}`,
      );

      existing.capital = params.stakeAmount;
      existing.derivToken = params.derivToken;
      existing.currency = params.currency;
      existing.modoMartingale = modoMartingale;

      // Resetar capital virtual se necessário
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = params.stakeAmount;
      }
    } else {
      // Criar novo
      this.logger.debug(`[UpsertPrecisoState] Criando novo usuário | capital=${params.stakeAmount} | martingale=${modoMartingale}`);

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
        modoMartingale: modoMartingale,
        perdaAcumulada: 0,
        apostaInicial: 0,
      });
    }
  }

  /**
   * Remove usuário do modo preciso
   */
  private removePrecisoUserState(userId: string): void {
    if (this.precisoUsers.has(userId)) {
      this.precisoUsers.delete(userId);
      this.logger.log(`[Preciso] Estado removido para usuário ${userId}`);
    }
  }
}

