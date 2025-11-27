import { Injectable, UnauthorizedException, Inject, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { CreateUserDto } from '../application/dto/user.dto';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../domain/entities/user.entity';
import { EmailService } from './email.service';
import { randomBytes } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
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
    const token = await this.signToken(user.id, user.email, user.name, 'user');
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
    // Buscar role diretamente do banco
    const userWithRole = await this.dataSource.query(
      'SELECT role FROM users WHERE id = ?',
      [user.id]
    );
    const userRole = userWithRole && userWithRole.length > 0 ? userWithRole[0].role : 'user';
    const token = await this.signToken(user.id, user.email, user.name, userRole);
    return { token };
  }

  async findUserByEmail(email: string) {
    return await this.userRepository.findByEmail(email);
  }

  async findUserById(userId: string) {
    return await this.userRepository.findById(userId);
  }

  async forgotPassword(email: string, frontendUrl: string): Promise<{ message: string }> {
    const user = await this.userRepository.findByEmail(email);
    
    // Por segurança, sempre retornamos sucesso mesmo se o email não existir
    if (!user) {
      return { message: 'Se o email existir, você receberá instruções de recuperação de senha.' };
    }

    // Gerar token único
    const resetToken = randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date();
    resetTokenExpiry.setHours(resetTokenExpiry.getHours() + 1); // Expira em 1 hora

    // Salvar token no banco de dados
    await this.dataSource.query(
      `UPDATE users 
       SET reset_token = ?, reset_token_expiry = ? 
       WHERE id = ?`,
      [resetToken, resetTokenExpiry, user.id]
    );

    // Construir URL de reset
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    // Enviar email
    await this.emailService.sendPasswordResetEmail(user.email, resetToken, resetUrl);

    return { message: 'Se o email existir, você receberá instruções de recuperação de senha.' };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    // Buscar usuário pelo token
    const users = await this.dataSource.query(
      `SELECT id, email, reset_token_expiry 
       FROM users 
       WHERE reset_token = ?`,
      [token]
    );

    if (!users || users.length === 0) {
      throw new BadRequestException('Token inválido ou expirado');
    }

    const user = users[0];

    // Verificar se o token expirou
    const now = new Date();
    const expiryDate = new Date(user.reset_token_expiry);
    
    if (now > expiryDate) {
      throw new BadRequestException('Token expirado. Solicite uma nova recuperação de senha.');
    }

    // Validar nova senha
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('A senha deve ter no mínimo 6 caracteres');
    }

    // Hash da nova senha
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Atualizar senha e limpar token
    await this.dataSource.query(
      `UPDATE users 
       SET password = ?, reset_token = NULL, reset_token_expiry = NULL 
       WHERE id = ?`,
      [hashedPassword, user.id]
    );

    return { message: 'Senha redefinida com sucesso!' };
  }

  private async signToken(sub: string, email: string, name: string, role: string = 'user'): Promise<string> {
    return await this.jwtService.signAsync({ sub, email, name, role });
  }
}


