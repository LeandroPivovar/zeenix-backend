import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlanEntity } from '../infrastructure/database/entities/plan.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { v4 as uuidv4 } from 'uuid';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepo: UserRepository,
    private readonly settingsService: SettingsService,
  ) {}

  async getAllPlans() {
    this.logger.log('[GetAllPlans] Buscando planos ativos...');

    const plans = await this.planRepository.find({
      where: { isActive: 1 as any }, // Banco usa 0 ou 1, não boolean
      order: { displayOrder: 'ASC' },
    });

    this.logger.log(`[GetAllPlans] Encontrados ${plans.length} planos`);

    if (plans.length === 0) {
      this.logger.warn(
        '[GetAllPlans] Nenhum plano ativo encontrado! Verifique is_active no banco.',
      );
    }

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      price: Number(plan.price),
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      features: plan.features || {},
      isPopular: plan.isPopular,
      isRecommended: plan.isRecommended,
      isActive: plan.isActive,
      displayOrder: plan.displayOrder,
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

  async activatePlan(
    userId: string,
    planId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const plan = await this.planRepository.findOne({
      where: { id: planId, isActive: 1 as any },
    }); // Banco usa 0 ou 1
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
    throw new BadRequestException(
      'Plano pago requer processamento de pagamento',
    );
  }

  async getAllPlansAdmin() {
    const plans = await this.planRepository.find({
      order: { displayOrder: 'ASC', createdAt: 'DESC' },
    });

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      price: Number(plan.price),
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      features: plan.features || {},
      isPopular: plan.isPopular,
      isRecommended: plan.isRecommended,
      isActive: plan.isActive,
      displayOrder: plan.displayOrder,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    }));
  }

  async createPlan(data: {
    name: string;
    slug: string;
    price: number;
    currency?: string;
    billingPeriod?: string;
    features?: any;
    isPopular?: boolean;
    isRecommended?: boolean;
    isActive?: boolean;
    displayOrder?: number;
  }) {
    // Verificar se slug já existe
    const existingSlug = await this.planRepository.findOne({
      where: { slug: data.slug },
    });

    if (existingSlug) {
      throw new ConflictException('Já existe um plano com este slug');
    }

    const plan = this.planRepository.create({
      id: uuidv4(),
      name: data.name.trim(),
      slug: data.slug.trim().toLowerCase(),
      price: data.price,
      currency: data.currency || 'BRL',
      billingPeriod: data.billingPeriod || 'month',
      features: data.features || {},
      isPopular: data.isPopular || false,
      isRecommended: data.isRecommended || false,
      isActive: data.isActive !== undefined ? data.isActive : true,
      displayOrder: data.displayOrder || 0,
    });

    const savedPlan = await this.planRepository.save(plan);

    return {
      id: savedPlan.id,
      name: savedPlan.name,
      slug: savedPlan.slug,
      price: Number(savedPlan.price),
      currency: savedPlan.currency,
      billingPeriod: savedPlan.billingPeriod,
      features: savedPlan.features || {},
      isPopular: savedPlan.isPopular,
      isRecommended: savedPlan.isRecommended,
      isActive: savedPlan.isActive,
      displayOrder: savedPlan.displayOrder,
      createdAt: savedPlan.createdAt,
      updatedAt: savedPlan.updatedAt,
    };
  }

  async updatePlan(
    id: string,
    data: {
      name?: string;
      slug?: string;
      price?: number;
      currency?: string;
      billingPeriod?: string;
      features?: any;
      isPopular?: boolean;
      isRecommended?: boolean;
      isActive?: boolean;
      displayOrder?: number;
    },
  ) {
    const plan = await this.planRepository.findOne({ where: { id } });

    if (!plan) {
      throw new NotFoundException('Plano não encontrado');
    }

    // Verificar se slug já existe em outro plano
    if (data.slug && data.slug !== plan.slug) {
      const existingSlug = await this.planRepository.findOne({
        where: { slug: data.slug },
      });

      if (existingSlug) {
        throw new ConflictException('Já existe um plano com este slug');
      }
    }

    // Atualizar campos
    if (data.name !== undefined) plan.name = data.name.trim();
    if (data.slug !== undefined) plan.slug = data.slug.trim().toLowerCase();
    if (data.price !== undefined) plan.price = data.price;
    if (data.currency !== undefined) plan.currency = data.currency;
    if (data.billingPeriod !== undefined)
      plan.billingPeriod = data.billingPeriod;
    if (data.features !== undefined) plan.features = data.features;
    if (data.isPopular !== undefined) plan.isPopular = data.isPopular;
    if (data.isRecommended !== undefined)
      plan.isRecommended = data.isRecommended;
    if (data.isActive !== undefined) plan.isActive = data.isActive;
    if (data.displayOrder !== undefined) plan.displayOrder = data.displayOrder;

    const updatedPlan = await this.planRepository.save(plan);

    return {
      id: updatedPlan.id,
      name: updatedPlan.name,
      slug: updatedPlan.slug,
      price: Number(updatedPlan.price),
      currency: updatedPlan.currency,
      billingPeriod: updatedPlan.billingPeriod,
      features: updatedPlan.features || {},
      isPopular: updatedPlan.isPopular,
      isRecommended: updatedPlan.isRecommended,
      isActive: updatedPlan.isActive,
      displayOrder: updatedPlan.displayOrder,
      createdAt: updatedPlan.createdAt,
      updatedAt: updatedPlan.updatedAt,
    };
  }

  async deletePlan(id: string) {
    const plan = await this.planRepository.findOne({ where: { id } });

    if (!plan) {
      throw new NotFoundException('Plano não encontrado');
    }

    // Verificar se há usuários usando este plano
    const usersWithPlan = await this.userRepository.count({
      where: { planId: id },
    });

    if (usersWithPlan > 0) {
      throw new BadRequestException(
        `Não é possível deletar o plano. Existem ${usersWithPlan} usuário(s) usando este plano. Desative o plano ao invés de deletá-lo.`,
      );
    }

    await this.planRepository.remove(plan);

    return {
      message: 'Plano deletado com sucesso',
      id: id,
    };
  }
}
