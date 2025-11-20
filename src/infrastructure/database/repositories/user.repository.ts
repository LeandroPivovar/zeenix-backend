import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRepository } from '../../../domain/repositories/user.repository';
import { User } from '../../../domain/entities/user.entity';
import { UserEntity } from '../entities/user.entity';

@Injectable()
export class TypeOrmUserRepository implements UserRepository {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async create(user: User): Promise<User> {
    const userEntity = this.toEntity(user);
    const savedEntity = await this.userRepository.save(userEntity);
    return this.toDomain(savedEntity);
  }

  async findById(id: string): Promise<User | null> {
    const userEntity = await this.userRepository.findOne({ where: { id } });
    return userEntity ? this.toDomain(userEntity) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const userEntity = await this.userRepository.findOne({ where: { email } });
    return userEntity ? this.toDomain(userEntity) : null;
  }

  async findAll(): Promise<User[]> {
    const userEntities = await this.userRepository.find();
    return userEntities.map(entity => this.toDomain(entity));
  }

  async update(user: User): Promise<User> {
    const userEntity = this.toEntity(user);
    const updatedEntity = await this.userRepository.save(userEntity);
    return this.toDomain(updatedEntity);
  }

  async delete(id: string): Promise<void> {
    await this.userRepository.delete(id);
  }

  async updateDerivInfo(userId: string, info: { loginId: string; currency?: string; balance?: number; raw?: any }): Promise<void> {
    const updateData: any = {
      derivLoginId: info.loginId,
    };
    
    // Só atualizar currency se foi fornecido explicitamente
    if (info.currency !== undefined) {
      updateData.derivCurrency = info.currency;
    }
    
    // Só atualizar balance se foi fornecido explicitamente
    if (info.balance !== undefined) {
      updateData.derivBalance = String(info.balance);
    }
    
    // Só atualizar raw se foi fornecido explicitamente
    if (info.raw !== undefined) {
      updateData.derivRaw = info.raw;
    }
    
    await this.userRepository.update(userId, updateData);
  }

  async getDerivInfo(userId: string): Promise<{ loginId: string | null; currency: string | null; balance: string | null; raw: any } | null> {
    const userEntity = await this.userRepository.findOne({ 
      where: { id: userId },
      select: ['id', 'derivLoginId', 'derivCurrency', 'derivBalance', 'derivRaw']
    });
    if (!userEntity) return null;
    return {
      loginId: userEntity.derivLoginId ?? null,
      currency: userEntity.derivCurrency ?? null,
      balance: userEntity.derivBalance ?? null,
      raw: userEntity.derivRaw ?? null,
    };
  }

  async clearDerivInfo(userId: string): Promise<void> {
    const updateData: any = {
      derivLoginId: null,
      derivCurrency: null,
      derivBalance: null,
      derivRaw: null,
    };
    await this.userRepository.update(userId, updateData);
  }

  private toDomain(entity: UserEntity): User {
    return new User(
      entity.id,
      entity.name,
      entity.email,
      entity.password,
      entity.createdAt,
      entity.updatedAt,
    );
  }

  private toEntity(domain: User): UserEntity {
    const entity = new UserEntity();
    entity.id = domain.id;
    entity.name = domain.name;
    entity.email = domain.email;
    entity.password = domain.password;
    entity.role = 'user'; // Definir role como 'user' por padrão para novos usuários
    entity.createdAt = domain.createdAt;
    entity.updatedAt = domain.updatedAt;
    return entity;
  }
}
