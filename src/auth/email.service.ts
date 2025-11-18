import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    // Configuração SMTP do Gmail
    const smtpSecure = process.env.SMTP_SECURE || 'tls';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: smtpPort,
      secure: smtpSecure === 'ssl', // true para SSL (porta 465), false para TLS (porta 587)
      auth: {
        user: process.env.SMTP_USERNAME || 'suporte.ultra.academy@gmail.com',
        pass: process.env.SMTP_PASSWORD || 'zgri migf nurw hmqy',
      },
    });
  }

  async sendPasswordResetEmail(email: string, resetToken: string, resetUrl: string): Promise<void> {
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte.ultra.academy@gmail.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ULTRA Academy';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'Recuperação de Senha - ULTRA Academy',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #22C55E; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 30px; background-color: #22C55E; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .token { background-color: #fff; padding: 15px; border-radius: 5px; margin: 20px 0; font-family: monospace; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Recuperação de Senha</h1>
            </div>
            <div class="content">
              <p>Olá,</p>
              <p>Recebemos uma solicitação para redefinir a senha da sua conta.</p>
              <p>Clique no botão abaixo para criar uma nova senha:</p>
              <p style="text-align: center;">
                <a href="${resetUrl}" class="button">Redefinir Senha</a>
              </p>
              <p>Ou copie e cole o link abaixo no seu navegador:</p>
              <div class="token">${resetUrl}</div>
              <p><strong>Este link expira em 1 hora.</strong></p>
              <p>Se você não solicitou esta recuperação de senha, ignore este e-mail.</p>
              <p>Atenciosamente,<br>Equipe ULTRA Academy</p>
            </div>
            <div class="footer">
              <p>Este é um e-mail automático, por favor não responda.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        Recuperação de Senha - ULTRA Academy
        
        Olá,
        
        Recebemos uma solicitação para redefinir a senha da sua conta.
        
        Acesse o link abaixo para criar uma nova senha:
        ${resetUrl}
        
        Este link expira em 1 hora.
        
        Se você não solicitou esta recuperação de senha, ignore este e-mail.
        
        Atenciosamente,
        Equipe ULTRA Academy
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email de recuperação de senha enviado para ${email}`);
    } catch (error) {
      this.logger.error(`Erro ao enviar email de recuperação de senha: ${error.message}`, error.stack);
      throw new Error('Falha ao enviar email de recuperação de senha');
    }
  }
}

