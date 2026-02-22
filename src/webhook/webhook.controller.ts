import { Body, Controller, Logger, Post, Inject, Get, Query } from '@nestjs/common';
import { KiwifyWebhookDto } from './dto/kiwify-webhook.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookLogEntity } from '../infrastructure/database/entities/webhook-log.entity';
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
    @InjectRepository(WebhookLogEntity) private readonly webhookLogRepository: Repository<WebhookLogEntity>,
    private readonly emailService: EmailService,
  ) { }

  @Post()
  async handleWebhook(@Body() payload: any) {
    const logEntry = new WebhookLogEntity();
    logEntry.payload = JSON.stringify(payload);
    logEntry.status = 'received';

    // Extrair informações básicas do payload (Kiwify pattern)
    if (payload) {
      const actualPayload = Array.isArray(payload) ? payload[0] : payload;
      logEntry.eventType = actualPayload.webhook_event_type;
      logEntry.email = actualPayload.Customer?.email;
    }

    try {
      await this.webhookLogRepository.save(logEntry);
    } catch (dbError) {
      this.logger.error(`❌ Erro ao salvar log do webhook: ${dbError.message}`);
    }

    this.logger.log('=== INÍCIO DO PROCESSAMENTO DO WEBHOOK ===');
    this.logger.log(`Tipo do payload: ${typeof payload}`);
    this.logger.log(`Payload é array: ${Array.isArray(payload)}`);

    let actualPayload = payload;
    if (Array.isArray(payload)) {
      this.logger.log('📦 Webhook recebido como Array. Extraindo o primeiro elemento...');
      actualPayload = payload[0];
      this.logger.log(`Payload extraído (primeiros 500 chars): ${JSON.stringify(actualPayload).substring(0, 500)}`);
    } else {
      this.logger.log(`Payload bruto (primeiros 500 chars): ${JSON.stringify(payload).substring(0, 500)}`);
    }

    const maskedPayload = this.maskSensitiveData(actualPayload);
    this.logger.log(`Webhook recebido (mascarado): ${JSON.stringify(maskedPayload)}`);

    // Log dos campos importantes para debug
    this.logger.log(`webhook_event_type: ${actualPayload?.webhook_event_type || 'UNDEFINED'}`);
    this.logger.log(`order_status: ${actualPayload?.order_status || 'UNDEFINED'}`);
    this.logger.log(`Customer existe: ${!!actualPayload?.Customer}`);
    this.logger.log(`Customer.email: ${actualPayload?.Customer?.email || 'N/A'}`);

    // Verificar se o payload tem a estrutura esperada
    if (!actualPayload || typeof actualPayload !== 'object') {
      this.logger.error('❌ Payload inválido ou não é um objeto');
      return { success: false, error: 'Invalid payload' };
    }

    // Verificar se é um webhook de pedido aprovado e pago
    const isOrderApproved = actualPayload.webhook_event_type === 'order_approved';
    const isPaid = actualPayload.order_status === 'paid';
    const hasCustomerEmail = !!actualPayload.Customer?.email;

    this.logger.log(`Verificações: isOrderApproved=${isOrderApproved}, isPaid=${isPaid}, hasCustomerEmail=${hasCustomerEmail}`);

    if (isOrderApproved && isPaid && hasCustomerEmail) {
      this.logger.log('✅ Condições atendidas! Processando pedido aprovado...');
      await this.handleOrderApproved(actualPayload as KiwifyWebhookDto);
    } else {
      this.logger.warn('⚠️ Condições não atendidas. Webhook não será processado para criação de usuário.');
      if (!isOrderApproved) {
        this.logger.warn(`  - webhook_event_type não é 'order_approved': ${actualPayload.webhook_event_type}`);
      }
      if (!isPaid) {
        this.logger.warn(`  - order_status não é 'paid': ${actualPayload.order_status}`);
      }
      if (!hasCustomerEmail) {
        this.logger.warn(`  - Customer.email não existe ou está vazio`);
        if (actualPayload.Customer) {
          this.logger.warn(`  - Customer object: ${JSON.stringify(actualPayload.Customer)}`);
        }
      }
    }

    this.logger.log('=== FIM DO PROCESSAMENTO DO WEBHOOK ===');
    return { success: true };
  }

  private async handleOrderApproved(payload: KiwifyWebhookDto) {
    this.logger.log('--- Iniciando handleOrderApproved ---');
    const customer = payload.Customer;
    const email = customer.email;
    const name = customer.full_name || customer.first_name || 'Usuário';

    this.logger.log(`Dados extraídos - Email: ${email}, Nome: ${name}`);

    try {
      // Verificar se o usuário já existe
      this.logger.log(`Verificando se usuário com email ${email} já existe...`);
      const existingUser = await this.userRepository.findByEmail(email);

      if (existingUser) {
        this.logger.warn(`⚠️ Usuário com email ${email} já existe (ID: ${existingUser.id}), pulando criação`);
        return;
      }
      this.logger.log(`✅ Usuário não existe, prosseguindo com criação...`);

      // Senha padrão conforme solicitado
      this.logger.log('Usando senha padrão zeenix2025...');
      const temporaryPassword = 'zeenix2025';

      // Hash da senha
      this.logger.log('Fazendo hash da senha...');
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
      this.logger.log('Hash da senha concluído');

      // Criar usuário
      this.logger.log('Criando objeto User...');
      const userId = uuidv4();
      this.logger.log(`ID do usuário gerado: ${userId}`);
      const user = User.create(
        userId,
        name,
        email,
        hashedPassword,
      );
      this.logger.log(`Objeto User criado: ${JSON.stringify({ id: user.id, name: user.name, email: user.email })}`);

      // Salvar usuário no banco (com role 'user' por padrão)
      this.logger.log('Salvando usuário no banco de dados...');
      const createdUser = await this.userRepository.create(user);
      this.logger.log(`✅ Usuário salvo no banco com sucesso! ID: ${createdUser.id}`);

      // Obter URL da plataforma
      const platformUrl = process.env.FRONTEND_URL || 'https://iazenix.com';
      this.logger.log(`URL da plataforma: ${platformUrl}`);

      // Enviar email de boas-vindas
      this.logger.log(`Enviando email de boas-vindas para ${email}...`);
      await this.emailService.sendWelcomeEmail(
        email,
        name,
        temporaryPassword,
        platformUrl,
      );
      this.logger.log(`✅ Email de boas-vindas enviado com sucesso para ${email}`);

      this.logger.log(`🎉 Processo concluído com sucesso! Usuário criado: ${createdUser.id} (${email})`);
    } catch (error) {
      this.logger.error('❌ ERRO ao processar webhook de pedido aprovado');
      this.logger.error(`Mensagem de erro: ${error.message}`);
      this.logger.error(`Stack trace: ${error.stack}`);
      this.logger.error(`Erro completo: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
      // Não lançar erro para não quebrar o webhook
    } finally {
      this.logger.log('--- Fim do handleOrderApproved ---');
    }
  }

  private generateTemporaryPassword(): string {
    this.logger.debug('Iniciando geração de senha temporária...');
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
    const shuffledPassword = password
      .split('')
      .sort(() => Math.random() - 0.5)
      .join('');

    this.logger.debug(`Senha temporária gerada com ${shuffledPassword.length} caracteres`);
    return shuffledPassword;
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

  @Get('logs')
  async fetchLogs(@Query('limit') limit = 50) {
    try {
      const logs = await this.webhookLogRepository.find({
        order: { createdAt: 'DESC' },
        take: limit,
      });
      return { success: true, data: logs };
    } catch (error) {
      this.logger.error(`❌ Erro ao buscar logs do webhook: ${error.message}`);
      return { success: false, message: 'Internal server error' };
    }
  }

  @Post('clear-logs')
  async clearLogs() {
    try {
      await this.webhookLogRepository.clear();
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Erro ao limpar logs do webhook: ${error.message}`);
      return { success: false, message: 'Internal server error' };
    }
  }
}

