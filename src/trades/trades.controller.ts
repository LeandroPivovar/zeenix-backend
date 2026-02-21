import { Controller, Get, Post, Body, UseGuards, Req, Query, Sse, MessageEvent as NestMessageEvent, Param } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsEnum, IsNumber, Min, Max, IsOptional } from 'class-validator';
import { DataSource } from 'typeorm'; // Added import
import { TradesService, CreateTradeDto } from './trades.service';
import { MarkupService } from '../markup/markup.service';
import { TradeType } from '../infrastructure/database/entities/trade.entity';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { Inject } from '@nestjs/common';

class CreateTradeRequestDto implements CreateTradeDto {
  @IsString()
  contractType: string;

  @IsString()
  timeType: string;

  @IsString()
  duration: string;

  @IsNumber()
  @Min(1)
  @Max(1000)
  multiplier: number;

  @IsNumber()
  @Min(1)
  entryValue: number;

  @IsEnum(TradeType)
  tradeType: TradeType;

  @IsString()
  @IsOptional()
  derivCurrency?: string;
}

@Controller('trades')
@UseGuards(AuthGuard('jwt'))
export class TradesController {
  constructor(
    private readonly tradesService: TradesService,
    private readonly markupService: MarkupService,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    private readonly dataSource: DataSource, // Injected DataSource
  ) { }

  @Post()
  async createTrade(@Req() req: any, @Body() body: CreateTradeRequestDto) {
    const userId = req.user.userId;
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    return await this.tradesService.createTrade(userId, body, ipAddress, userAgent);
  }

  @Get()
  async getUserTrades(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getUserTrades(userId);
  }

  @Get('recent')
  async getRecentTrades(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getRecentTrades(userId);
  }

  @Get('today-profit')
  async getTodayProfitLoss(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getTodayProfitLoss(userId);
  }

