import { Injectable, UnauthorizedException, Inject, ConflictException, NotFoundException, BadRequestException, forwardRef, Logger } from '@nestjs/common';
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
import { validateBrazilianPhone } from '../utils/phone.validator';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService?: NotificationsService,
  ) {}

  async register(payload: CreateUserDto, frontendUrl?: string): Promise<{ message: string }>
  {
    const existing = await this.userRepository.findByEmail(payload.email);
    if (existing) {
      throw new ConflictException('Email já está em uso');
    }

    // Validar e verificar telefone se fornecido
    if (payload.phone) {
      // Validar usando libphonenumber-js
      const validation = validateBrazilianPhone(payload.phone);
      
      if (!validation.isValid || !validation.phoneDigits) {
        throw new BadRequestException(validation.error || 'Telefone inválido');
      }

      // Verificar se telefone já está em uso
      const existingPhone = await this.userRepository.findByPhone(validation.phoneDigits);
      if (existingPhone) {
        throw new ConflictException('Telefone já está em uso');
      }

      // Usar apenas dígitos validados para armazenar
      payload.phone = validation.phoneDigits;
    }

    const hashed = await bcrypt.hash(payload.password, 10);
    const userId = uuidv4();
    const user = User.create(userId, payload.name, payload.email, hashed, payload.phone);
    await this.userRepository.create(user);

    // Salvar usuário como inativo (status = 0)
    await this.dataSource.query(
      `UPDATE users SET is_active = 0 WHERE id = ?`,
      [userId]
    );

    // Gerar token de confirmação
    const confirmationToken = randomBytes(32).toString('hex');
    const confirmationTokenExpiry = new Date();
    confirmationTokenExpiry.setHours(confirmationTokenExpiry.getHours() + 24); // Expira em 24 horas

    // Salvar token no banco de dados
    await this.dataSource.query(
      `UPDATE users 
       SET reset_token = ?, reset_token_expiry = ? 
       WHERE id = ?`,
      [confirmationToken, confirmationTokenExpiry, userId]
    );

    // Construir URL de confirmação
    const url = frontendUrl || process.env.FRONTEND_URL || 'https://taxafacil.site';
    const confirmationUrl = `${url}/confirm-account?token=${confirmationToken}`;

    // Enviar email de confirmação
    try {
      console.log(`[AuthService] Tentando enviar email de confirmação para ${payload.email}`);
      await this.emailService.sendConfirmationEmail(payload.email, payload.name, confirmationToken, confirmationUrl);
      console.log(`[AuthService] Email de confirmação enviado com sucesso para ${payload.email}`);
    } catch (error) {
      console.error(`[AuthService] Erro ao enviar email de confirmação para ${payload.email}:`, error);
      // Não falhar o registro se o email falhar, mas logar o erro
      // O usuário pode solicitar reenvio do email depois
    }

    return { message: 'Cadastro realizado com sucesso! Verifique seu e-mail para confirmar a conta.' };
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
    // Verificar se o usuário está ativo
    const userStatus = await this.dataSource.query(
      'SELECT is_active, role FROM users WHERE id = ?',
      [user.id]
    );
    if (!userStatus || userStatus.length === 0 || !userStatus[0].is_active) {
      throw new UnauthorizedException('Sua conta ainda não foi confirmada. Verifique seu e-mail para confirmar a conta.');
    }
    const userRole = userStatus[0].role || 'user';
    const token = await this.signToken(user.id, user.email, user.name, userRole);

    // ✅ OTIMIZAÇÃO: Buscar notificações de forma não-bloqueante (fire-and-forget)
    // Isso evita que o login trave esperando queries ao banco de dados
    if (this.notificationsService) {
      // Executar em background sem bloquear a resposta do login
      const notificationsService = this.notificationsService; // Capturar referência para evitar problema de escopo
      setImmediate(async () => {
        try {
          if (notificationsService) {
            this.logger.log(`[Login] Buscando notificações para usuário ${user.id}...`);
            await notificationsService.getLoginSummary(user.id);
          }
        } catch (error) {
          this.logger.error(`[Login] Erro ao buscar notificações: ${error.message}`);
          // Não falhar o login se as notificações falharem
        }
      });
    }

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

  async confirmAccount(token: string): Promise<{ message: string }> {
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
      throw new BadRequestException('Token expirado. Solicite um novo link de confirmação.');
    }

    // Ativar conta e limpar token
    await this.dataSource.query(
      `UPDATE users 
       SET is_active = 1, reset_token = NULL, reset_token_expiry = NULL 
       WHERE id = ?`,
      [user.id]
    );

    return { message: 'Conta confirmada com sucesso! Você já pode fazer login.' };
  }

  private async signToken(sub: string, email: string, name: string, role: string = 'user'): Promise<string> {
    return await this.jwtService.signAsync({ sub, email, name, role });
  }
}


