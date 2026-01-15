import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull, In, DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { UserEntity } from '../../infrastructure/database/entities/user.entity';
import { PlanEntity } from '../../infrastructure/database/entities/plan.entity';
import { UserActivityLogEntity } from '../../infrastructure/database/entities/user-activity-log.entity';
import { ExpertEntity } from '../../infrastructure/database/entities/expert.entity';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
    @InjectRepository(UserActivityLogEntity)
    private readonly activityLogRepository: Repository<UserActivityLogEntity>,
    @InjectRepository(ExpertEntity)
    private readonly expertRepository: Repository<ExpertEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Retorna estatísticas gerais para o painel de admin
   */
  async getAdminStatistics() {
    // Buscar total de usuários ativos (que têm plano)
    const totalUsers = await this.userRepository.count();
    const activeUsersCount = await this.userRepository.count({
      where: {
        planId: Not(IsNull() as any),
      },
    });

    // Buscar admins ativos (usuários com role de admin e isActive = true)
    const activeAdminsCount = await this.userRepository.count({
      where: {
        role: In(['admin', 'super_admin', 'editor', 'suporte', 'visualizador']),
        isActive: true,
      },
    });

    // Buscar IAs em operação (usuários com IA ativa)
    const iasInOperationResult = await this.dataSource.query(
      'SELECT COUNT(*) as count FROM ai_user_config WHERE is_active = TRUE',
    );
    const iasInOperation = parseInt(iasInOperationResult[0]?.count || '0', 10);

    // Buscar experts cadastrados
    const registeredExpertsCount = await this.expertRepository.count();

    // Buscar volume gerenciado (soma dos saldos de contas não-demo)
    const managedVolume = await this.getManagedVolume();

    // Buscar usuários com planos ativos
    const usersWithActivePlans = await this.userRepository.count({
      where: {
        planId: Not(IsNull() as any),
        planActivatedAt: Not(IsNull() as any),
      },
    });

    // Estatísticas básicas
    return {
      activeAdmins: activeAdminsCount,
      activeUsers: activeUsersCount,
      iasInOperation: iasInOperation,
      registeredExperts: registeredExpertsCount,
      totalUsers,
      usersWithActivePlans,
      managedVolume: managedVolume.total,
      managedVolumeFormatted: managedVolume.totalFormatted,
      managedVolumeByCurrency: managedVolume.byCurrency,
      totalCommission: managedVolume.estimatedCommission,
      totalCommissionFormatted: managedVolume.estimatedCommissionFormatted,
    };
  }

  /**
   * Retorna lista de usuários que NÃO estão com conta demo
   */
  async getNonDemoUsers() {
    const users = await this.userRepository.find({
      relations: ['plan'],
      select: [
        'id',
        'name',
        'email',
        'derivLoginId',
        'derivCurrency',
        'derivBalance',
        'planId',
        'planActivatedAt',
        'createdAt',
      ],
    });

    // Filtrar usuários que não estão usando conta demo
    const nonDemoUsers = users.filter((user) => {
      // Se derivCurrency for 'DEMO', é conta demo
      if (user.derivCurrency === 'DEMO') {
        return false;
      }

      // Se derivRaw existir, verificar se é demo
      if (user.derivRaw) {
        try {
          const rawData =
            typeof user.derivRaw === 'string'
              ? JSON.parse(user.derivRaw)
              : user.derivRaw;

          // Verificar se é conta demo no derivRaw
          if (rawData.isDemo === true || rawData.demo_account === 1) {
            return false;
          }
        } catch (e) {
          // Se houver erro ao parsear, continuar com a verificação
        }
      }

      // Se não tem derivLoginId, não está conectado à Deriv
      // Considerar como não-demo (usuário ainda não configurou)
      return true;
    });

    return nonDemoUsers.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      derivLoginId: user.derivLoginId,
      currency: user.derivCurrency,
      balance: user.derivBalance ? parseFloat(user.derivBalance) : 0,
      plan: user.plan?.name || 'Sem plano',
      planActivatedAt: user.planActivatedAt,
      createdAt: user.createdAt,
    }));
  }

  /**
   * Calcula o volume total gerenciado (soma dos saldos das contas não-demo)
   */
  async getManagedVolume() {
    const users = await this.userRepository.find({
      select: ['id', 'derivCurrency', 'derivBalance', 'derivRaw'],
    });

    let totalVolume = 0;
    const volumeByCurrency: Record<string, number> = {};

    for (const user of users) {
      // Ignorar contas demo
      if (user.derivCurrency === 'DEMO') {
        continue;
      }

      // Verificar no derivRaw se é demo
      let isDemo = false;
      if (user.derivRaw) {
        try {
          const rawData =
            typeof user.derivRaw === 'string'
              ? JSON.parse(user.derivRaw)
              : user.derivRaw;

          if (rawData.isDemo === true || rawData.demo_account === 1) {
            isDemo = true;
          }
        } catch (e) {
          // Continuar se houver erro
        }
      }

      if (isDemo) {
        continue;
      }

      // Somar saldo
      if (user.derivBalance && user.derivCurrency) {
        const balance = parseFloat(user.derivBalance);
        if (!isNaN(balance) && balance > 0) {
          const currency = user.derivCurrency.toUpperCase();

          // Adicionar ao total por moeda
          if (!volumeByCurrency[currency]) {
            volumeByCurrency[currency] = 0;
          }
          volumeByCurrency[currency] += balance;

          // Converter para USD aproximadamente para o total
          // (considerando valores aproximados de conversão)
          const usdValue = this.convertToUSD(balance, currency);
          totalVolume += usdValue;
        }
      }
    }

    // Calcular comissão estimada (assumindo markup médio de 2%)
    const estimatedCommission = totalVolume * 0.02;

    return {
      total: totalVolume,
      totalFormatted: this.formatCurrency(totalVolume, 'USD'),
      byCurrency: volumeByCurrency,
      estimatedCommission,
      estimatedCommissionFormatted: this.formatCurrency(
        estimatedCommission,
        'USD',
      ),
    };
  }

  /**
   * Converte valor para USD (aproximadamente)
   */
  private convertToUSD(amount: number, currency: string): number {
    const rates: Record<string, number> = {
      USD: 1,
      EUR: 1.1,
      GBP: 1.27,
      BTC: 50000,
      ETH: 3000,
      BRL: 0.2,
    };

    return amount * (rates[currency] || 1);
  }

  /**
   * Formata valor monetário
   */
  private formatCurrency(amount: number, currency: string): string {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(1)}M`;
    } else if (amount >= 1000) {
      return `${(amount / 1000).toFixed(1)}K`;
    }
    return amount.toFixed(2);
  }

  /**
   * Retorna lista de administradores do sistema
   */
  async getAdministrators() {
    const admins = await this.userRepository.find({
      where: {
        role: In(['admin', 'super_admin', 'editor', 'suporte', 'visualizador']),
      },
      select: [
        'id',
        'name',
        'email',
        'role',
        'isActive',
        'lastLoginAt',
        'createdAt',
      ],
      order: {
        createdAt: 'DESC',
      },
    });

    return admins.map((admin) => ({
      id: admin.id,
      name: admin.name,
      email: admin.email,
      permission: this.formatPermissionName(admin.role),
      lastLogin: admin.lastLoginAt
        ? this.formatDateTime(admin.lastLoginAt)
        : 'Nunca',
      status: admin.isActive ? 'Ativo' : 'Inativo',
      createdAt: admin.createdAt,
    }));
  }

  /**
   * Cria um novo administrador
   */
  async createAdministrator(data: {
    name: string;
    email: string;
    permission: string;
    password?: string;
  }) {
    // Verificar se email já existe
    const existing = await this.userRepository.findOne({
      where: { email: data.email },
    });

    if (existing) {
      throw new ConflictException('Email já está em uso');
    }

    // Mapear permissão para role
    const role = this.mapPermissionToRole(data.permission);

    // Gerar senha padrão se não fornecida
    const password = data.password || this.generateRandomPassword();
    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = this.userRepository.create({
      id: uuidv4(),
      name: data.name,
      email: data.email,
      password: hashedPassword,
      role: role,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await this.userRepository.save(admin);

    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      permission: this.formatPermissionName(admin.role),
      lastLogin: 'Nunca',
      status: 'Ativo',
      tempPassword: data.password ? undefined : password, // Retorna senha temporária se gerada
    };
  }

  /**
   * Atualiza um administrador
   */
  async updateAdministrator(
    id: string,
    data: {
      name?: string;
      email?: string;
      permission?: string;
    },
  ) {
    const admin = await this.userRepository.findOne({ where: { id } });

    if (!admin) {
      throw new NotFoundException('Administrador não encontrado');
    }

    if (data.email && data.email !== admin.email) {
      const existing = await this.userRepository.findOne({
        where: { email: data.email },
      });
      if (existing) {
        throw new ConflictException('Email já está em uso');
      }
      admin.email = data.email;
    }

    if (data.name) {
      admin.name = data.name;
    }

    if (data.permission) {
      admin.role = this.mapPermissionToRole(data.permission);
    }

    admin.updatedAt = new Date();
    await this.userRepository.save(admin);

    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      permission: this.formatPermissionName(admin.role),
      lastLogin: admin.lastLoginAt
        ? this.formatDateTime(admin.lastLoginAt)
        : 'Nunca',
      status: admin.isActive ? 'Ativo' : 'Inativo',
    };
  }

  /**
   * Alterna status ativo/inativo de um administrador
   */
  async toggleAdministratorStatus(id: string) {
    const admin = await this.userRepository.findOne({ where: { id } });

    if (!admin) {
      throw new NotFoundException('Administrador não encontrado');
    }

    admin.isActive = !admin.isActive;
    admin.updatedAt = new Date();
    await this.userRepository.save(admin);

    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      permission: this.formatPermissionName(admin.role),
      lastLogin: admin.lastLoginAt
        ? this.formatDateTime(admin.lastLoginAt)
        : 'Nunca',
      status: admin.isActive ? 'Ativo' : 'Inativo',
    };
  }

  /**
   * Exclui um administrador
   */
  async deleteAdministrator(id: string) {
    const admin = await this.userRepository.findOne({ where: { id } });

    if (!admin) {
      throw new NotFoundException('Administrador não encontrado');
    }

    // Verificar se não é o único super admin
    if (admin.role === 'super_admin') {
      const superAdminsCount = await this.userRepository.count({
        where: { role: 'super_admin' },
      });

      if (superAdminsCount <= 1) {
        throw new BadRequestException(
          'Não é possível excluir o único Super Admin do sistema',
        );
      }
    }

    await this.userRepository.remove(admin);

    return {
      message: 'Administrador excluído com sucesso',
      id: id,
    };
  }

  /**
   * Mapeia nome de permissão para role no banco
   */
  private mapPermissionToRole(permission: string): string {
    const roleMap: Record<string, string> = {
      'Super Admin': 'super_admin',
      Editor: 'editor',
      Suporte: 'suporte',
      Visualizador: 'visualizador',
    };

    return roleMap[permission] || 'editor';
  }

  /**
   * Formata role do banco para nome de permissão
   */
  private formatPermissionName(role: string): string {
    const permissionMap: Record<string, string> = {
      super_admin: 'Super Admin',
      admin: 'Admin',
      editor: 'Editor',
      suporte: 'Suporte',
      visualizador: 'Visualizador',
    };

    return permissionMap[role] || 'Editor';
  }

  /**
   * Formata data e hora para exibição
   */
  private formatDateTime(date: Date): string {
    if (!date) return 'Nunca';

    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Gera senha aleatória
   */
  private generateRandomPassword(): string {
    const length = 12;
    const charset =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return password;
  }

  /**
   * Retorna logs de atividade do sistema com paginação
   */
  async getActivityLogs(page: number = 1, limit: number = 10) {
    // Garantir valores mínimos
    page = Math.max(1, page);
    limit = Math.min(Math.max(1, limit), 100); // Máximo 100 por página

    const skip = (page - 1) * limit;

    // Buscar total de registros
    const total = await this.activityLogRepository.count();

    // Buscar logs paginados
    const logs = await this.activityLogRepository.find({
      relations: ['user'],
      order: {
        createdAt: 'DESC',
      },
      skip: skip,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);

    return {
      data: logs.map((log) => ({
        id: log.id,
        dateTime: this.formatDateTime(log.createdAt),
        action: this.formatActionDescription(log.action, log.description),
        user: log.user?.name || 'Sistema',
        ip: log.ipAddress || 'N/A',
        result: this.determineLogResult(log.action, log.description),
        createdAt: log.createdAt,
      })),
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: total,
        recordsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Formata a descrição da ação para exibição
   */
  private formatActionDescription(action: string, description: string): string {
    // Se a descrição for mais descritiva, usar ela
    if (description && description.length > action.length) {
      return description;
    }

    // Mapear ações comuns para descrições amigáveis
    const actionMap: Record<string, string> = {
      LOGIN: 'Login no sistema',
      LOGOUT: 'Logout do sistema',
      UPDATE_PROFILE: 'Atualizou perfil',
      CHANGE_PASSWORD: 'Alterou senha',
      CONNECT_DERIV: 'Conectou conta Deriv',
      DISCONNECT_DERIV: 'Desconectou conta Deriv',
      ACTIVATE_PLAN: 'Ativou plano',
      DEACTIVATE_PLAN: 'Desativou plano',
      CREATE_ADMIN: 'Criou novo administrador',
      UPDATE_ADMIN: 'Atualizou administrador',
      DELETE_ADMIN: 'Excluiu administrador',
      TOGGLE_ADMIN_STATUS: 'Alterou status de administrador',
      EXPORT_LOGS: 'Exportou logs do sistema',
    };

    return actionMap[action] || description || action;
  }

  /**
   * Determina o resultado da ação (Sucesso ou Falha)
   */
  private determineLogResult(action: string, description: string): string {
    // Verificar palavras-chave que indicam falha
    const failureKeywords = [
      'falha',
      'erro',
      'failed',
      'error',
      'negado',
      'denied',
      'inválido',
      'invalid',
    ];

    const lowerAction = action.toLowerCase();
    const lowerDescription = description.toLowerCase();

    const hasFailed = failureKeywords.some(
      (keyword) =>
        lowerAction.includes(keyword) || lowerDescription.includes(keyword),
    );

    return hasFailed ? 'Falha' : 'Sucesso';
  }
}
