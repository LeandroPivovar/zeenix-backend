import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import { TradeEntity, TradeType, TradeStatus } from '../infrastructure/database/entities/trade.entity';
import { v4 as uuidv4 } from 'uuid';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { SettingsService } from '../settings/settings.service';
import { CopyTradingService } from '../copy-trading/copy-trading.service';

export interface CreateTradeDto {
  contractType: string;
  timeType: string;
  duration: string;
  multiplier: number;
  entryValue: number;
  tradeType: TradeType;
  barrier?: number;
}

@Injectable()
export class TradesService {
  constructor(
    @InjectRepository(TradeEntity)
    private readonly tradeRepository: Repository<TradeEntity>,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    private readonly settingsService: SettingsService,
    private readonly dataSource: DataSource,
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
            dto.barrier || null,
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

  async getMarkupData(startDate?: string, endDate?: string) {
    // Taxa de markup da plataforma (3%)
    const MARKUP_RATE = 0.030927835; // 3% / 97% = 0.030927835

    let manualDateCondition = '';
    let aiDateCondition = '';
    const manualParams: any[] = [];
    const aiParams: any[] = [];

    if (startDate && endDate) {
      manualDateCondition = 'AND DATE(t.created_at) BETWEEN ? AND ?';
      aiDateCondition = 'AND DATE(at.created_at) BETWEEN ? AND ?';
      manualParams.push(startDate, endDate);
      aiParams.push(startDate, endDate);
    }

    // Buscar trades manuais vencedoras com lucro
    const manualTradesQuery = `
      SELECT 
        t.user_id,
        u.name,
        u.email,
        COUNT(t.id) as transaction_count,
        SUM(t.profit) as total_profit_net
      FROM trades t
      INNER JOIN users u ON t.user_id = u.id
      WHERE t.status = 'won'
        AND t.profit > 0
        ${manualDateCondition}
      GROUP BY t.user_id, u.name, u.email
    `;

    // Buscar AI trades vencedoras com lucro
    const aiTradesQuery = `
      SELECT 
        at.user_id,
        u.name,
        u.email,
        COUNT(at.id) as transaction_count,
        SUM(at.profit_loss) as total_profit_net
      FROM ai_trades at
      INNER JOIN users u ON at.user_id = u.id
      WHERE at.status = 'WON'
        AND at.profit_loss > 0
        ${aiDateCondition}
      GROUP BY at.user_id, u.name, u.email
    `;

    const [manualTrades, aiTrades] = await Promise.all([
      this.dataSource.query(manualTradesQuery, manualParams),
      this.dataSource.query(aiTradesQuery, aiParams),
    ]);

    // Combinar e agregar dados por usuário
    const usersMap = new Map<string, any>();

    // Processar trades manuais
    manualTrades.forEach((trade: any) => {
      const userId = trade.user_id.toString();
      if (!usersMap.has(userId)) {
        usersMap.set(userId, {
          userId,
          name: trade.name,
          email: trade.email,
          whatsapp: null, // TODO: adicionar campo whatsapp na tabela users
          country: 'Brasil', // TODO: adicionar país ao cadastro
          transactionCount: 0,
          totalProfitNet: 0,
          commission: 0,
        });
      }
      const userData = usersMap.get(userId);
      userData.transactionCount += parseInt(trade.transaction_count);
      userData.totalProfitNet += parseFloat(trade.total_profit_net);
    });

    // Processar AI trades
    aiTrades.forEach((trade: any) => {
      const userId = trade.user_id.toString();
      if (!usersMap.has(userId)) {
        usersMap.set(userId, {
          userId,
          name: trade.name,
          email: trade.email,
          whatsapp: null, // TODO: adicionar campo whatsapp na tabela users
          country: 'Brasil', // TODO: adicionar país ao cadastro
          transactionCount: 0,
          totalProfitNet: 0,
          commission: 0,
        });
      }
      const userData = usersMap.get(userId);
      userData.transactionCount += parseInt(trade.transaction_count);
      userData.totalProfitNet += parseFloat(trade.total_profit_net);
    });

    // Calcular markup (engenharia reversa: lucro líquido * 0.030927835)
    const results = Array.from(usersMap.values()).map(user => ({
      userId: user.userId,
      name: user.name,
      email: user.email,
      whatsapp: user.whatsapp || null,
      country: user.country,
      transactionCount: user.transactionCount,
      commission: parseFloat((user.totalProfitNet * MARKUP_RATE).toFixed(2)),
    }));

    // Ordenar por comissão (maior para menor)
    results.sort((a, b) => b.commission - a.commission);

    return {
      users: results,
      summary: {
        totalCommission: parseFloat(results.reduce((sum, user) => sum + user.commission, 0).toFixed(2)),
        totalTransactions: results.reduce((sum, user) => sum + user.transactionCount, 0),
        totalUsers: results.length,
      },
    };
  }
}

