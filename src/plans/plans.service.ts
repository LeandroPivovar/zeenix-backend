import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlanEntity } from '../infrastructure/database/entities/plan.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class PlansService {
  constructor(
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepo: UserRepository,
    private readonly settingsService: SettingsService,
  ) {}

  async getAllPlans() {
    const plans = await this.planRepository.find({
      where: { isActive: true },
      order: { displayOrder: 'ASC' },
    });

    return plans.map(plan => ({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      price: Number(plan.price),
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      features: plan.features || {},
      isPopular: plan.isPopular,
      isRecommended: plan.isRecommended,
    }));
  }

  async getPlanById(id: string) {
    const plan = await this.planRepository.findOne({ where: { id } });
    if (!plan) {
      throw new NotFoundException('Plano não encontrado');
    }
    return {
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      price: Number(plan.price),
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      features: plan.features || {},
      isPopular: plan.isPopular,
      isRecommended: plan.isRecommended,
    };
  }

  async getUserPlan(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['plan'],
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (!user.plan) {
      return null;
    }

    return {
      id: user.plan.id,
      name: user.plan.name,
      slug: user.plan.slug,
      price: Number(user.plan.price),
      currency: user.plan.currency,
      billingPeriod: user.plan.billingPeriod,
      features: user.plan.features || {},
      activatedAt: user.planActivatedAt,
    };
  }

  async activatePlan(userId: string, planId: string, ipAddress?: string, userAgent?: string) {
    const plan = await this.planRepository.findOne({ where: { id: planId, isActive: true } });
    if (!plan) {
      throw new NotFoundException('Plano não encontrado ou inativo');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Se o plano for gratuito (Starter), ativar diretamente
    if (Number(plan.price) === 0) {
      user.planId = plan.id;
      user.planActivatedAt = new Date();
      await this.userRepository.save(user);

      await this.settingsService.logActivity(
        userId,
        'ACTIVATE_PLAN',
        `Ativou o plano ${plan.name}`,
        ipAddress,
        userAgent,
      );

      return { success: true, message: 'Plano ativado com sucesso' };
    }

    // Para planos pagos, aqui seria a integração com gateway de pagamento
    // Por enquanto, apenas retornamos que é necessário pagamento
    throw new BadRequestException('Plano pago requer processamento de pagamento');
  }
}




