import { Body, Controller, Logger, Post } from '@nestjs/common';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly maskedFields = ['password', 'token', 'authorization', 'secret', 'key'];

  @Post()
  handleWebhook(@Body() payload: any) {
    const maskedPayload = this.maskSensitiveData(payload);
    this.logger.log(`Webhook recebido: ${JSON.stringify(maskedPayload)}`);
    return { success: true };
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

