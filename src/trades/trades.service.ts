import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TradeEntity, TradeType, TradeStatus } from '../infrastructure/database/entities/trade.entity';
import { v4 as uuidv4 } from 'uuid';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { SettingsService } from '../settings/settings.service';

export interface CreateTradeDto {
  contractType: string;
  timeType: string;
  duration: string;
  multiplier: number;
  entryValue: number;
  tradeType: TradeType;
}

@Injectable()
export class TradesService {
  constructor(
    @InjectRepository(TradeEntity)
    private readonly tradeRepository: Repository<TradeEntity>,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    private readonly settingsService: SettingsService,
  ) {}

  async createTrade(userId: string, dto: CreateTradeDto, ipAddress?: string, userAgent?: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Validar valor mínimo
    if (dto.entryValue < 1) {
      throw new BadRequestException('Valor da entrada deve ser no mínimo $1,00');
    }

    // Validar multiplicador
    if (dto.multiplier < 1 || dto.multiplier > 1000) {
      throw new BadRequestException('Multiplicador deve estar entre 1 e 1000');
    }

    // Criar trade (por enquanto, apenas salvar localmente)
    // Em produção, aqui seria feita a integração com a API da Deriv
    const trade = this.tradeRepository.create({
      id: uuidv4(),
      userId,
      contractType: dto.contractType,
      timeType: dto.timeType,
      duration: dto.duration,
      multiplier: dto.multiplier,
      entryValue: dto.entryValue,
      tradeType: dto.tradeType,
      status: TradeStatus.PENDING,
    });

    const savedTrade = await this.tradeRepository.save(trade);

    // Log da operação
    await this.settingsService.logActivity(
      userId,
      'CREATE_TRADE',
      `Criou operação ${dto.tradeType} de $${dto.entryValue.toFixed(2)}`,
      ipAddress,
      userAgent,
    );

    // Simular resultado após alguns segundos (em produção, isso viria da Deriv)
    setTimeout(async () => {
      await this.simulateTradeResult(savedTrade.id);
    }, 3000);

    return savedTrade;
  }

  private async simulateTradeResult(tradeId: string) {
    const trade = await this.tradeRepository.findOne({ where: { id: tradeId } });
    if (!trade || trade.status !== TradeStatus.PENDING) return;

    // Simulação: 60% de chance de ganho
    const won = Math.random() > 0.4;
    const profit = won
      ? (trade.entryValue * trade.multiplier * (0.5 + Math.random() * 0.5)) // Ganho entre 50-100% do valor investido
      : -(trade.entryValue * (0.5 + Math.random() * 0.5)); // Perda entre 50-100% do valor investido

    trade.status = won ? TradeStatus.WON : TradeStatus.LOST;
    trade.profit = Number(profit.toFixed(2));
    await this.tradeRepository.save(trade);
  }

  async getUserTrades(userId: string, limit: number = 50) {
    const trades = await this.tradeRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return trades.map(trade => ({
      id: trade.id,
      contractType: trade.contractType,
      timeType: trade.timeType,
      duration: trade.duration,
      multiplier: trade.multiplier,
      entryValue: trade.entryValue,
      tradeType: trade.tradeType,
      status: trade.status,
      profit: trade.profit,
      createdAt: trade.createdAt,
    }));
  }

  async getRecentTrades(userId: string, limit: number = 10) {
    const trades = await this.tradeRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return trades
      .filter(trade => trade.status !== TradeStatus.PENDING)
      .map(trade => ({
        id: trade.id,
        time: trade.createdAt,
        type: trade.tradeType,
        result: trade.profit ? (trade.profit > 0 ? `+$${trade.profit.toFixed(2)}` : `$${trade.profit.toFixed(2)}`) : '-',
        profit: trade.profit,
      }));
  }
}

