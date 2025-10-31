import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FaqEntity } from '../infrastructure/database/entities/faq.entity';
import { SystemStatusEntity, SystemStatusType } from '../infrastructure/database/entities/system-status.entity';

@Injectable()
export class SupportService {
  constructor(
    @InjectRepository(FaqEntity)
    private readonly faqRepository: Repository<FaqEntity>,
    @InjectRepository(SystemStatusEntity)
    private readonly statusRepository: Repository<SystemStatusEntity>,
  ) {}

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
}

