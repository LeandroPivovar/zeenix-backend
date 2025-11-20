import { Body, Controller, Logger, Post, Inject } from '@nestjs/common';
import { KiwifyWebhookDto } from './dto/kiwify-webhook.dto';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { EmailService } from '../auth/email.service';
import { User } from '../domain/entities/user.entity';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly maskedFields = ['password', 'token', 'authorization', 'secret', 'key'];

  constructor(
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
    private readonly emailService: EmailService,
  ) {}

  @Post()
  async handleWebhook(@Body() payload: KiwifyWebhookDto) {
    const maskedPayload = this.maskSensitiveData(payload);
    this.logger.log(`Webhook recebido: ${JSON.stringify(maskedPayload)}`);

    // Verificar se é um webhook de pedido aprovado e pago
    if (
      payload.webhook_event_type === 'order_approved' &&
      payload.order_status === 'paid' &&
      payload.Customer?.email
    ) {
      await this.handleOrderApproved(payload);
    }

    return { success: true };
  }

  private async handleOrderApproved(payload: KiwifyWebhookDto) {
    const customer = payload.Customer;
    const email = customer.email;
    const name = customer.full_name || customer.first_name || 'Usuário';

    try {
      // Verificar se o usuário já existe
      const existingUser = await this.userRepository.findByEmail(email);

      if (existingUser) {
        this.logger.log(`Usuário com email ${email} já existe, pulando criação`);
        return;
      }

      // Gerar senha pré-configurada aleatória
      const temporaryPassword = this.generateTemporaryPassword();

      // Hash da senha
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

      // Criar usuário
      const user = User.create(
        uuidv4(),
        name,
        email,
        hashedPassword,
      );

      // Salvar usuário no banco (com role 'user' por padrão)
      const createdUser = await this.userRepository.create(user);

      // Obter URL da plataforma
      const platformUrl = process.env.FRONTEND_URL || 'https://taxafacil.site';

      // Enviar email de boas-vindas
      await this.emailService.sendWelcomeEmail(
        email,
        name,
        temporaryPassword,
        platformUrl,
      );

      this.logger.log(`Usuário criado com sucesso: ${createdUser.id} (${email})`);
    } catch (error) {
      this.logger.error(
        `Erro ao processar webhook de pedido aprovado: ${error.message}`,
        error.stack,
      );
      // Não lançar erro para não quebrar o webhook
    }
  }

  private generateTemporaryPassword(): string {
    // Gera uma senha aleatória de 12 caracteres
    // Inclui letras maiúsculas, minúsculas e números
    const length = 12;
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const allChars = uppercase + lowercase + numbers;

    // Garantir que tenha pelo menos uma de cada tipo
    let password = '';
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];

    // Preencher o resto com caracteres aleatórios
    for (let i = password.length; i < length; i++) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // Embaralhar a senha
    return password
      .split('')
      .sort(() => Math.random() - 0.5)
      .join('');
  }

  private maskSensitiveData(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.maskSensitiveData(item));
    }

    return Object.entries(data).reduce((acc, [key, value]) => {
      if (this.maskedFields.includes(key.toLowerCase())) {
        acc[key] = '[MASKED]';
      } else if (value && typeof value === 'object') {
        acc[key] = this.maskSensitiveData(value);
      } else {
        acc[key] = value;
      }
      return acc;
    }, {} as Record<string, any>);
  }
}