  @Get('markup')
  async getMarkupData(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('targetUserId') targetUserId?: string,
  ) {
    const userId = req.user.userId;
    const user = await this.userRepository.findById(userId);

    let token: string | undefined = process.env.DERIV_READ_TOKEN;

    if (!token) {
      const derivInfo = await this.userRepository.getDerivInfo(userId);
      token = (derivInfo?.tokenReal || derivInfo?.tokenDemo) || undefined;
    }

    if (!token) {
      throw new Error('Token de leitura da Deriv não configurado (DERIV_READ_TOKEN ou conta conectada).');
    }

    // 2. Definir datas
    let dateFrom: string;
    let dateTo: string;

    if (!startDate || !endDate) {
      const now = new Date();
      // Default: últimos 30 dias
      const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
      dateFrom = thirtyDaysAgo.toISOString().split('T')[0];
      dateTo = now.toISOString().split('T')[0];
    } else {
      dateFrom = startDate;
      dateTo = endDate;
    }

    // Formatar para API e para cálculos
    const dateFromFormatted = dateFrom.includes(':') ? dateFrom : `${dateFrom} 00:00:00`;
    const dateToFormatted = dateTo.includes(':') ? dateTo : `${dateTo} 23:59:59`;

    // 3. Calcular Período Anterior
    const currentStart = new Date(dateFromFormatted);
    const currentEnd = new Date(dateToFormatted);
    const diffTime = Math.abs(currentEnd.getTime() - currentStart.getTime());

    // Previous End = Current Start - 1ms
    const prevEnd = new Date(currentStart.getTime() - 1);
    // Previous Start = Previous End - Duration
    const prevStart = new Date(prevEnd.getTime() - diffTime);

    const prevStartFormatted = prevStart.toISOString().split('T')[0] + ' 00:00:00';
    const prevEndFormatted = prevEnd.toISOString().split('T')[0] + ' 23:59:59';

    // Helper para calcular porcentagem
    const calcPct = (current: number, previous: number) => {
      if (!previous) return current > 0 ? 100 : 0;
      return parseFloat((((current - previous) / previous) * 100).toFixed(1));
    };

    try {
      console.log(`[TradesController] Buscando markup...`);
      console.log(`[TradesController] Período: ${dateFromFormatted} até ${dateToFormatted}`);

      // 4. Buscar dados Atuais e Anteriores (Paralelo)
      const [transactions, prevTransactions, allUsers] = await Promise.all([
        this.markupService.getAppMarkupDetails(token, { date_from: dateFromFormatted, date_to: dateToFormatted }),
        this.markupService.getAppMarkupDetails(token, { date_from: prevStartFormatted, date_to: prevEndFormatted }),
        this.userRepository.findAll()
      ]);

      console.log(`[TradesController] RESULTADOS DE DERIV:`);
      console.log(` - Atuais: ${transactions.length} transações`);
      console.log(` - Anteriores: ${prevTransactions.length}`);
      console.log(` - Users Locais no DB: ${allUsers.length}`);

      if (transactions.length > 0) {
        console.log(` - Exemplo da 1ª transação:`, JSON.stringify(transactions[0]).substring(0, 200));
      }

      // 5. Processar Dados
      // Mapa LoginID -> User
      const loginToUserMap = new Map();
      allUsers.forEach(u => {
        if (u.idRealAccount) loginToUserMap.set(u.idRealAccount, u);
        if (u.idDemoAccount) loginToUserMap.set(u.idDemoAccount, u);
        if (u.derivLoginId) loginToUserMap.set(u.derivLoginId, u); // Compatibilidade
      });

      const processTx = (txs: any[]) => {
        let totalComm = 0;
        const userStats = new Map<string, number>();
        const markupByLogin = new Map<string, { markup: number, count: number, loginid: string }>();

        txs.forEach(tx => {
          const login = tx.client_loginid;
          const amount = parseFloat(tx.app_markup_usd || tx.app_markup || 0);

          totalComm += amount;
          userStats.set(login, (userStats.get(login) || 0) + amount);

          if (!markupByLogin.has(login)) {
            markupByLogin.set(login, { markup: 0, count: 0, loginid: login });
          }
          const entry = markupByLogin.get(login)!;
          entry.markup += amount;
          entry.count += 1;
        });
        return { totalComm, userStats, markupByLogin };
      };

      const currentStats = processTx(transactions);
      const prevStats = processTx(prevTransactions);

      // 6. Formatar Lista de Usuários (Apenas período atual)
      const formattedUsers = Array.from(currentStats.markupByLogin.values()).map(entry => {
        const user = loginToUserMap.get(entry.loginid);
        const userMarkup = parseFloat(entry.markup.toFixed(2));
        const estimatedPayout = userMarkup / 0.03;

        // Simulação de Origem (Campanha) para fins de filtro visual
        const origins = ['Google', 'YouTube', 'Facebook', 'Instagram', 'TikTok', 'Outros'];
        const originIndex = (user?.id || entry.loginid).charCodeAt(0) % origins.length;
        const simulatedOrigin = origins[originIndex];

        return {
          userId: user?.id || `unknown-${entry.loginid}`,
          name: user?.name || `Usuário Deriv (${entry.loginid})`,
          email: user?.email || 'N/A',
          whatsapp: user?.phone || null,
          country: 'Brasil',
          origin: simulatedOrigin,
          loginid: entry.loginid,
          transactionCount: entry.count,
          commission: userMarkup,
          realAmount: parseFloat(user?.realAmount || 0),
          volumeOperado: parseFloat(estimatedPayout.toFixed(2)),
          totalPayout: parseFloat(estimatedPayout.toFixed(2)),
          realData: true,
          role: user?.role || 'user',
          isDerivApi: true
        };
      });

      // Ordenar por comissão
      formattedUsers.sort((a, b) => b.commission - a.commission);

      // 7. Calcular Métricas de Resumo e Comparação

      // -- Métricas Derivadas do Markup --
      const curRevenue = currentStats.totalComm;
      const prevRevenue = prevStats.totalComm;

      const curVolume = curRevenue / 0.03;
      const prevVolume = prevRevenue / 0.03;

      const curActiveUsers = currentStats.userStats.size;
      const prevActiveUsers = prevStats.userStats.size;

      const curARPU = curActiveUsers > 0 ? curRevenue / curActiveUsers : 0;
      const prevARPU = prevActiveUsers > 0 ? prevRevenue / prevActiveUsers : 0;

      const curLTV = allUsers.length > 0 ? curRevenue / allUsers.length : 0;
      const prevLTV = allUsers.length > 0 ? prevRevenue / allUsers.length : 0; // Usando base total atual como proxy

      // -- Métricas Históricas de Banco (Saldo) --
      // Helper para query histórica
      const getHistoricalBalanceStats = async (date: Date) => {
        // MySQL
        const dateStr = date.toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:mm:ss

        // Total Balance
        const balanceQuery = `
            SELECT SUM(t1.real_balance) as total 
            FROM user_balances t1 
            JOIN (
                SELECT user_id, MAX(created_at) as max_date 
                FROM user_balances 
                WHERE created_at <= ? 
                GROUP BY user_id
            ) t2 ON t1.user_id = t2.user_id AND t1.created_at = t2.max_date
          `;
        const balanceRes = await this.dataSource.query(balanceQuery, [dateStr]);
        const totalBalance = parseFloat(balanceRes[0]?.total || 0);

        // Users with Balance > 0
        const countQuery = `
            SELECT COUNT(DISTINCT t1.user_id) as count 
            FROM user_balances t1 
            JOIN (
                SELECT user_id, MAX(created_at) as max_date 
                FROM user_balances 
                WHERE created_at <= ? 
                GROUP BY user_id
            ) t2 ON t1.user_id = t2.user_id AND t1.created_at = t2.max_date
            WHERE t1.real_balance > 0
          `;
        const countRes = await this.dataSource.query(countQuery, [dateStr]);
        const usersWithBalance = parseInt(countRes[0]?.count || 0);

        return { totalBalance, usersWithBalance };
      };

      const curHist = await getHistoricalBalanceStats(currentEnd);
      const prevHist = await getHistoricalBalanceStats(prevEnd);

      const curAvgDeposit = curHist.usersWithBalance > 0 ? curHist.totalBalance / curHist.usersWithBalance : 0;
      const prevAvgDeposit = prevHist.usersWithBalance > 0 ? prevHist.totalBalance / prevHist.usersWithBalance : 0;


      return {
        users: formattedUsers,
        summary: {
          // Receita (Markup)
          totalCommission: parseFloat(curRevenue.toFixed(2)),
          totalCommissionPct: calcPct(curRevenue, prevRevenue),

          // Volume
          totalVolume: parseFloat(curVolume.toFixed(2)),
          totalVolumePct: calcPct(curVolume, prevVolume),
          totalPayout: parseFloat(curVolume.toFixed(2)), // Compatibilidade

          // Saldo Real (Histórico)
          totalRealAmount: parseFloat(curHist.totalBalance.toFixed(2)),
          totalRealAmountPct: calcPct(curHist.totalBalance, prevHist.totalBalance),

          // Depósito Médio (Saldo / Users com Saldo)
          avgDeposit: parseFloat(curAvgDeposit.toFixed(2)),
          avgDepositPct: calcPct(curAvgDeposit, prevAvgDeposit),

          // Receita Média (ARPU)
          avgRevenue: parseFloat(curARPU.toFixed(2)),
          avgRevenuePct: calcPct(curARPU, prevARPU),

          // Usuários com Saldo (Sem percentual no frontend, mas enviado)
          usersWithBalance: curHist.usersWithBalance,
          usersWithBalancePct: calcPct(curHist.usersWithBalance, prevHist.usersWithBalance),

          // LTV Médio
          ltvAvg: parseFloat(curLTV.toFixed(2)),
          ltvAvgPct: calcPct(curLTV, prevLTV),

          // Outros
          totalTransactions: transactions.length,
          totalUsers: formattedUsers.length,
          usersWithMarkup: formattedUsers.filter(u => u.commission > 0).length,
          usersWithoutMarkup: 0,
        },
        period: {
          from: dateFrom,
          to: dateTo,
          prevFrom: prevStartFormatted,
          prevTo: prevEndFormatted
        }
      };

    } catch (error) {
      throw error;
    }
  }

