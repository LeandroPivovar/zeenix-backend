import { Injectable, NotFoundException, BadRequestException, Inject, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN, DERIV_SERVICE } from '../constants/tokens';
import { UserSettingsEntity } from '../infrastructure/database/entities/user-settings.entity';
import { UserActivityLogEntity } from '../infrastructure/database/entities/user-activity-log.entity';
import { UserSessionEntity } from '../infrastructure/database/entities/user-session.entity';
import { AiService } from '../ai/ai.service';
import { AutonomousAgentService } from '../autonomous-agent/autonomous-agent.service';

const TRADE_CURRENCY_OPTIONS = ['USD', 'BTC', 'DEMO'] as const;
type TradeCurrency = (typeof TRADE_CURRENCY_OPTIONS)[number];

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    @InjectRepository(UserSettingsEntity)
    private readonly settingsRepository: Repository<UserSettingsEntity>,
    @InjectRepository(UserActivityLogEntity)
    private readonly activityLogRepository: Repository<UserActivityLogEntity>,
    @InjectRepository(UserSessionEntity)
    private readonly sessionRepository: Repository<UserSessionEntity>,
    @Inject(DERIV_SERVICE) private readonly derivService: any,
    @Inject(forwardRef(() => AiService))
    private readonly aiService: AiService,
    @Inject(forwardRef(() => AutonomousAgentService))
    private readonly autonomousAgentService: AutonomousAgentService,
  ) { }

  async getSettings(userId: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    let settings = await this.settingsRepository.findOne({ where: { userId } });
    if (!settings) {
      // Criar configurações padrão se não existirem
      const newSettings = this.settingsRepository.create({
        id: uuidv4(),
        userId,
        language: 'pt-BR',
        timezone: 'America/Sao_Paulo',
        tradeCurrency: 'USD',
        emailNotifications: true,
        twoFactorEnabled: false,
      });
      settings = await this.settingsRepository.save(newSettings);
    } else if (!settings.tradeCurrency) {
      settings.tradeCurrency = 'USD';
      await this.settingsRepository.save(settings);
    }

    return {
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      profilePictureUrl: settings.profilePictureUrl,
      language: settings.language,
      timezone: settings.timezone,
      tradeCurrency: settings.tradeCurrency ?? 'USD',
      emailNotifications: settings.emailNotifications,
      twoFactorEnabled: settings.twoFactorEnabled,
      traderMestre: user.traderMestre, // Expor se é trader mestre
      fictitiousBalance: settings.fictitiousBalance,
      isFictitiousBalanceActive: settings.isFictitiousBalanceActive,
      showDollarSign: settings.showDollarSign,
      // Broker specific account data
      tokenReal: user.tokenReal,
      tokenRealCurrency: user.tokenRealCurrency,
      realAmount: user.realAmount,
      tokenDemo: user.tokenDemo,
      tokenDemoCurrency: user.tokenDemoCurrency,
      demoAmount: user.demoAmount,
      idRealAccount: user.idRealAccount,
      idDemoAccount: user.idDemoAccount,
    };
  }

  async updateName(userId: string, newName: string, ipAddress?: string, userAgent?: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    if (!newName || newName.trim().length < 2) {
      throw new BadRequestException('Nome deve ter pelo menos 2 caracteres');
    }

    const oldName = user.name;
    const updatedUser = user.update(newName.trim(), user.email);
    await this.userRepository.update(updatedUser);
    await this.logActivity(userId, 'UPDATE_NAME', `Alterou o nome de "${oldName}" para "${newName.trim()}"`, ipAddress, userAgent);

    return { success: true, message: 'Nome atualizado com sucesso' };
  }

  async updateEmail(userId: string, newEmail: string, ipAddress?: string, userAgent?: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const existing = await this.userRepository.findByEmail(newEmail);
    if (existing && existing.id !== userId) {
      throw new BadRequestException('Este email já está em uso');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      throw new BadRequestException('Email inválido');
    }

    const oldEmail = user.email;
    const updatedUser = user.update(user.name, newEmail);
    await this.userRepository.update(updatedUser);
    await this.logActivity(userId, 'UPDATE_EMAIL', `Alterou o email de "${oldEmail}" para "${newEmail}"`, ipAddress, userAgent);

    return { success: true, message: 'Email atualizado com sucesso' };
  }

  async updatePassword(userId: string, currentPassword: string, newPassword: string, ipAddress?: string, userAgent?: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      throw new BadRequestException('Senha atual incorreta');
    }

    if (newPassword.length < 6) {
      throw new BadRequestException('Nova senha deve ter pelo menos 6 caracteres');
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    const updatedUser = user.changePassword(hashed);
    await this.userRepository.update(updatedUser);
    await this.logActivity(userId, 'UPDATE_PASSWORD', 'Alterou a senha', ipAddress, userAgent);

    return { success: true, message: 'Senha atualizada com sucesso' };
  }

  async updateSettings(
    userId: string,
    updates: {
      profilePictureUrl?: string;
      language?: string;
      timezone?: string;
      tradeCurrency?: TradeCurrency;
      emailNotifications?: boolean;
      fictitiousBalance?: number;
      isFictitiousBalanceActive?: boolean;
      showDollarSign?: boolean;
    },
    ipAddress?: string,
    userAgent?: string,
    activeContext?: 'ai' | 'agent' | 'all'
  ) {
    let settings = await this.settingsRepository.findOne({ where: { userId } });
    if (!settings) {
      const newSettings = this.settingsRepository.create({
        id: uuidv4(),
        userId,
        language: 'pt-BR',
        timezone: 'America/Sao_Paulo',
        tradeCurrency: 'USD',
        emailNotifications: true,
        twoFactorEnabled: false,
      });
      settings = await this.settingsRepository.save(newSettings);
    }

    const normalizedUpdates = { ...updates };
    const previousState = {
      language: settings.language,
      timezone: settings.timezone,
      tradeCurrency: settings.tradeCurrency,
      profilePictureUrl: settings.profilePictureUrl,
      emailNotifications: settings.emailNotifications,
    };

    if (normalizedUpdates.tradeCurrency) {
      normalizedUpdates.tradeCurrency = normalizedUpdates.tradeCurrency.toUpperCase() as TradeCurrency;
      if (!TRADE_CURRENCY_OPTIONS.includes(normalizedUpdates.tradeCurrency)) {
        throw new BadRequestException('Moeda padrão inválida');
      }
    }

    Object.assign(settings, normalizedUpdates);

    await this.settingsRepository.save(settings);

    // Log das mudanças
    const changes: string[] = [];

    if (
      normalizedUpdates.language &&
      normalizedUpdates.language !== previousState.language
    ) {
      changes.push(`Alterou idioma para ${normalizedUpdates.language}`);
    }

    if (
      normalizedUpdates.timezone &&
      normalizedUpdates.timezone !== previousState.timezone
    ) {
      changes.push(`Alterou fuso horário para ${normalizedUpdates.timezone}`);
    }

    if (
      normalizedUpdates.tradeCurrency &&
      normalizedUpdates.tradeCurrency !== previousState.tradeCurrency
    ) {
      changes.push(`Alterou moeda padrão para ${normalizedUpdates.tradeCurrency}`);

      // ✅ Desativar serviços de forma condicional (igual ao updateDerivToken)
      try {
        this.logger.log(`[SettingsService] Gerenciando desativação de serviços para ${userId} (Contexto: ${activeContext || 'ALL'})`);

        const promises: Promise<void>[] = [];

        // Se contexto for 'ai', desativar APENAS IA (Agente continua rodando na conta antiga)
        if (activeContext === 'ai') {
          promises.push(
            this.aiService.deactivateUserAI(userId).catch(e => this.logger.error(`Erro ao desativar IA: ${e.message}`))
          );
        }
        // Se contexto for 'agent', desativar APENAS Agente (IA continua rodando na conta antiga)
        else if (activeContext === 'agent') {
          promises.push(
            this.autonomousAgentService.deactivateAgent(userId).catch(e => this.logger.error(`Erro ao desativar Agente: ${e.message}`))
          );
        }
        // Fallback: Se não especificar contexto ou for 'all', desativar TUDO (Comportamento padrão/seguro)
        else {
          promises.push(
            this.aiService.deactivateUserAI(userId).catch(e => this.logger.error(`Erro ao desativar IA: ${e.message}`)),
            this.autonomousAgentService.deactivateAgent(userId).catch(e => this.logger.error(`Erro ao desativar Agente: ${e.message}`))
          );
        }

        await Promise.all(promises);

      } catch (e) {
        this.logger.error(`[SettingsService] Erro ao desativar serviços: ${e.message}`);
      }

      // Atualizar também a coluna deriv_currency na tabela users
      // Se for DEMO, manter a moeda base (USD) na deriv_currency
      const currencyForDeriv = normalizedUpdates.tradeCurrency === 'DEMO' ? 'USD' : normalizedUpdates.tradeCurrency;

      // Buscar o loginId atual para não sobrescrever
      const currentDerivInfo = await this.userRepository.getDerivInfo(userId);
      let targetLoginId = currentDerivInfo?.loginId || userId;
      let targetBalance: number | undefined = currentDerivInfo?.balance ? parseFloat(currentDerivInfo.balance) : undefined;

      // ✅ FIX: Resolver LoginID e Saldo corretos com base no modo (DEMO vs REAL)
      if (currentDerivInfo?.raw) {
        try {
          const rawData = typeof currentDerivInfo.raw === 'string'
            ? JSON.parse(currentDerivInfo.raw)
            : currentDerivInfo.raw;

          const accountList = rawData?.authorize?.account_list;

          if (Array.isArray(accountList)) {
            let foundAccount: any = null;

            if (normalizedUpdates.tradeCurrency === 'DEMO') {
              // Buscar conta Demo (Virtual)
              foundAccount = accountList.find((acc: any) => acc.is_virtual === 1 || acc.is_virtual === true);
            } else {
              // Buscar conta Real com a moeda específica
              foundAccount = accountList.find((acc: any) =>
                (acc.is_virtual === 0 || acc.is_virtual === false) &&
                acc.currency === normalizedUpdates.tradeCurrency
              );
            }

            if (foundAccount) {
              targetLoginId = foundAccount.loginid;
              // Atualizar saldo se disponível na lista
              if (foundAccount.balance !== undefined) {
                targetBalance = parseFloat(foundAccount.balance);
              }
              this.logger.log(`[SettingsService] Conta alterada para: ${targetLoginId} (${normalizedUpdates.tradeCurrency}) | Saldo: ${targetBalance}`);
            } else {
              this.logger.warn(`[SettingsService] Nenhuma conta compatível encontrada para ${normalizedUpdates.tradeCurrency}. Mantendo LoginID anterior.`);
            }
          }
        } catch (e) {
          this.logger.error(`[SettingsService] Erro ao resolver conta Deriv:`, e);
        }
      }

      // Atualizar deriv_currency na tabela users
      this.logger.log(`[SettingsService] Atualizando deriv_currency para ${currencyForDeriv} na tabela users para userId: ${userId}`);
      await this.userRepository.updateDerivInfo(userId, {
        loginId: targetLoginId,
        currency: currencyForDeriv,
        balance: targetBalance,
        raw: currentDerivInfo?.raw,
      });

      // Invalidar cache do DerivService para forçar reconexão com os novos dados
      if (this.derivService && typeof this.derivService.clearSession === 'function') {
        this.derivService.clearSession(userId);
      }

      this.logger.log(`[SettingsService] deriv_currency atualizado com sucesso e sessão invalidada`);
    }

    if (
      normalizedUpdates.profilePictureUrl &&
      normalizedUpdates.profilePictureUrl !== previousState.profilePictureUrl
    ) {
      changes.push('Atualizou foto de perfil');
    }

    if (
      normalizedUpdates.emailNotifications !== undefined &&
      normalizedUpdates.emailNotifications !== previousState.emailNotifications
    ) {
      changes.push(
        `Alterou notificações por email para ${normalizedUpdates.emailNotifications ? 'ativado' : 'desativado'
        }`,
      );
    }

    if (changes.length > 0) {
      await this.logActivity(userId, 'UPDATE_SETTINGS', changes.join(', '), ipAddress, userAgent);
    }

    return { success: true, message: 'Configurações atualizadas com sucesso' };
  }

  async getActivityLogs(userId: string, limit: number = 20) {
    const logs = await this.activityLogRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return logs.map(log => ({
      id: log.id,
      action: log.action,
      description: log.description,
      createdAt: log.createdAt,
    }));
  }

  async getSessions(userId: string) {
    const sessions = await this.sessionRepository.find({
      where: { userId },
      order: { lastActivity: 'DESC' },
    });

    return sessions.map(session => ({
      id: session.id,
      device: session.device,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
    }));
  }

  async getLastLogin(userId: string) {
    const sessions = await this.sessionRepository.find({
      where: { userId },
      order: { lastActivity: 'DESC' },
      take: 1,
    });

    return sessions[0] || null;
  }

  async endAllSessions(userId: string, currentToken?: string, ipAddress?: string, userAgent?: string) {
    // Deletar todas as sessões exceto a atual se o token for fornecido
    if (currentToken) {
      const allSessions = await this.sessionRepository.find({ where: { userId } });
      const sessionsToDelete = allSessions.filter(s => s.token !== currentToken);
      if (sessionsToDelete.length > 0) {
        await this.sessionRepository.remove(sessionsToDelete);
      }
    } else {
      await this.sessionRepository.delete({ userId });
    }

    await this.logActivity(userId, 'END_ALL_SESSIONS', 'Encerrou todas as sessões', ipAddress, userAgent);
    return { success: true, message: 'Todas as sessões foram encerradas' };
  }

  async logActivity(
    userId: string,
    action: string,
    description: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const log = this.activityLogRepository.create({
      id: uuidv4(),
      userId,
      action,
      description,
      ipAddress,
      userAgent,
    });
    await this.activityLogRepository.save(log);
  }

  async createSession(
    userId: string,
    token: string,
    device?: string,
    userAgent?: string,
    ipAddress?: string,
  ) {
    const session = this.sessionRepository.create({
      id: uuidv4(),
      userId,
      token,
      device,
      userAgent,
      ipAddress,
    });
    await this.sessionRepository.save(session);
    return session;
  }

  async updateSessionActivity(token: string) {
    await this.sessionRepository.update(
      { token },
      { lastActivity: new Date() },
    );
  }

  async updateDerivToken(
    userId: string,
    derivToken: string,
    tradeCurrency: string,
    ipAddress?: string,
    userAgent?: string,
    activeContext?: 'ai' | 'agent' | 'all'
  ) {
    this.logger.log(`[SettingsService] updateDerivToken para usuário ${userId}, currency: ${tradeCurrency}, context: ${activeContext || 'all'}`);

    const isDemo = tradeCurrency === 'DEMO';
    const updateData: any = {};

    if (isDemo) {
      updateData.tokenDemo = derivToken;
      updateData.tokenDemoCurrency = 'USD'; // Padrão demo
    } else {
      updateData.tokenReal = derivToken;
      updateData.tokenRealCurrency = tradeCurrency !== 'DEMO' ? tradeCurrency : 'USD';
    }

    // Se for real e não "DEMO", também atualizamos a derivCurrency
    if (!isDemo) {
      updateData.currency = tradeCurrency;
    }

    await this.userRepository.updateDerivInfo(userId, updateData);

    // Atualizar também a tabela de configurações para persistir a escolha
    let settings = await this.settingsRepository.findOne({ where: { userId } });
    if (settings) {
      if (TRADE_CURRENCY_OPTIONS.includes(tradeCurrency as any)) {
        settings.tradeCurrency = tradeCurrency as TradeCurrency;
        await this.settingsRepository.save(settings);
      }
    }

    // Invalidar cache do DerivService
    if (this.derivService && typeof this.derivService.clearSession === 'function') {
      this.derivService.clearSession(userId);
    }

    // ✅ Desativar serviços de forma condicional
    try {
      this.logger.log(`[SettingsService] Gerenciando desativação de serviços para ${userId} (Contexto: ${activeContext || 'ALL'})`);

      const promises: Promise<void>[] = [];

      // Se contexto for 'ai', desativar APENAS IA (Agente continua rodando na conta antiga)
      if (activeContext === 'ai') {
        promises.push(
          this.aiService.deactivateUserAI(userId).catch(e => this.logger.error(`Erro ao desativar IA: ${e.message}`))
        );
      }
      // Se contexto for 'agent', desativar APENAS Agente (IA continua rodando na conta antiga)
      else if (activeContext === 'agent') {
        promises.push(
          this.autonomousAgentService.deactivateAgent(userId).catch(e => this.logger.error(`Erro ao desativar Agente: ${e.message}`))
        );
      }
      // Fallback: Se não especificar contexto ou for 'all', desativar TUDO (Comportamento padrão/seguro)
      else {
        promises.push(
          this.aiService.deactivateUserAI(userId).catch(e => this.logger.error(`Erro ao desativar IA: ${e.message}`)),
          this.autonomousAgentService.deactivateAgent(userId).catch(e => this.logger.error(`Erro ao desativar Agente: ${e.message}`))
        );
      }

      await Promise.all(promises);

    } catch (e) {
      this.logger.error(`[SettingsService] Erro ao desativar serviços: ${e.message}`);
    }

    await this.logActivity(userId, 'UPDATE_DERIV_TOKEN', `Atualizou token Deriv para ${tradeCurrency}`, ipAddress, userAgent);

    return { success: true, message: 'Token Deriv atualizado com sucesso' };
  }
}

