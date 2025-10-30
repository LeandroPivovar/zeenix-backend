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

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);
    const user = User.create(
      uuidv4(),
      createUserDto.name,
      createUserDto.email,
      hashedPassword,
    );

    return await this.userRepository.create(user);
  }
}
