import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { UserSettingsEntity } from '../infrastructure/database/entities/user-settings.entity';
import { UserActivityLogEntity } from '../infrastructure/database/entities/user-activity-log.entity';
import { UserSessionEntity } from '../infrastructure/database/entities/user-session.entity';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    @InjectRepository(UserSettingsEntity)
    private readonly settingsRepository: Repository<UserSettingsEntity>,
    @InjectRepository(UserActivityLogEntity)
    private readonly activityLogRepository: Repository<UserActivityLogEntity>,
    @InjectRepository(UserSessionEntity)
    private readonly sessionRepository: Repository<UserSessionEntity>,
  ) {}

  async getSettings(userId: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    let settings = await this.settingsRepository.findOne({ where: { userId } });
    if (!settings) {
      // Criar configurações padrão se não existirem
      settings = this.settingsRepository.create({
        id: uuidv4(),
        userId,
        language: 'pt-BR',
        timezone: 'America/Sao_Paulo',
        emailNotifications: true,
        twoFactorEnabled: false,
      });
      await this.settingsRepository.save(settings);
    }

    return {
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      profilePictureUrl: settings.profilePictureUrl,
      language: settings.language,
      timezone: settings.timezone,
      emailNotifications: settings.emailNotifications,
      twoFactorEnabled: settings.twoFactorEnabled,
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
      emailNotifications?: boolean;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    let settings = await this.settingsRepository.findOne({ where: { userId } });
    if (!settings) {
      settings = this.settingsRepository.create({
        id: uuidv4(),
        userId,
        ...updates,
      });
    } else {
      Object.assign(settings, updates);
    }

    await this.settingsRepository.save(settings);

    // Log das mudanças
    const changes: string[] = [];
    if (updates.language) changes.push(`Alterou idioma para ${updates.language}`);
    if (updates.timezone) changes.push(`Alterou fuso horário para ${updates.timezone}`);
    if (updates.profilePictureUrl) changes.push('Atualizou foto de perfil');
    if (updates.emailNotifications !== undefined) {
      changes.push(`Alterou notificações por email para ${updates.emailNotifications ? 'ativado' : 'desativado'}`);
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
}

