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

  async sendAccountActivationEmail(email: string, name: string, resetToken: string, resetUrl: string): Promise<void> {
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte.ultra.academy@gmail.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ULTRA Academy';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: '🎉 Bem-vindo! Complete seu cadastro como Expert - ULTRA Academy',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #22C55E 0%, #16A34A 100%); color: white; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .welcome-box { background-color: #E8F5E9; border-left: 4px solid #22C55E; padding: 20px; margin: 20px 0; border-radius: 5px; }
            .button { display: inline-block; padding: 14px 35px; background-color: #22C55E; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
            .button:hover { background-color: #16A34A; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .token { background-color: #fff; padding: 15px; border-radius: 5px; margin: 20px 0; font-family: monospace; word-break: break-all; border: 1px solid #E5E5E5; }
            .highlight { color: #22C55E; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0; font-size: 28px;">🎉 Bem-vindo à ULTRA Academy!</h1>
              <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.95;">Sua jornada como Expert começa agora</p>
            </div>
            <div class="content">
              <p style="font-size: 18px; margin-bottom: 10px;"><strong>Olá ${name},</strong></p>
              
              <div class="welcome-box">
                <p style="margin: 0; font-size: 16px; color: #2E7D32;">
                  <strong>É um prazer tê-lo conosco!</strong> Sua conta de <span class="highlight">Expert</span> foi criada com sucesso na plataforma ULTRA Academy.
                </p>
              </div>

              <p>Estamos muito felizes em tê-lo como parte da nossa comunidade de traders especializados. Como Expert, você terá acesso a recursos exclusivos para compartilhar suas estratégias e ajudar outros traders a alcançarem seus objetivos.</p>

              <p><strong>O que você pode fazer como Expert:</strong></p>
              <ul style="line-height: 2;">
                <li>📊 Compartilhar suas estratégias de trading</li>
                <li>📈 Acompanhar seu desempenho e estatísticas</li>
                <li>👥 Conectar-se com traders da comunidade</li>
                <li>💼 Gerenciar seu perfil e especialidades</li>
                <li>🎯 Aumentar sua visibilidade e reputação</li>
              </ul>

              <p style="margin-top: 30px;"><strong>Para começar, você precisa definir uma senha para sua conta:</strong></p>
              
              <p style="text-align: center;">
                <a href="${resetUrl}" class="button">🔐 Definir Minha Senha</a>
              </p>

              <p style="text-align: center; color: #666; font-size: 14px;">Ou copie e cole o link abaixo no seu navegador:</p>
              <div class="token">${resetUrl}</div>
              
              <p style="background-color: #FFF3CD; padding: 15px; border-radius: 5px; border-left: 4px solid #FFC107;">
                <strong>⏰ Importante:</strong> Este link expira em <strong>1 hora</strong>. Após definir sua senha, você poderá fazer login e começar a usar a plataforma imediatamente.
              </p>

              <p style="margin-top: 30px;">Estamos ansiosos para ver suas contribuições na comunidade!</p>

              <p style="margin-top: 30px;">
                Bem-vindo e sucesso em sua jornada!<br>
                <strong>Equipe ULTRA Academy</strong>
              </p>
            </div>
            <div class="footer">
              <p>Este é um e-mail automático, por favor não responda.</p>
              <p style="margin-top: 10px;">Se você não esperava receber este e-mail, ignore esta mensagem.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        🎉 Bem-vindo à ULTRA Academy!
        
        Olá ${name},
        
        É um prazer tê-lo conosco! Sua conta de Expert foi criada com sucesso na plataforma ULTRA Academy.
        
        Estamos muito felizes em tê-lo como parte da nossa comunidade de traders especializados. Como Expert, você terá acesso a recursos exclusivos para compartilhar suas estratégias e ajudar outros traders a alcançarem seus objetivos.
        
        O que você pode fazer como Expert:
        - Compartilhar suas estratégias de trading
        - Acompanhar seu desempenho e estatísticas
        - Conectar-se com traders da comunidade
        - Gerenciar seu perfil e especialidades
        - Aumentar sua visibilidade e reputação
        
        Para começar, você precisa definir uma senha para sua conta. Acesse o link abaixo:
        ${resetUrl}
        
        IMPORTANTE: Este link expira em 1 hora. Após definir sua senha, você poderá fazer login e começar a usar a plataforma imediatamente.
        
        Estamos ansiosos para ver suas contribuições na comunidade!
        
        Bem-vindo e sucesso em sua jornada!
        Equipe ULTRA Academy
        
        ---
        Este é um e-mail automático, por favor não responda.
        Se você não esperava receber este e-mail, ignore esta mensagem.
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email de ativação de conta enviado para ${email}`);
    } catch (error) {
      this.logger.error(`Erro ao enviar email de ativação de conta: ${error.message}`, error.stack);
      throw new Error('Falha ao enviar email de ativação de conta');
    }
  }

  async sendWelcomeEmail(email: string, name: string, password: string, platformUrl: string): Promise<void> {
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte.ultra.academy@gmail.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ULTRA Academy';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: '🎉 Bem-vindo à ULTRA Academy!',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #22C55E 0%, #16A34A 100%); color: white; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .welcome-box { background-color: #E8F5E9; border-left: 4px solid #22C55E; padding: 20px; margin: 20px 0; border-radius: 5px; }
            .button { display: inline-block; padding: 14px 35px; background-color: #22C55E; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
            .button:hover { background-color: #16A34A; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .password-box { background-color: #fff; padding: 15px; border-radius: 5px; margin: 20px 0; font-family: monospace; word-break: break-all; border: 2px solid #22C55E; text-align: center; font-size: 18px; font-weight: bold; color: #16A34A; }
            .highlight { color: #22C55E; font-weight: bold; }
            .warning-box { background-color: #FFF3CD; padding: 15px; border-radius: 5px; border-left: 4px solid #FFC107; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0; font-size: 28px;">🎉 Bem-vindo à ULTRA Academy!</h1>
              <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.95;">Sua conta foi criada com sucesso</p>
            </div>
            <div class="content">
              <p style="font-size: 18px; margin-bottom: 10px;"><strong>Olá ${name},</strong></p>
              
              <div class="welcome-box">
                <p style="margin: 0; font-size: 16px; color: #2E7D32;">
                  <strong>É um prazer tê-lo conosco!</strong> Sua conta foi criada com sucesso na plataforma ULTRA Academy.
                </p>
              </div>

              <p>Estamos muito felizes em tê-lo como parte da nossa comunidade. Agora você tem acesso completo à plataforma e pode começar a usar todos os recursos disponíveis.</p>

              <p><strong>Para acessar sua conta, utilize as seguintes credenciais:</strong></p>
              
              <p style="text-align: center; margin: 10px 0;"><strong>Email:</strong> ${email}</p>
              
              <p style="text-align: center; margin: 10px 0;"><strong>Sua senha temporária:</strong></p>
              <div class="password-box">${password}</div>

              <p style="text-align: center; margin-top: 30px;">
                <a href="${platformUrl}" class="button">🚀 Acessar Plataforma</a>
              </p>

              <p style="text-align: center; color: #666; font-size: 14px;">Ou copie e cole o link abaixo no seu navegador:</p>
              <div style="background-color: #fff; padding: 15px; border-radius: 5px; margin: 20px 0; font-family: monospace; word-break: break-all; border: 1px solid #E5E5E5; text-align: center;">${platformUrl}</div>
              
              <div class="warning-box">
                <p style="margin: 0;">
                  <strong>🔒 Importante:</strong> Por segurança, recomendamos que você altere sua senha após o primeiro acesso. Mantenha suas credenciais em local seguro e não compartilhe com terceiros.
                </p>
              </div>

              <p style="margin-top: 30px;">Estamos ansiosos para ver você usando a plataforma!</p>

              <p style="margin-top: 30px;">
                Bem-vindo e sucesso em sua jornada!<br>
                <strong>Equipe ULTRA Academy</strong>
              </p>
            </div>
            <div class="footer">
              <p>Este é um e-mail automático, por favor não responda.</p>
              <p style="margin-top: 10px;">Se você não esperava receber este e-mail, ignore esta mensagem.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        🎉 Bem-vindo à ULTRA Academy!
        
        Olá ${name},
        
        É um prazer tê-lo conosco! Sua conta foi criada com sucesso na plataforma ULTRA Academy.
        
        Estamos muito felizes em tê-lo como parte da nossa comunidade. Agora você tem acesso completo à plataforma e pode começar a usar todos os recursos disponíveis.
        
        Para acessar sua conta, utilize as seguintes credenciais:
        
        Email: ${email}
        Senha temporária: ${password}
        
        Acesse a plataforma em: ${platformUrl}
        
        IMPORTANTE: Por segurança, recomendamos que você altere sua senha após o primeiro acesso. Mantenha suas credenciais em local seguro e não compartilhe com terceiros.
        
        Estamos ansiosos para ver você usando a plataforma!
        
        Bem-vindo e sucesso em sua jornada!
        Equipe ULTRA Academy
        
        ---
        Este é um e-mail automático, por favor não responda.
        Se você não esperava receber este e-mail, ignore esta mensagem.
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email de boas-vindas enviado para ${email}`);
    } catch (error) {
      this.logger.error(`Erro ao enviar email de boas-vindas: ${error.message}`, error.stack);
      throw new Error('Falha ao enviar email de boas-vindas');
    }
  }
}

