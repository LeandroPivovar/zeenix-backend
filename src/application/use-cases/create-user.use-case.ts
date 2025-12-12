import { Injectable, ConflictException, Inject } from '@nestjs/common';
import type { UserRepository } from '../../domain/repositories/user.repository';
import { User } from '../../domain/entities/user.entity';
import { CreateUserDto } from '../dto/user.dto';
import { v4 as uuidv4 } from 'uuid';
import { USER_REPOSITORY_TOKEN } from '../../constants/tokens';
import * as bcrypt from 'bcrypt';

@Injectable()
export class CreateUserUseCase {
  constructor(@Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository) {}

  async execute(createUserDto: CreateUserDto): Promise<User> {
    const existingUser = await this.userRepository.findByEmail(createUserDto.email);
    
    if (existingUser) {
      throw new ConflictException('Email já está em uso');
    }

    // Validar e verificar telefone se fornecido
    let phoneToSave = createUserDto.phone;
    if (createUserDto.phone) {
      const phoneDigits = createUserDto.phone.replace(/\D/g, '');
      
      if (phoneDigits.length < 10 || phoneDigits.length > 11) {
        throw new ConflictException('Telefone inválido. Use o formato: (XX) XXXXX-XXXX ou (XX) XXXX-XXXX');
      }

      const existingPhone = await this.userRepository.findByPhone(phoneDigits);
      if (existingPhone) {
        throw new ConflictException('Telefone já está em uso');
      }

      phoneToSave = phoneDigits;
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);
    const user = User.create(
      uuidv4(),
      createUserDto.name,
      createUserDto.email,
      hashedPassword,
      phoneToSave,
    );

    return await this.userRepository.create(user);
  }
}
