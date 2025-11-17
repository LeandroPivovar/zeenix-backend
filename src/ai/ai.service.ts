import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

export type DigitParity = 'PAR' | 'IMPAR';

export interface Tick {
  value: number;
  epoch: number;
  timestamp: string;
  digit: number;
  parity: DigitParity;
}

interface VelozUserState {
  userId: number;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
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
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private ws: WebSocket.WebSocket | null = null;
  private ticks: Tick[] = [];
  private maxTicks = 100; // Armazena os últimos 100 preços
  private appId: string;
  private symbol = 'R_10';
  private isConnected = false;
  private subscriptionId: string | null = null;
  private velozUsers = new Map<number, VelozUserState>();

  constructor(@InjectDataSource() private dataSource: DataSource) {
    this.appId = process.env.DERIV_APP_ID || '111346';
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

    this.processVelozStrategies(newTick);
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

  private processVelozStrategies(latestTick: Tick) {
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
      if (!this.canProcessVelozState(state)) {
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

  private canProcessVelozState(state: VelozUserState): boolean {
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
    const baseCapital = state.virtualCapital || state.capital || 0;
    const baseStake = Math.max(
      1,
      Number((baseCapital * VELOZ_CONFIG.betPercent).toFixed(2)),
    );

    if (entry <= 1) {
      return baseStake;
    }

    const stake =
      baseStake * Math.pow(VELOZ_CONFIG.martingaleMultiplier, entry - 1);
    return Number(stake.toFixed(2));
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
    userId: number,
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
    await this.incrementVelozStats(
      state.userId,
      result.status === 'WON',
      result.profitLoss,
    );

    state.virtualCapital += result.profitLoss;

    if (result.status === 'WON') {
      this.logger.log(
        `[Veloz][${state.userId}] ✅ Vitória | Lucro ${result.profitLoss.toFixed(
          2,
        )} | capital virtual: ${state.virtualCapital.toFixed(2)}`,
      );
      state.isOperationActive = false;
      state.martingaleStep = 0;
      return;
    }

    this.logger.warn(
      `[Veloz][${state.userId}] ❌ Perda | Entrada ${entry} | Valor ${stakeAmount.toFixed(
        2,
      )}`,
    );

    if (entry < VELOZ_CONFIG.martingaleMax) {
      this.logger.warn(
        `[Veloz][${state.userId}] 🔁 Martingale ${entry + 1}ª entrada agendada`,
      );
      await this.executeVelozOperation(state, proposal, entry + 1);
      return;
    }

    state.isOperationActive = false;
    state.martingaleStep = 0;
  }

  private async incrementVelozStats(
    userId: number,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins = total_wins + 1' : 'total_losses = total_losses + 1';
    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column},
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [userId],
    );
  }

  private async syncVelozUsersFromDb(): Promise<void> {
    const configs = await this.dataSource.query(
      `SELECT 
        user_id as userId,
        stake_amount as stakeAmount,
        deriv_token as derivToken,
        currency
       FROM ai_user_config
       WHERE is_active = TRUE
         AND LOWER(mode) = 'veloz'`,
    );

    const activeIds = new Set<number>();

    for (const config of configs) {
      activeIds.add(config.userId);
      this.upsertVelozUserState({
        userId: config.userId,
        stakeAmount: Number(config.stakeAmount) || 0,
        derivToken: config.derivToken,
        currency: config.currency || 'USD',
      });
    }

    for (const existingId of Array.from(this.velozUsers.keys())) {
      if (!activeIds.has(existingId)) {
        this.velozUsers.delete(existingId);
      }
    }
  }

  private upsertVelozUserState(params: {
    userId: number;
    stakeAmount: number;
    derivToken: string;
    currency: string;
  }) {
    const { userId, stakeAmount, derivToken, currency } = params;
    const existing = this.velozUsers.get(userId);

    if (existing) {
      existing.capital = stakeAmount;
      existing.derivToken = derivToken;
      existing.currency = currency;
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = stakeAmount;
      }
      this.velozUsers.set(userId, existing);
      return;
    }

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
    });
  }

  private removeVelozUserState(userId: number) {
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

  async getVelozDiagnostics(userId?: number) {
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
    userId: number,
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

  async getSessionStats(userId: number) {
    // Buscar todas as trades do usuário da sessão atual (hoje)
    const query = `
      SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(profit_loss, 0)) as totalProfitLoss
      FROM ai_trades
      WHERE user_id = ? 
        AND DATE(created_at) = CURDATE()
        AND status IN ('WON', 'LOST')
    `;

    const result = await this.dataSource.query(query, [userId]);
    const stats = result[0];

    return {
      totalTrades: parseInt(stats.totalTrades) || 0,
      wins: parseInt(stats.wins) || 0,
      losses: parseInt(stats.losses) || 0,
      profitLoss: parseFloat(stats.totalProfitLoss) || 0,
    };
  }

  async getTradeHistory(userId: number, limit: number = 20) {
    // Buscar histórico de trades do usuário (últimas 20 por padrão)
    const query = `
      SELECT 
        id,
        gemini_signal as \`signal\`,
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
        AND status IN ('WON', 'LOST')
      ORDER BY closed_at DESC
      LIMIT ?
    `;

    const result = await this.dataSource.query(query, [userId, limit]);

    return result.map((trade: any) => ({
      id: trade.id,
      signal: trade.signal,
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

  async activateUserAI(
    userId: number,
    stakeAmount: number,
    derivToken: string,
    currency: string,
    mode: string = 'moderate',
  ): Promise<void> {
    this.logger.log(`Ativando IA para usuário ${userId} no modo ${mode}`);

    // Verificar se já existe configuração
    const existing = await this.dataSource.query(
      'SELECT id FROM ai_user_config WHERE user_id = ?',
      [userId],
    );

    const nextTradeAt = new Date(Date.now() + 60000); // 1 minuto a partir de agora (primeira operação)

    if (existing.length > 0) {
      // Atualizar configuração existente
      await this.dataSource.query(
        `UPDATE ai_user_config 
         SET is_active = TRUE, 
             stake_amount = ?, 
             deriv_token = ?, 
             currency = ?,
             mode = ?,
             next_trade_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [stakeAmount, derivToken, currency, mode, nextTradeAt, userId],
      );
    } else {
      // Criar nova configuração
      await this.dataSource.query(
        `INSERT INTO ai_user_config 
         (user_id, is_active, stake_amount, deriv_token, currency, mode, next_trade_at) 
         VALUES (?, TRUE, ?, ?, ?, ?, ?)`,
        [userId, stakeAmount, derivToken, currency, mode, nextTradeAt],
      );
    }

    this.logger.log(`IA ativada para usuário ${userId} no modo ${mode}`);

    if ((mode || '').toLowerCase() === 'veloz') {
      this.upsertVelozUserState({
        userId,
        stakeAmount,
        derivToken,
        currency,
      });
    } else {
      this.removeVelozUserState(userId);
    }
  }

  /**
   * Desativa a IA para um usuário
   */
  async deactivateUserAI(userId: number): Promise<void> {
    this.logger.log(`Desativando IA para usuário ${userId}`);

    await this.dataSource.query(
      'UPDATE ai_user_config SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [userId],
    );

    this.logger.log(`IA desativada para usuário ${userId}`);
    this.removeVelozUserState(userId);
  }

  /**
   * Busca configuração da IA de um usuário
   */
  async getUserAIConfig(userId: number): Promise<any> {
    const result = await this.dataSource.query(
      `SELECT 
        id,
        user_id as userId,
        is_active as isActive,
        stake_amount as stakeAmount,
        currency,
        mode,
        last_trade_at as lastTradeAt,
        next_trade_at as nextTradeAt,
        total_trades as totalTrades,
        total_wins as totalWins,
        total_losses as totalLosses,
        created_at as createdAt,
        updated_at as updatedAt
       FROM ai_user_config 
       WHERE user_id = ?`,
      [userId],
    );

    if (result.length === 0) {
      return {
        userId,
        isActive: false,
        stakeAmount: 10,
        currency: 'USD',
        mode: 'moderate',
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
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
   * Processa IAs em background (chamado pelo scheduler)
   * Verifica todos os usuários com IA ativa e executa operações quando necessário
   */
  async processBackgroundAIs(): Promise<void> {
    try {
      await this.syncVelozUsersFromDb();

      // Buscar usuários com IA ativa e que já passaram do tempo da próxima operação
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
         AND (next_trade_at IS NULL OR next_trade_at <= NOW())
         LIMIT 10`,
      );

      if (usersToProcess.length === 0) {
        return;
      }

      this.logger.log(
        `[Background AI] Processando ${usersToProcess.length} usuários`,
      );

      // Processar cada usuário
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
        await this.ensureTickStreamReady(FAST_MODE_CONFIG.minTicks);
        
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
        
        // Determinar operação proposta
        let proposedOperation: DigitParity | null = null;
        if (evenCount === FAST_MODE_CONFIG.window) {
            proposedOperation = 'IMPAR';
        } else if (oddCount === FAST_MODE_CONFIG.window) {
            proposedOperation = 'PAR';
        }
        
        if (!proposedOperation) {
            this.logger.debug(`[Fast] Janela mista: ${windowTicks.map(t => t.parity).join('-')} - aguardando`);
            return;
        }
        
        // Calcular DVX
        const dvx = this.calculateDVX(this.ticks);
        if (dvx > FAST_MODE_CONFIG.dvxMax) {
            this.logger.warn(`[Fast] DVX alto (${dvx}) - operação bloqueada`);
            return;
        }
        
        // Executar operação
        this.logger.log(`[Fast] Executando operação: ${proposedOperation} | DVX: ${dvx}`);
        
        const betAmount = Number(stakeAmount) * FAST_MODE_CONFIG.betPercent;
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
    // Remove the delay by setting next_trade_at to the current time
    await this.dataSource.query(
        `UPDATE ai_user_config 
         SET next_trade_at = NOW(), updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId],
    );
}
}

 private async executeTrade(userId: number, params: any): Promise<{success: boolean; tradeId?: string; error?: string}> {
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

        const requestParams = {
            proposal: 1,
            subscribe: 1,
            amount: params.amount,
            basis: 'stake',
            contract_type: params.contract_type,
            currency: params.currency || 'USD',
            duration: params.duration || 1,
            duration_unit: params.duration_unit || 't',
            symbol: params.symbol
        };

        const queryString = new URLSearchParams();
        Object.entries(requestParams).forEach(([key, value]) => {
            queryString.append(key, String(value));
        });

        const url = `https://api.deriv.com/ticks_history?${queryString.toString()}`;

        this.logger.debug(`[${tradeId}] Enviando requisição para a API`, {
            url: 'https://api.deriv.com/ticks_history',
            method: 'GET',
            params: requestParams
        });

        const startTime = Date.now();
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${params.token}`
            }
        });
        const requestDuration = Date.now() - startTime;

        // Log response status
        this.logger.debug(`[${tradeId}] Resposta recebida`, {
            status: response.status,
            statusText: response.statusText,
            duration: `${requestDuration}ms`
        });

        const responseText = await response.text();
        let data: any = {};

        try {
            data = responseText ? JSON.parse(responseText) : {};
        } catch (e) {
            throw new Error(`Resposta inválida da API: ${responseText?.substring(0, 200)}...`);
        }

        if (!response.ok || data.error) {
            const errorMsg = data.error?.message || `HTTP ${response.status}: ${response.statusText}`;
            throw new Error(errorMsg);
        }

        // Registrar a operação no banco de dados
        await this.recordTrade({
            userId,
            contractType: params.contract_type,
            amount: params.amount,
            symbol: params.symbol,
            status: 'PENDING',
            entryPrice: this.ticks[this.ticks.length - 1]?.value || 0
        });

        return { 
            success: true, 
            tradeId: data.id || tradeId 
        };
        
    } catch (error) {
        this.logger.error(`[${tradeId}] Falha na execução do trade: ${error.message}`, error.stack);
        
        // Tenta registrar a falha no banco de dados
        try {
            await this.recordTrade({
                userId,
                contractType: params.contract_type,
                amount: params.amount,
                symbol: params.symbol,
                status: 'ERROR',
                entryPrice: this.ticks[this.ticks.length - 1]?.value || 0,
                error: error.message.substring(0, 255)
            });
        } catch (dbError) {
            this.logger.error(`[${tradeId}] Falha ao registrar erro no banco de dados: ${dbError.message}`);
        }

        return { 
            success: false, 
            error: error.message || 'Erro desconhecido ao executar trade',
            tradeId
        };
    }
}
  private async recordTrade(trade: any): Promise<void> {
    await this.dataSource.query(
        `INSERT INTO ai_trades 
         (user_id, gemini_signal, entry_price, stake_amount, status, created_at, analysis_data)
         VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
        [
            trade.userId,
            trade.contractType,
            trade.entryPrice,
            trade.amount,
            trade.status,
            JSON.stringify({ 
                mode: 'fast',
                timestamp: new Date().toISOString(),
                dvx: this.calculateDVX(this.ticks) // Assuming this method exists
            })
        ]
    );
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
}

