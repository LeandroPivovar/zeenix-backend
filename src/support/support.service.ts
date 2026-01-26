import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FaqEntity } from '../infrastructure/database/entities/faq.entity';
import { SystemStatusEntity, SystemStatusType } from '../infrastructure/database/entities/system-status.entity';
import { SupportItemEntity } from '../infrastructure/database/entities/support-item.entity';
import { AppConfigEntity } from '../infrastructure/database/entities/app-config.entity';
import { CreateFaqDto, UpdateFaqDto, CreateSupportItemDto, UpdateSupportItemDto, UpdateStudentGroupConfigDto } from '../presentation/dto/support.dto';

@Injectable()
export class SupportService {
  constructor(
    @InjectRepository(FaqEntity)
    private readonly faqRepository: Repository<FaqEntity>,
    @InjectRepository(SystemStatusEntity)
    private readonly statusRepository: Repository<SystemStatusEntity>,
    @InjectRepository(SupportItemEntity)
    private readonly supportItemRepository: Repository<SupportItemEntity>,
    @InjectRepository(AppConfigEntity)
    private readonly appConfigRepository: Repository<AppConfigEntity>,
  ) { }

  async findAllFaqs(search?: string) {
    const queryBuilder = this.faqRepository.createQueryBuilder('faq');

    if (search) {
      queryBuilder.where(
        '(faq.question LIKE :search OR faq.answer LIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder.orderBy('faq.order_index', 'ASC');

    const faqs = await queryBuilder.getMany();

    return faqs.map(faq => ({
      id: faq.id,
      question: faq.question,
      answer: faq.answer,
      category: faq.category,
      orderIndex: faq.orderIndex,
    }));
  }

  async getSystemStatus() {
    const statuses = await this.statusRepository.find({
      order: { serviceName: 'ASC' },
    });

    // Determinar status geral: se todos estão operacionais, retorna operacional
    const allOperational = statuses.every(s => s.status === SystemStatusType.OPERATIONAL);

    return {
      overall: allOperational ? 'operational' : 'degraded',
      message: allOperational ? 'Todos os sistemas operacionais.' : 'Alguns serviços podem estar com problemas.',
      services: statuses.map(s => ({
        id: s.id,
        serviceName: s.serviceName,
        status: s.status,
        message: s.message,
        updatedAt: s.updatedAt,
      })),
    };
  }

  // ========== FAQ Methods ==========
  async findFaqById(id: string) {
    const faq = await this.faqRepository.findOne({ where: { id } });
    if (!faq) {
      throw new NotFoundException(`FAQ com ID ${id} não encontrada`);
    }
    return {
      id: faq.id,
      question: faq.question,
      answer: faq.answer,
      category: faq.category,
      orderIndex: faq.orderIndex,
    };
  }

  async createFaq(createFaqDto: CreateFaqDto) {
    const faq = this.faqRepository.create(createFaqDto);
    const saved = await this.faqRepository.save(faq);
    return {
      id: saved.id,
      question: saved.question,
      answer: saved.answer,
      category: saved.category,
      orderIndex: saved.orderIndex,
    };
  }

  async updateFaq(id: string, updateFaqDto: UpdateFaqDto) {
    const faq = await this.faqRepository.findOne({ where: { id } });
    if (!faq) {
      throw new NotFoundException(`FAQ com ID ${id} não encontrada`);
    }
    Object.assign(faq, updateFaqDto);
    const saved = await this.faqRepository.save(faq);
    return {
      id: saved.id,
      question: saved.question,
      answer: saved.answer,
      category: saved.category,
      orderIndex: saved.orderIndex,
    };
  }

  async deleteFaq(id: string) {
    const faq = await this.faqRepository.findOne({ where: { id } });
    if (!faq) {
      throw new NotFoundException(`FAQ com ID ${id} não encontrada`);
    }
    await this.faqRepository.remove(faq);
  }

  // ========== Support Items Methods ==========
  async findAllSupportItems() {
    const items = await this.supportItemRepository.find({
      order: { createdAt: 'DESC' },
    });
    return items.map(item => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      imagePath: item.imagePath,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  }

  async findSupportItemById(id: string) {
    const item = await this.supportItemRepository.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Item de suporte com ID ${id} não encontrado`);
    }
    return {
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      imagePath: item.imagePath,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async createSupportItem(createSupportItemDto: CreateSupportItemDto) {
    const item = this.supportItemRepository.create(createSupportItemDto);
    const saved = await this.supportItemRepository.save(item);
    return {
      id: saved.id,
      title: saved.title,
      subtitle: saved.subtitle,
      imagePath: saved.imagePath,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  async updateSupportItem(id: string, updateSupportItemDto: UpdateSupportItemDto) {
    const item = await this.supportItemRepository.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Item de suporte com ID ${id} não encontrado`);
    }
    Object.assign(item, updateSupportItemDto);
    const saved = await this.supportItemRepository.save(item);
    return {
      id: saved.id,
      title: saved.title,
      subtitle: saved.subtitle,
      imagePath: saved.imagePath,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  async deleteSupportItem(id: string) {
    const item = await this.supportItemRepository.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Item de suporte com ID ${id} não encontrado`);
    }
    await this.supportItemRepository.remove(item);
  }

  // ========== App Config Methods ==========
  async getAppConfig(key: string) {
    const config = await this.appConfigRepository.findOne({ where: { key } });
    if (!config) {
      // Retornar null ou objeto padrão se não existir, sem erro 404
      return null;
    }
    return config.value;
  }

  async saveAppConfig(key: string, value: any, description?: string) {
    let config = await this.appConfigRepository.findOne({ where: { key } });
    if (!config) {
      config = this.appConfigRepository.create({ key, value, description });
    } else {
      config.value = value;
      if (description) {
        config.description = description;
      }
    }
    return await this.appConfigRepository.save(config);
  }
}




