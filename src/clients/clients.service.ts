import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { UserSessionEntity } from '../infrastructure/database/entities/user-session.entity';
import { ClientMetricsDto } from './dto/client-metrics.dto';
import { ClientDto, ClientListResponseDto } from './dto/client-list.dto';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserSessionEntity)
    private readonly sessionRepository: Repository<UserSessionEntity>,
  ) {}

  async getMetrics(): Promise<ClientMetricsDto> {
    const now = new Date();
    
    // Data de início de hoje (00:00:00)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Data de início da semana (segunda-feira)
    const startOfWeek = new Date(now);
    const dayOfWeek = startOfWeek.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Ajusta para segunda-feira
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);
    
    // Data de início do mês
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Total de usuários
    const total = await this.userRepository.count();

    // Usuários com conta Deriv conectada
    const realAccountUsed = await this.userRepository
      .createQueryBuilder('user')
      .where('user.derivLoginId IS NOT NULL')
      .getCount();

    // Novos usuários hoje
    const newToday = await this.userRepository
      .createQueryBuilder('user')
      .where('user.createdAt >= :startOfToday', { startOfToday })
      .getCount();

    // Novos usuários esta semana
    const newThisWeek = await this.userRepository
      .createQueryBuilder('user')
      .where('user.createdAt >= :startOfWeek', { startOfWeek })
      .getCount();

    // Novos usuários este mês
    const newThisMonth = await this.userRepository
      .createQueryBuilder('user')
      .where('user.createdAt >= :startOfMonth', { startOfMonth })
      .getCount();

    // Usuários ativos esta semana (com sessão ativa)
    const activeThisWeek = await this.sessionRepository
      .createQueryBuilder('session')
      .select('COUNT(DISTINCT session.userId)', 'count')
      .where('session.lastActivity >= :startOfWeek', { startOfWeek })
      .getRawOne()
      .then(result => parseInt(result.count) || 0);

    // Usuários ativos este mês
    const activeThisMonth = await this.sessionRepository
      .createQueryBuilder('session')
      .select('COUNT(DISTINCT session.userId)', 'count')
      .where('session.lastActivity >= :startOfMonth', { startOfMonth })
      .getRawOne()
      .then(result => parseInt(result.count) || 0);

    // Usuários com saldo < $100
    const balanceLess100 = await this.userRepository
      .createQueryBuilder('user')
      .where('user.derivBalance IS NOT NULL')
      .andWhere('CAST(user.derivBalance AS DECIMAL) < 100')
      .getCount();

    // Usuários com saldo > $500
    const balanceMore500 = await this.userRepository
      .createQueryBuilder('user')
      .where('user.derivBalance IS NOT NULL')
      .andWhere('CAST(user.derivBalance AS DECIMAL) > 500')
      .getCount();

    // Usuários com saldo > $1000
    const balanceMore1000 = await this.userRepository
      .createQueryBuilder('user')
      .where('user.derivBalance IS NOT NULL')
      .andWhere('CAST(user.derivBalance AS DECIMAL) > 1000')
      .getCount();

    // Usuários com saldo > $5000
    const balanceMore5000 = await this.userRepository
      .createQueryBuilder('user')
      .where('user.derivBalance IS NOT NULL')
      .andWhere('CAST(user.derivBalance AS DECIMAL) > 5000')
      .getCount();

    return {
      total,
      realAccountUsed,
      newToday,
      newThisWeek,
      newThisMonth,
      activeThisWeek,
      activeThisMonth,
      balanceLess100,
      balanceMore500,
      balanceMore1000,
      balanceMore5000,
    };
  }

  async getClients(search?: string, balanceFilter?: string): Promise<ClientListResponseDto> {
    let query = this.userRepository
      .createQueryBuilder('user')
      .select([
        'user.id as userId',
        'user.name as userName',
        'user.email as userEmail',
        'user.derivLoginId as derivLoginId',
        'user.derivBalance as derivBalance',
        'user.createdAt as createdAt',
      ]);

    // Filtro de busca por nome, email ou login ID
    if (search) {
      query = query.where(
        '(user.name LIKE :search OR user.email LIKE :search OR user.derivLoginId LIKE :search)',
        { search: `%${search}%` }
      );
    }

    // Filtro de saldo
    if (balanceFilter) {
      const filterCondition = search ? 'andWhere' : 'where';
      switch (balanceFilter) {
        case 'less100':
          query = query[filterCondition]('user.derivBalance IS NOT NULL AND CAST(user.derivBalance AS DECIMAL) < 100');
          break;
        case 'more500':
          query = query[filterCondition]('user.derivBalance IS NOT NULL AND CAST(user.derivBalance AS DECIMAL) > 500');
          break;
        case 'more1000':
          query = query[filterCondition]('user.derivBalance IS NOT NULL AND CAST(user.derivBalance AS DECIMAL) > 1000');
          break;
        case 'more5000':
          query = query[filterCondition]('user.derivBalance IS NOT NULL AND CAST(user.derivBalance AS DECIMAL) > 5000');
          break;
      }
    }

    const users = await query.getRawMany();

    // Calcular tempo gasto por usuário (soma de todas as sessões)
    const clients: ClientDto[] = await Promise.all(
      users.map(async (user) => {
        // Calcular tempo total gasto nas sessões
        const sessions = await this.sessionRepository
          .createQueryBuilder('session')
          .where('session.userId = :userId', { userId: user.userId })
          .orderBy('session.createdAt', 'ASC')
          .getMany();

        let totalMinutes = 0;
        let lastActivity = '-';
        
        // Estimar tempo gasto baseado nas sessões
        for (const session of sessions) {
          const sessionStart = new Date(session.createdAt);
          const sessionEnd = new Date(session.lastActivity);
          const diffMs = sessionEnd.getTime() - sessionStart.getTime();
          totalMinutes += Math.floor(diffMs / 1000 / 60);
        }

        // Obter última atividade
        if (sessions.length > 0) {
          const latestSession = sessions.reduce((latest, current) => 
            new Date(current.lastActivity) > new Date(latest.lastActivity) ? current : latest
          );
          lastActivity = new Date(latestSession.lastActivity).toISOString().split('T')[0];
        }

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const timeSpent = `${hours}h ${minutes}m`;

        return {
          userId: user.userId,
          name: user.userName,
          loginId: user.derivLoginId || '-',
          email: user.userEmail,
          balance: parseFloat(user.derivBalance || '0'),
          timeSpent,
          createdAt: new Date(user.createdAt).toISOString().split('T')[0],
          lastActivity,
          whatsapp: false, // Pode ser adicionado posteriormente
        };
      })
    );

    return {
      clients,
      total: clients.length,
    };
  }

  async exportClients(): Promise<any[]> {
    const { clients } = await this.getClients();
    return clients;
  }
}

