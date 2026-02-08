import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import { TradeEntity, TradeType, TradeStatus } from '../infrastructure/database/entities/trade.entity';
import { v4 as uuidv4 } from 'uuid';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { SettingsService } from '../settings/settings.service';
import { CopyTradingService } from '../copy-trading/copy-trading.service';
import { Observable, Subject } from 'rxjs';

export interface CreateTradeDto {
  contractType: string;
  timeType: string;
  duration: string;
  multiplier: number;
  entryValue: number;
  tradeType: TradeType;
  barrier?: number;
  derivCurrency?: string;
}

import { DerivService } from '../broker/deriv.service';

@Injectable()
export class TradesService {
  private markupCache = new Map<string, { timestamp: number, data: any[] }>();

  constructor(
    @InjectRepository(TradeEntity)
    private readonly tradeRepository: Repository<TradeEntity>,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    private readonly settingsService: SettingsService,
    private readonly dataSource: DataSource,
    private readonly derivService: DerivService,
    @Inject(forwardRef(() => CopyTradingService))
    private readonly copyTradingService?: CopyTradingService,
  ) { }

  async createTrade(userId: string, dto: CreateTradeDto, ipAddress?: string, userAgent?: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Validar valor mínimo
    if (dto.entryValue < 1) {
      throw new BadRequestException('Valor da entrada deve ser no mínimo $1,00');
    }

    // Validar multiplicador
    if (dto.multiplier < 1 || dto.multiplier > 1000) {
      throw new BadRequestException('Multiplicador deve estar entre 1 e 1000');
    }

    // Criar trade (por enquanto, apenas salvar localmente)
    // Em produção, aqui seria feita a integração com a API da Deriv
    const trade = this.tradeRepository.create({
      id: uuidv4(),
      userId,
      contractType: dto.contractType,
      timeType: dto.timeType,
      duration: dto.duration,
      multiplier: dto.multiplier,
      entryValue: dto.entryValue,
      tradeType: dto.tradeType,
      status: TradeStatus.PENDING,
      derivCurrency: dto.derivCurrency,
    });

    const savedTrade = await this.tradeRepository.save(trade);

    // Se for Trader Mestre, salvar na tabela de operações de mestre e replicar
    if (user.traderMestre) {
      try {
        // Calcular porcentagem do saldo que está sendo usado
        const userBalance = parseFloat(user.derivBalance || '0');
        const percent = userBalance > 0 ? (dto.entryValue / userBalance) * 100 : 0;

        await this.dataSource.query(
          `INSERT INTO master_trader_operations 
           (trader_id, symbol, contract_type, barrier, stake, percent, multiplier, duration, duration_unit, trade_type, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            userId,
            dto.contractType, // symbol (ex: R_100)
            dto.tradeType,    // contract_type (ex: CALL/PUT)
            dto.barrier,
            dto.entryValue,
            percent,
            dto.multiplier,
            parseInt(dto.duration.replace(/\D/g, '')), // extrair numero da duração
            dto.duration.replace(/[0-9]/g, ''),        // extrair unidade da duração (m, s, t)
            dto.tradeType, // trade_type
            'pending'
          ]
        );

        // Replicar imediatamente para os copiadores
        if (this.copyTradingService) {
          await this.copyTradingService.replicateManualOperation(
            userId,
            {
              contractId: savedTrade.id,
              contractType: dto.tradeType,
              symbol: dto.contractType,
              duration: parseInt(dto.duration.replace(/\D/g, '')),
              durationUnit: dto.duration.replace(/[0-9]/g, ''),
              stakeAmount: dto.entryValue,
              percent: percent,
              entrySpot: 0,
              entryTime: Math.floor(Date.now() / 1000),
              barrier: dto.barrier,
            }
          );
        }
      } catch (error) {
        console.error('Erro ao salvar operação de trader mestre:', error);
      }
    }

    // Log da operação
    await this.settingsService.logActivity(
      userId,
      'CREATE_TRADE',
      `Criou operação ${dto.tradeType} de $${dto.entryValue.toFixed(2)}`,
      ipAddress,
      userAgent,
    );

    // Simular resultado após alguns segundos (em produção, isso viria da Deriv)
    setTimeout(async () => {
      await this.simulateTradeResult(savedTrade.id);
    }, 3000);

    return savedTrade;
  }

  private async simulateTradeResult(tradeId: string) {
    const trade = await this.tradeRepository.findOne({ where: { id: tradeId } });
    if (!trade || trade.status !== TradeStatus.PENDING) return;

    // Simulação: 60% de chance de ganho
    const won = Math.random() > 0.4;
    const profit = won
      ? (trade.entryValue * trade.multiplier * (0.5 + Math.random() * 0.5)) // Ganho entre 50-100% do valor investido
      : -(trade.entryValue * (0.5 + Math.random() * 0.5)); // Perda entre 50-100% do valor investido

    trade.status = won ? TradeStatus.WON : TradeStatus.LOST;
    trade.profit = Number(profit.toFixed(2));
    await this.tradeRepository.save(trade);

    // Replicar operação para copiadores (se for trader mestre)
    if (this.copyTradingService) {
      this.copyTradingService.replicateTradeToFollowers(
        trade.userId,
        {
          operationType: trade.tradeType, // BUY ou SELL
          stakeAmount: trade.entryValue,
          result: won ? 'win' : 'loss',
          profit: trade.profit,
          executedAt: trade.createdAt,
          closedAt: trade.updatedAt,
          duration: parseInt(trade.duration) || undefined,
          symbol: trade.contractType,
          traderOperationId: trade.id,
        },
      ).catch((error: any) => {
        console.error(`[TradesService] Erro ao replicar operação manual: ${error.message}`);
      });
    }
  }

  async getUserTrades(userId: string, limit: number = 50) {
    const trades = await this.tradeRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return trades.map(trade => ({
      id: trade.id,
      contractType: trade.contractType,
      timeType: trade.timeType,
      duration: trade.duration,
      multiplier: trade.multiplier,
      entryValue: trade.entryValue,
      tradeType: trade.tradeType,
      status: trade.status,
      profit: trade.profit,
      createdAt: trade.createdAt,
    }));
  }

  async getRecentTrades(userId: string, limit: number = 10) {
    const trades = await this.tradeRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return trades
      .filter(trade => trade.status !== TradeStatus.PENDING)
      .map(trade => ({
        id: trade.id,
        time: trade.createdAt,
        type: trade.tradeType,
        result: trade.profit ? (trade.profit > 0 ? `+$${trade.profit.toFixed(2)}` : `$${trade.profit.toFixed(2)}`) : '-',
        profit: trade.profit,
      }));
  }

  /**
   * Retorna o lucro/perda do dia atual (trades manuais + IA)
   */
  async getTodayProfitLoss(userId: string) {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    // Buscar trades manuais do dia
    const manualTrades = await this.tradeRepository.find({
      where: {
        userId,
        createdAt: Between(startOfDay, endOfDay),
        status: TradeStatus.WON,
      },
    });

    const manualTradesLost = await this.tradeRepository.find({
      where: {
        userId,
        createdAt: Between(startOfDay, endOfDay),
        status: TradeStatus.LOST,
      },
    });

    // Calcular lucro/perda de trades manuais
    const manualProfit = manualTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const manualLoss = manualTradesLost.reduce((sum, t) => sum + Math.abs(t.profit || 0), 0);

    // Buscar trades da IA do dia
    const aiTradesResult = await this.dataSource.query(
      `SELECT 
        SUM(CASE WHEN status = 'WON' THEN profit_loss ELSE 0 END) as ai_profit,
        SUM(CASE WHEN status = 'LOST' THEN ABS(profit_loss) ELSE 0 END) as ai_loss,
        COUNT(CASE WHEN status = 'WON' THEN 1 END) as ai_wins,
        COUNT(CASE WHEN status = 'LOST' THEN 1 END) as ai_losses
       FROM ai_trades
       WHERE user_id = ?
         AND DATE(created_at) = CURDATE()`,
      [userId],
    );

    const aiProfit = parseFloat(aiTradesResult[0]?.ai_profit) || 0;
    const aiLoss = parseFloat(aiTradesResult[0]?.ai_loss) || 0;
    const aiWins = parseInt(aiTradesResult[0]?.ai_wins) || 0;
    const aiLosses = parseInt(aiTradesResult[0]?.ai_losses) || 0;

    // Buscar dados do agente autônomo do dia
    const agentResult = await this.dataSource.query(
      `SELECT 
        COALESCE(daily_profit, 0) as agent_profit,
        COALESCE(daily_loss, 0) as agent_loss,
        COALESCE(total_wins, 0) as agent_wins,
        COALESCE(total_losses, 0) as agent_losses,
        is_active,
        session_status
       FROM autonomous_agent_config
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId],
    );

    const agentProfit = parseFloat(agentResult[0]?.agent_profit) || 0;
    const agentLoss = parseFloat(agentResult[0]?.agent_loss) || 0;
    const agentWins = parseInt(agentResult[0]?.agent_wins) || 0;
    const agentLosses = parseInt(agentResult[0]?.agent_losses) || 0;
    const agentIsActive = agentResult[0]?.is_active === 1 || agentResult[0]?.is_active === true;
    const agentSessionStatus = agentResult[0]?.session_status || null;

    // Calcular totais
    const totalProfit = manualProfit + aiProfit + agentProfit;
    const totalLoss = manualLoss + aiLoss + agentLoss;
    const netResult = totalProfit - totalLoss;

    return {
      today: {
        date: today.toISOString().split('T')[0],
        netResult,
        totalProfit,
        totalLoss,
      },
      manual: {
        profit: manualProfit,
        loss: manualLoss,
        wins: manualTrades.length,
        losses: manualTradesLost.length,
        net: manualProfit - manualLoss,
      },
      ai: {
        profit: aiProfit,
        loss: aiLoss,
        wins: aiWins,
        losses: aiLosses,
        net: aiProfit - aiLoss,
      },
      agent: {
        profit: agentProfit,
        loss: agentLoss,
        wins: agentWins,
        losses: agentLosses,
        net: agentProfit - agentLoss,
        isActive: agentIsActive,
        sessionStatus: agentSessionStatus,
      },
    };
  }

  async getMarkupData(userId: string, startDate?: string, endDate?: string) {
    let dateFrom = startDate;
    let dateTo = endDate;

    if (!startDate || !endDate) {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      dateFrom = firstDay.toISOString().split('T')[0];
      dateTo = lastDay.toISOString().split('T')[0];
    }

    // Ajustar datas para incluir o dia inteiro no filtro SQL
    const dateFromTime = `${dateFrom} 00:00:00`;
    const dateToTime = `${dateTo} 23:59:59`;

    console.log(`[TradesService] Buscando markup (SQL Otimizado) de ${dateFromTime} até ${dateToTime}`);

    const query = `
      SELECT 
        U.id as userId,
        U.name,
        U.email,
        U.phone,
        U.id_real_account as loginid,
        U.real_amount as realAmount,
        U.role,
        U.trader_mestre as traderMestre,
        COUNT(AL.id) as transactionCount,
        SUM(AL.returned_value) as totalPayout
      FROM users U
      LEFT JOIN ai_sessions AI ON AI.user_id = U.id AND AI.account_type = 'real'
      LEFT JOIN ai_trade_logs AL ON AL.ai_sessions_id = AI.id 
        AND AL.result = 'WON'
        AND AL.created_at >= ? 
        AND AL.created_at <= ?
        AND AL.created_at > '2026-02-08 17:42:03'
      WHERE U.is_active = 1 AND U.real_amount > 0
      GROUP BY U.id, U.name, U.email, U.phone, U.id_real_account, U.real_amount, U.role, U.trader_mestre
      ORDER BY totalPayout DESC
    `;

    try {
      const rawResults = await this.dataSource.query(query, [dateFromTime, dateToTime]);

      let totalCommission = 0;
      let totalPayout = 0;
      let totalTransactions = 0;
      let usersWithMarkup = 0;

      const formattedResults = rawResults.map((row: any) => {
        const totalPayoutVal = parseFloat(row.totalPayout || 0);
        // Comissão de 3% sobre o payout (valor retornado pela corretora)
        const commission = totalPayoutVal * 0.03;

        if (commission > 0) usersWithMarkup++;
        totalCommission += commission;
        totalPayout += totalPayoutVal;
        totalTransactions += parseInt(row.transactionCount || 0);

        return {
          userId: row.userId,
          name: row.name,
          email: row.email,
          whatsapp: row.phone,
          country: 'Brasil', // Default, já que não temos coluna country na tabela users ainda
          loginid: row.loginid || 'N/A',
          transactionCount: parseInt(row.transactionCount || 0),
          commission: parseFloat(commission.toFixed(2)),
          realAmount: parseFloat(row.realAmount || 0),
          totalPayout: parseFloat(totalPayoutVal.toFixed(2)),
          // Structure expected by frontend
          breakdown: {
            manual: { payout: 0, count: 0 },
            ia: { payout: totalPayoutVal, count: parseInt(row.transactionCount || 0) }, // All attributed to IA for now
            agent: { payout: 0, count: 0 },
            copy: { payout: 0, count: 0 }
          },
          realData: true,
          role: row.role,
          traderMestre: row.traderMestre === 1 || row.traderMestre === true,
        };
      });

      console.log(`[TradesService] Markup calculado para ${formattedResults.length} usuários.`);

      return {
        users: formattedResults,
        summary: {
          totalCommission: parseFloat(totalCommission.toFixed(2)),
          totalPayout: parseFloat(totalPayout.toFixed(2)),
          totalTransactions: totalTransactions,
          totalUsers: formattedResults.length,
          usersWithMarkup: usersWithMarkup,
          usersWithoutMarkup: formattedResults.length - usersWithMarkup,
        },
        period: {
          from: dateFrom,
          to: dateTo
        }
      };

    } catch (error) {
      console.error('[TradesService] Erro ao executar query de markup:', error);
      throw new Error('Erro ao calcular dados de markup');
    }
  }



  getMarkupDataStream(startDate?: string, endDate?: string): Observable<MessageEvent> {
    const subject = new Subject<MessageEvent>();

    // Executar processo em background para não bloquear o retorno do Observable
    (async () => {
      let dateFrom = startDate;
      let dateTo = endDate;

      if (!startDate || !endDate) {
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        dateFrom = firstDay.toISOString().split('T')[0];
        dateTo = lastDay.toISOString().split('T')[0];
      }

      console.log(`[TradesService] Stream Markup: Iniciando busca de ${dateFrom} até ${dateTo}`);

      try {
        const allUsers = await this.userRepository.findAll();
        // Filtrar apenas usuários ativos E com saldo na conta real > 0
        const activeUsers = allUsers.filter(u => u.isActive && Number(u.realAmount) > 0);
        const totalUsers = activeUsers.length;
        const accumulatedData: any[] = [];

        // Emitir evento de início com metadata
        subject.next({
          data: { type: 'start', totalUsers, period: { from: dateFrom, to: dateTo } }
        } as MessageEvent);

        let processedCount = 0;
        const chunkSize = 5; // Processar em pequenos lotes

        for (let i = 0; i < activeUsers.length; i += chunkSize) {
          const chunk = activeUsers.slice(i, i + chunkSize);

          const chunkPromises = chunk.map(async (user) => {
            // Calcular Markup Interno (3%) baseado nos lucros (wins) de todas as operações
            // Usar filtros de data fornecidos pelo usuário (startDate e endDate)

            let totalPayout = 0;
            let transactionCount = 0;
            const breakdown = {
              manual: { payout: 0, count: 0 },
              ia: { payout: 0, count: 0 },
              agent: { payout: 0, count: 0 },
              copy: { payout: 0, count: 0 }
            };

            try {
              // 1. Trades Manuais (trades table) - status = 'won'
              const manualWins = await this.dataSource.query(
                `SELECT SUM(profit) as total, COUNT(*) as count 
                 FROM trades 
                 WHERE user_id = ? AND status = 'won' 
                 AND DATE(created_at) BETWEEN ? AND ?
                 AND (deriv_currency = 'USD' OR deriv_currency IS NULL)`,
                [user.id, dateFrom, dateTo]
              );
              const manualProfit = parseFloat(manualWins[0]?.total || 0);
              const manualCount = parseInt(manualWins[0]?.count || 0);
              breakdown.manual.payout = manualProfit;
              breakdown.manual.count = manualCount;
              totalPayout += manualProfit;
              transactionCount += manualCount;

              // 2. AI Trades (ai_trades table) - status = 'WON'
              const aiWins = await this.dataSource.query(
                `SELECT SUM(profit_loss) as total, COUNT(*) as count 
                 FROM ai_trades 
                 WHERE user_id = ? AND status = 'WON' 
                 AND DATE(created_at) BETWEEN ? AND ?
                 AND (deriv_currency = 'USD' OR deriv_currency IS NULL)`,
                [user.id, dateFrom, dateTo]
              );
              const aiProfit = parseFloat(aiWins[0]?.total || 0);
              const aiCount = parseInt(aiWins[0]?.count || 0);
              breakdown.ia.payout = aiProfit;
              breakdown.ia.count = aiCount;
              totalPayout += aiProfit;
              transactionCount += aiCount;

              // 3. Agente Autônomo (autonomous_agent_trades table) - status = 'WON'
              try {
                const agentWins = await this.dataSource.query(
                  `SELECT SUM(profit_loss) as total, COUNT(*) as count 
                   FROM autonomous_agent_trades 
                   WHERE user_id = ? AND status = 'WON' 
                   AND DATE(created_at) BETWEEN ? AND ?
                   AND (deriv_currency = 'USD' OR deriv_currency IS NULL)`,
                  [user.id, dateFrom, dateTo]
                );
                const agentProfit = parseFloat(agentWins[0]?.total || 0);
                const agentCount = parseInt(agentWins[0]?.count || 0);
                breakdown.agent.payout = agentProfit;
                breakdown.agent.count = agentCount;
                totalPayout += agentProfit;
                transactionCount += agentCount;
              } catch (e) {
                // Tabela pode não existir, ignorar silenciosamente
              }

              // 4. Copy Trading (copy_trading_operations table) - result = 'win'
              try {
                const copyWins = await this.dataSource.query(
                  `SELECT SUM(profit) as total, COUNT(*) as count 
                   FROM copy_trading_operations 
                   WHERE user_id = ? AND result = 'win' 
                   AND DATE(executed_at) BETWEEN ? AND ?
                   AND (deriv_currency = 'USD' OR deriv_currency IS NULL)`,
                  [user.id, dateFrom, dateTo]
                );
                const copyProfit = parseFloat(copyWins[0]?.total || 0);
                const copyCount = parseInt(copyWins[0]?.count || 0);
                breakdown.copy.payout = copyProfit;
                breakdown.copy.count = copyCount;
                totalPayout += copyProfit;
                transactionCount += copyCount;
              } catch (e) {
                // Tabela pode não existir, ignorar silenciosamente
              }

            } catch (err) {
              console.error(`Erro ao calcular markup para user ${user.id}:`, err);
            }

            // Cálculo do Markup (Comissão de 3%)
            // totalPayout = lucro líquido que o usuário recebeu
            // Precisamos calcular o payout bruto antes da comissão
            // Se o usuário recebeu X após 3% de comissão: X = GrossProfit * 0.97
            // Portanto: GrossProfit = X / 0.97
            // Markup (nossa comissão) = GrossProfit * 0.03 = (X / 0.97) * 0.03
            const grossProfit = totalPayout / 0.97;
            const commission = grossProfit * 0.03;

            return {
              userId: user.id,
              name: user.name,
              email: user.email,
              whatsapp: user.phone || null,
              country: 'Brasil',
              loginid: user.idRealAccount || 'N/A',
              transactionCount: transactionCount,
              commission: parseFloat(commission.toFixed(2)),
              realAmount: Number(user.realAmount || 0),
              totalPayout: parseFloat(totalPayout.toFixed(2)),
              breakdown: breakdown,
              realData: true,
              role: user.role,
              traderMestre: user.traderMestre,
            };
          });

          // Aguardar o chunk
          const chunkResults = await Promise.all(chunkPromises);

          // Emitir cada usuário processado e acumular
          for (const result of chunkResults) {
            accumulatedData.push(result);
            subject.next({
              data: { type: 'user_data', user: result }
            } as MessageEvent);
          }

          processedCount += chunk.length;
          // Opcional: sleep pequeno se necessário
        }


        // Emitir evento de fim
        subject.next({
          data: { type: 'done', totalProcessed: processedCount }
        } as MessageEvent);

        subject.complete();
        console.log('[TradesService] Stream Markup: Concluído e cacheado.');

      } catch (error) {
        console.error('[TradesService] Stream Error:', error);
        subject.error(error);
      }
    })();

    return subject.asObservable();
  }
}