  @Get('markup-projection')
  async getMarkupProjection(@Req() req: any) {
    return this.tradesService.getMarkupProjection(req.user.id);
  }

  @Get('user-transactions/:userId')
  async getUserTransactions(@Param('userId') userId: string) {
    return this.tradesService.getUserTransactions(userId);
  }

  @Get('markup/aggregates')
  async getMarkupAggregates(@Req() req: any) {
    const userId = req.user.userId;
    return await this.tradesService.getMarkupAggregates(userId);
  }

  @Get('markup/daily')
  async getDailyMarkupData(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const userId = req.user.userId;
    let token: string | undefined = process.env.DERIV_READ_TOKEN;

    if (!token) {
      const derivInfo = await this.userRepository.getDerivInfo(userId);
      token = (derivInfo?.tokenReal || derivInfo?.tokenDemo) || undefined;
    }

    if (!token) throw new Error('Token de leitura ausente');

    // Datas default: últimos 30 dias
    let dateFrom: string;
    let dateTo: string;

    if (!startDate || !endDate) {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
      dateFrom = thirtyDaysAgo.toISOString().split('T')[0];
      dateTo = now.toISOString().split('T')[0];
    } else {
      dateFrom = startDate;
      dateTo = endDate;
    }

    const dateFromFormatted = dateFrom.includes(':') ? dateFrom : `${dateFrom} 00:00:00`;
    const dateToFormatted = dateTo.includes(':') ? dateTo : `${dateTo} 23:59:59`;

    const transactions = await this.markupService.getAppMarkupDetails(token, {
      date_from: dateFromFormatted,
      date_to: dateToFormatted
    });

    // Agrupar por dia
    const dailyMap = new Map<string, number>();

    transactions.forEach(tx => {
      // tx.transaction_time: "YYYY-MM-DD HH:MM:SS" (check format)
      // Deriv pode retornar epoch. A doc diz string "YYYY-MM-DD..." mas checkemos.
      // Assumindo string ou timestamp conversível
      let dateKey = '';
      if (typeof tx.transaction_time === 'number') {
        dateKey = new Date(tx.transaction_time * 1000).toISOString().split('T')[0];
      } else {
        dateKey = String(tx.transaction_time).split(' ')[0];
      }

      const amount = parseFloat(tx.app_markup_usd || tx.app_markup || 0);
      dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + amount);
    });

    // Converter para array
    const dailyData = Array.from(dailyMap.entries()).map(([date, markup]) => ({
      date,
      markup: parseFloat(markup.toFixed(2))
    }));

    // Ordenar por data
    dailyData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return dailyData;
  }

  @Sse('markup/stream')
  sse(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Observable<NestMessageEvent> {
    console.log(`[TradesController] SSE Markup Stream chamado - startDate: ${startDate}, endDate: ${endDate}`);
    return this.tradesService.getMarkupDataStream(startDate, endDate);
  }
}
