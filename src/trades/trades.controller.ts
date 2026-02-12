import { Controller, Get, Post, Body, UseGuards, Req, Query, Sse, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsEnum, IsNumber, Min, Max, IsOptional } from 'class-validator';
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
    @Query('targetUserId') targetUserId?: string, // Mantido por compatibilidade, mas não usado na API Deriv diretamente
  ) {
    // 1. Obter Token da Deriv (Admin ou Usuário)
    // Para app_markup_details, idealmente usamos o token da conta que criou o App (Admin/Dono)
    // Se não tivermos um token global, tentamos usar o token do usuário logado se ele for admin?
    // ou assumimos que o usuário logado TEM permissão de ler markup do App?
    // A documentação diz: "sua aplicação precisará de autenticação... API Key... escopo read"
    // Vamos tentar usar o token do usuário logado.

    const userId = req.user.userId;
    const user = await this.userRepository.findById(userId);

    // TODO: Idealmente, teríamos um token de sistema no .env ou banco para ler markup global
    // Por enquanto, vou tentar usar o token REAL do usuário logado (assumindo que ele é dono do App ou tem permissão)
    // SE não funcionar, precisaremos configurar um token específico no .env (DERIV_READ_TOKEN)

    let token: string | undefined = process.env.DERIV_READ_TOKEN; // Novo token específico para leitura

    if (!token) {
      // Fallback: tentar token do usuário logado (pode falhar se não for dono do App)
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
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0); // Ultimo dia do mês
      dateFrom = firstDay.toISOString().split('T')[0];
      dateTo = lastDay.toISOString().split('T')[0];
    } else {
      dateFrom = startDate;
      dateTo = endDate;
    }

    // Adicionar hora para formato API (00:00:00 - 23:59:59) se enviado apenas YYYY-MM-DD
    const dateFromFormatted = dateFrom.includes(':') ? dateFrom : `${dateFrom} 00:00:00`;
    const dateToFormatted = dateTo.includes(':') ? dateTo : `${dateTo} 23:59:59`;

    console.log(`[TradesController] getMarkupData chamado. Token presente? ${!!token}. Datas: ${dateFromFormatted} - ${dateToFormatted}`);

    try {
      // 3. Buscar dados na API da Deriv
      console.log(`[TradesController] Chamando markupService.getAppMarkupDetails...`);
      const transactions = await this.markupService.getAppMarkupDetails(token, {
        date_from: dateFromFormatted,
        date_to: dateToFormatted
      });
      console.log(`[TradesController] Retorno de markupService: ${transactions?.length} transações.`);

      // 4. Processar/Agrupar dados por usuário (client_loginid)
      const markupByLoginId = new Map<string, {
        markup: number,
        transactions: number,
        loginid: string
      }>();

      // Mapa auxiliar para loginid -> userId/Name (precisamos buscar do banco local)
      // Isso pode ser custoso se tivermos muitos usuários.
      // Melhor buscar todos usuários com conta real do banco e fazer map.
      const allUsers = await this.userRepository.findAll();
      const loginToUserMap = new Map();

      allUsers.forEach(u => {
        if (u.idRealAccount) loginToUserMap.set(u.idRealAccount, u);
        if (u.idDemoAccount) loginToUserMap.set(u.idDemoAccount, u); // Apenas fallback
      });

      let totalCommission = 0;
      let totalTransactions = 0;

      transactions.forEach(tx => {
        const loginid = tx.client_loginid;
        const amount = parseFloat(tx.markup_amount || 0);

        if (!markupByLoginId.has(loginid)) {
          markupByLoginId.set(loginid, { markup: 0, transactions: 0, loginid });
        }
        const entry = markupByLoginId.get(loginid)!;
        entry.markup += amount;
        entry.transactions += 1;

        totalCommission += amount;
        totalTransactions += 1;
      });

      // 5. Formatar resposta compatível com frontend
      const formattedUsers = Array.from(markupByLoginId.values()).map(entry => {
        const user = loginToUserMap.get(entry.loginid);
        const userMarkup = parseFloat(entry.markup.toFixed(2));

        // Estimar payout e volume baseado no markup (se markup for 3% do payout)
        // Payout ~= Markup / 0.03
        const estimatedPayout = userMarkup / 0.03;

        return {
          userId: user?.id || `unknown-${entry.loginid}`,
          name: user?.name || `Usuário Deriv (${entry.loginid})`,
          email: user?.email || 'N/A',
          whatsapp: user?.phone || null,
          country: 'Brasil', // Não vem na tx, assumir default ou pegar do user
          loginid: entry.loginid,
          transactionCount: entry.transactions,
          commission: userMarkup,
          realAmount: parseFloat(user?.realAmount || 0), // Saldo atual do banco local
          totalPayout: parseFloat(estimatedPayout.toFixed(2)), // Estimado

          // Estrutura frontend
          breakdown: {
            manual: { payout: 0, count: 0 },
            ia: { payout: estimatedPayout, count: entry.transactions }, // Atribuir tudo a IA/Geral por enquanto
            agent: { payout: 0, count: 0 },
            copy: { payout: 0, count: 0 }
          },
          realData: true,
          role: user?.role || 'user',
          traderMestre: user?.traderMestre || false,
          isDerivApi: true // Flag para debug
        };
      });

      // Ordenar por comissão
      formattedUsers.sort((a, b) => b.commission - a.commission);

      return {
        users: formattedUsers,
        summary: {
          totalCommission: parseFloat(totalCommission.toFixed(2)),
          totalPayout: parseFloat((totalCommission / 0.03).toFixed(2)), // Estimado
          totalTransactions: totalTransactions,
          totalUsers: formattedUsers.length,
          usersWithMarkup: formattedUsers.filter(u => u.commission > 0).length,
          usersWithoutMarkup: 0, // Difícil saber sem cruzar todos usuários
        },
        period: {
          from: dateFrom,
          to: dateTo
        }
      };

    } catch (error) {
      console.error('[TradesController] Erro ao buscar markup da API Deriv:', error);
      throw error;
    }
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

      const amount = parseFloat(tx.markup_amount || 0);
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
  ): Observable<MessageEvent> {
    console.log(`[TradesController] SSE Markup Stream chamado - startDate: ${startDate}, endDate: ${endDate}`);
    return this.tradesService.getMarkupDataStream(startDate, endDate);
  }
}
