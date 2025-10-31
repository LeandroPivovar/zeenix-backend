import { Injectable, UnauthorizedException, Inject, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { CreateUserDto } from '../application/dto/user.dto';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../domain/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
  ) {}

  async register(payload: CreateUserDto): Promise<{ token: string }>
  {
    const existing = await this.userRepository.findByEmail(payload.email);
    if (existing) {
      throw new ConflictException('Email já está em uso');
    }

    const hashed = await bcrypt.hash(payload.password, 10);
    const user = User.create(uuidv4(), payload.name, payload.email, hashed);
    await this.userRepository.create(user);
    const token = await this.signToken(user.id, user.email);
    return { token };
  }

  async login(email: string, password: string): Promise<{ token: string }>
  {
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const token = await this.signToken(user.id, user.email);
    return { token };
  }

  async findUserByEmail(email: string) {
    return await this.userRepository.findByEmail(email);
  }

  private async signToken(sub: string, email: string): Promise<string> {
    return await this.jwtService.signAsync({ sub, email });
  }
}


