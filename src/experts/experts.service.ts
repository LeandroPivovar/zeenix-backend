import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExpertEntity } from '../infrastructure/database/entities/expert.entity';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ExpertsService {
  constructor(
    @InjectRepository(ExpertEntity)
    private readonly expertRepository: Repository<ExpertEntity>,
  ) {}

  async findAll() {
    const experts = await this.expertRepository.find({
      order: { rating: 'DESC', createdAt: 'DESC' },
    });

    return experts.map((expert) => this.formatExpert(expert));
  }

  async findById(id: string) {
    const expert = await this.expertRepository.findOne({ where: { id } });

    if (!expert) {
      throw new NotFoundException('Expert não encontrado');
    }

    return this.formatExpert(expert);
  }

  async create(data: {
    name: string;
    email: string;
    specialty: string;
    bio?: string;
    avatarUrl?: string;
    experienceYears?: number;
    loginOriginal?: string;
    loginAlvo?: string;
    saldoAlvo?: number;
    connectionStatus?: string;
    traderType?: string;
  }) {
    // Verificar se email já existe
    const existing = await this.expertRepository.findOne({
      where: { email: data.email },
    });

    if (existing) {
      throw new ConflictException('Email já está em uso');
    }

    // Normalizar campos vazios para null
    const loginOriginal = data.loginOriginal?.trim() || null;
    const loginAlvo = data.loginAlvo?.trim() || null;
    const bio = data.bio?.trim() || null;
    const avatarUrl = data.avatarUrl?.trim() || null;
    const traderType = data.traderType?.trim() || null;

    const expert = this.expertRepository.create({
      id: uuidv4(),
      name: data.name.trim(),
      email: data.email.trim(),
      specialty: data.specialty.trim(),
      bio,
      avatarUrl,
      experienceYears: data.experienceYears || 0,
      rating: 0,
      totalReviews: 0,
      totalFollowers: 0,
      totalSignals: 0,
      winRate: 0,
      isVerified: false,
      isActive: true,
      socialLinks: null,
      loginOriginal,
      loginAlvo,
      saldoAlvo: data.saldoAlvo || 0,
      connectionStatus: data.connectionStatus || 'Desconectado',
      traderType,
    });

    const savedExpert = await this.expertRepository.save(expert);

    return this.formatExpert(savedExpert);
  }

  async update(
    id: string,
    data: {
      name?: string;
      email?: string;
      specialty?: string;
      bio?: string;
      avatarUrl?: string;
      experienceYears?: number;
      rating?: number;
      totalReviews?: number;
      totalFollowers?: number;
      totalSignals?: number;
      winRate?: number;
      isVerified?: boolean;
      isActive?: boolean;
      loginOriginal?: string;
      loginAlvo?: string;
      saldoAlvo?: number;
      connectionStatus?: string;
      traderType?: string;
    },
  ) {
    const expert = await this.expertRepository.findOne({ where: { id } });

    if (!expert) {
      throw new NotFoundException('Expert não encontrado');
    }

    // Verificar email único se estiver mudando
    if (data.email && data.email !== expert.email) {
      const existing = await this.expertRepository.findOne({
        where: { email: data.email },
      });
      if (existing) {
        throw new ConflictException('Email já está em uso');
      }
    }

    // Normalizar campos vazios para null
    const updateData: any = { ...data };
    if (updateData.name) updateData.name = updateData.name.trim();
    if (updateData.email) updateData.email = updateData.email.trim();
    if (updateData.specialty) updateData.specialty = updateData.specialty.trim();
    if (updateData.bio !== undefined) updateData.bio = updateData.bio?.trim() || null;
    if (updateData.avatarUrl !== undefined) updateData.avatarUrl = updateData.avatarUrl?.trim() || null;
    if (updateData.loginOriginal !== undefined) updateData.loginOriginal = updateData.loginOriginal?.trim() || null;
    if (updateData.loginAlvo !== undefined) updateData.loginAlvo = updateData.loginAlvo?.trim() || null;
    if (updateData.traderType !== undefined) updateData.traderType = updateData.traderType?.trim() || null;

    Object.assign(expert, updateData);

    const updatedExpert = await this.expertRepository.save(expert);

    return this.formatExpert(updatedExpert);
  }

  async delete(id: string) {
    const expert = await this.expertRepository.findOne({ where: { id } });

    if (!expert) {
      throw new NotFoundException('Expert não encontrado');
    }

    await this.expertRepository.remove(expert);

    return {
      message: 'Expert excluído com sucesso',
      id: id,
    };
  }

  async toggleStatus(id: string) {
    const expert = await this.expertRepository.findOne({ where: { id } });

    if (!expert) {
      throw new NotFoundException('Expert não encontrado');
    }

    expert.isActive = !expert.isActive;

    const updatedExpert = await this.expertRepository.save(expert);

    return this.formatExpert(updatedExpert);
  }

  async toggleVerified(id: string) {
    const expert = await this.expertRepository.findOne({ where: { id } });

    if (!expert) {
      throw new NotFoundException('Expert não encontrado');
    }

    expert.isVerified = !expert.isVerified;

    const updatedExpert = await this.expertRepository.save(expert);

    return this.formatExpert(updatedExpert);
  }

  async getSummaryStats() {
    const experts = await this.expertRepository.find({
      order: { updatedAt: 'DESC' },
    });

    // Experts ativos (com connectionStatus = 'Ativo' ou isActive = true)
    const activeExperts = experts.filter(
      (e) => e.connectionStatus === 'Ativo' || e.isActive === true,
    );

    // Saldo total gerenciado
    const totalBalance = experts.reduce(
      (sum, e) => sum + parseFloat(e.saldoAlvo.toString()),
      0,
    );

    // Lucro médio diário (1.5% do saldo total dos experts ativos)
    const activeBalance = activeExperts.reduce(
      (sum, e) => sum + parseFloat(e.saldoAlvo.toString()),
      0,
    );
    const avgDailyProfit = (activeBalance * 0.015).toFixed(2);

    // Última sincronização (updatedAt mais recente)
    const lastSync =
      experts.length > 0 && experts[0].updatedAt
        ? experts[0].updatedAt
        : null;

    // Total de experts verificados
    const verifiedExperts = experts.filter((e) => e.isVerified === true);

    return {
      activeExperts: activeExperts.length,
      totalExperts: experts.length,
      verifiedExperts: verifiedExperts.length,
      totalBalance: parseFloat(totalBalance.toFixed(2)),
      avgDailyProfit: parseFloat(avgDailyProfit),
      lastSync: lastSync,
    };
  }

  private formatExpert(expert: ExpertEntity) {
    return {
      id: expert.id,
      name: expert.name,
      email: expert.email,
      specialty: expert.specialty,
      bio: expert.bio,
      avatarUrl: expert.avatarUrl,
      experienceYears: expert.experienceYears,
      rating: parseFloat(expert.rating.toString()),
      totalReviews: expert.totalReviews,
      totalFollowers: expert.totalFollowers,
      totalSignals: expert.totalSignals,
      winRate: parseFloat(expert.winRate.toString()),
      isVerified: expert.isVerified,
      isActive: expert.isActive,
      socialLinks: expert.socialLinks,
      loginOriginal: expert.loginOriginal || null,
      loginAlvo: expert.loginAlvo || null,
      saldoAlvo: parseFloat(expert.saldoAlvo.toString()),
      connectionStatus: expert.connectionStatus || 'Desconectado',
      traderType: expert.traderType || null,
      createdAt: expert.createdAt,
      updatedAt: expert.updatedAt,
    };
  }
}

