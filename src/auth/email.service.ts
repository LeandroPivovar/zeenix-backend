import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    // Configuração SMTP
    const smtpSecure = process.env.SMTP_SECURE || 'tls';
    const smtpPort = parseInt(process.env.SMTP_PORT || '465');

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtpout.secureserver.net',
      port: smtpPort,
      secure: smtpSecure === 'ssl', // true para SSL (porta 465), false para TLS (porta 587)
      auth: {
        user: process.env.SMTP_USERNAME || 'suporte@iazenix.com',
        pass: process.env.SMTP_PASSWORD || 'o4g*ppUA572(',
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  async sendPasswordResetEmail(email: string, resetToken: string, resetUrl: string): Promise<void> {
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte@iazenix.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ZENIX';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'Recuperação de Senha - ZENIX',
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
              <p>Atenciosamente,<br>Equipe ZENIX</p>
            </div>
            <div class="footer">
              <p>Este é um e-mail automático, por favor não responda.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        Recuperação de Senha - ZENIX
        
        Olá,
        
        Recebemos uma solicitação para redefinir a senha da sua conta.
        
        Acesse o link abaixo para criar uma nova senha:
        ${resetUrl}
        
        Este link expira em 1 hora.
        
        Se você não solicitou esta recuperação de senha, ignore este e-mail.
        
        Atenciosamente,
        Equipe ZENIX
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
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte@iazenix.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ZENIX';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: '🎉 Bem-vindo! Complete seu cadastro como Expert - ZENIX',
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
              <h1 style="margin: 0; font-size: 28px;">🎉 Bem-vindo à ZENIX!</h1>
              <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.95;">Sua jornada como Expert começa agora</p>
            </div>
            <div class="content">
              <p style="font-size: 18px; margin-bottom: 10px;"><strong>Olá ${name},</strong></p>
              
              <div class="welcome-box">
                <p style="margin: 0; font-size: 16px; color: #2E7D32;">
                  <strong>É um prazer tê-lo conosco!</strong> Sua conta de <span class="highlight">Expert</span> foi criada com sucesso na plataforma ZENIX.
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
                <strong>Equipe ZENIX</strong>
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
        🎉 Bem-vindo à ZENIX!
        
        Olá ${name},
        
        É um prazer tê-lo conosco! Sua conta de Expert foi criada com sucesso na plataforma ZENIX.
        
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
        Equipe ZENIX
        
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
    this.logger.log(`[sendWelcomeEmail] Iniciando envio de email de boas-vindas para ${email}`);
    this.logger.log(`[sendWelcomeEmail] Parâmetros: name=${name}, platformUrl=${platformUrl}`);

    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte@iazenix.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ZENIX';

    this.logger.log(`[sendWelcomeEmail] Configuração SMTP: fromEmail=${fromEmail}, fromName=${fromName}`);

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'ZENIX | Acesso liberado ao painel',
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
              <h1 style="margin: 0; font-size: 28px;">🎉 Bem-vindo à ZENIX!</h1>
              <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.95;">Sua conta foi criada com sucesso</p>
            </div>
            <div class="content">
              <p style="font-size: 18px; margin-bottom: 10px;"><strong>Olá ${name},</strong></p>
              
              <div class="welcome-box">
                <p style="margin: 0; font-size: 16px; color: #2E7D32;">
                  <strong>É um prazer tê-lo conosco!</strong> Sua conta foi criada com sucesso na plataforma ZENIX.
                </p>
              </div>
 
              <p>Estamos muito felizes em tê-lo como parte da nossa comunidade. Agora você have acesso completo à plataforma e pode começar a usar todos os recursos disponíveis.</p>
 
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
                  <strong>🔒 Importante:</strong> Em seu primeiro acesso, você deverá aceitar nossos Termos de Uso e <strong>alterar obrigatoriamente</strong> sua senha por motivos de segurança.
                </p>
              </div>
 
              <p style="margin-top: 30px;">Estamos ansiosos para ver você usando a plataforma!</p>
 
              <p style="margin-top: 30px;">
                Bem-vindo e sucesso em sua jornada!<br>
                <strong>Equipe ZENIX</strong>
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
        🎉 Bem-vindo à ZENIX!
        
        Olá ${name},
        
        É um prazer tê-lo conosco! Sua conta foi criada com sucesso na plataforma ZENIX.
        
        Estamos muito felizes em tê-lo como parte da nossa comunidade. Agora você tem acesso completo à plataforma e pode começar a usar todos os recursos disponíveis.
        
        Para acessar sua conta, utilize as seguintes credenciais:
        
        Email: ${email}
        Senha temporária: ${password}
        
        Acesse a plataforma em: ${platformUrl}
        
        IMPORTANTE: Por segurança, recomendamos que você altere sua senha após o primeiro acesso. Mantenha suas credenciais em local seguro e não compartilhe com terceiros.
        
        Estamos ansiosos para ver você usando a plataforma!
        
        Bem-vindo e sucesso em sua jornada!
        Equipe ZENIX
        
        ---
        Este é um e-mail automático, por favor não responda.
        Se você não esperava receber este e-mail, ignore esta mensagem.
      `,
    };

    try {
      this.logger.log(`[sendWelcomeEmail] Preparando para enviar email via SMTP...`);
      this.logger.log(`[sendWelcomeEmail] Destinatário: ${email}`);
      this.logger.log(`[sendWelcomeEmail] Assunto: ${mailOptions.subject}`);

      await this.transporter.sendMail(mailOptions);
      this.logger.log(`✅ [sendWelcomeEmail] Email de boas-vindas enviado com sucesso para ${email}`);
    } catch (error) {
      this.logger.error(`❌ [sendWelcomeEmail] Erro ao enviar email de boas-vindas`);
      this.logger.error(`[sendWelcomeEmail] Mensagem: ${error.message}`);
      this.logger.error(`[sendWelcomeEmail] Stack: ${error.stack}`);
      this.logger.error(`[sendWelcomeEmail] Erro completo: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
      throw new Error('Falha ao enviar email de boas-vindas');
    }
  }

  async sendConfirmationEmail(email: string, name: string, confirmationToken: string, confirmationUrl: string): Promise<void> {
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte@iazenix.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ZENIX';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'ZENIX | Confirme sua conta',
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
              <h1>Confirme sua conta</h1>
            </div>
            <div class="content">
              <p>Olá ${name},</p>
              <p>Obrigado por se cadastrar na plataforma ZENIX!</p>
              <p>Para ativar sua conta, clique no botão abaixo:</p>
              <p style="text-align: center;">
                <a href="${confirmationUrl}" class="button">Confirmar Conta</a>
              </p>
              <p>Ou copie e cole o link abaixo no seu navegador:</p>
              <div class="token">${confirmationUrl}</div>
              <p><strong>Este link expira em 24 horas.</strong></p>
              <p>Se você não se cadastrou nesta plataforma, ignore este e-mail.</p>
              <p>Atenciosamente,<br>Equipe ZENIX</p>
            </div>
            <div class="footer">
              <p>Este é um e-mail automático, por favor não responda.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        Confirme sua conta - ZENIX

        Olá ${name},

        Obrigado por se cadastrar na plataforma ZENIX!

        Para ativar sua conta, acesse o link abaixo:
        ${confirmationUrl}

        Este link expira em 24 horas.

        Se você não se cadastrou nesta plataforma, ignore este e-mail.

        Atenciosamente,
        Equipe ZENIX
      `,
    };

    try {
      this.logger.log(`[sendConfirmationEmail] Preparando para enviar email de confirmação para ${email}`);
      this.logger.log(`[sendConfirmationEmail] Configuração SMTP: host=${process.env.SMTP_HOST}, user=${process.env.SMTP_USERNAME}`);
      this.logger.log(`[sendConfirmationEmail] URL de confirmação: ${confirmationUrl}`);

      await this.transporter.sendMail(mailOptions);
      this.logger.log(`✅ [sendConfirmationEmail] Email de confirmação enviado com sucesso para ${email}`);
    } catch (error) {
      this.logger.error(`❌ [sendConfirmationEmail] Erro ao enviar email de confirmação para ${email}`);
      this.logger.error(`[sendConfirmationEmail] Mensagem: ${error.message}`);
      this.logger.error(`[sendConfirmationEmail] Stack: ${error.stack}`);
      this.logger.error(`[sendConfirmationEmail] Erro completo: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
      throw new Error('Falha ao enviar email de confirmação');
    }
  }

  async sendDailySummary(email: string, name: string, stats: { totalTrades: number, wins: number, losses: number, netProfit: number }): Promise<void> {
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'suporte@iazenix.com';
    const fromName = process.env.SMTP_FROM_NAME || 'ZENIX';
    const winRate = stats.totalTrades > 0 ? ((stats.wins / stats.totalTrades) * 100).toFixed(1) : '0.0';

    // Novas cores premium
    const bgMain = '#121826';
    const bgCard = '#1C2539';
    const colorSuccess = '#00C853';
    const colorError = '#FF5252';

    const profitColor = stats.netProfit >= 0 ? colorSuccess : colorError;
    const profitBg = stats.netProfit >= 0 ? 'rgba(0, 200, 83, 0.05)' : 'rgba(255, 82, 82, 0.05)';
    const profitSign = stats.netProfit >= 0 ? '+' : '';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: `📊 Resumo Diário de Operações - ZENIX`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #E5E7EB; background-color: ${bgMain}; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
            .wrapper { background-color: ${bgMain}; padding: 40px 20px; }
            .container { max-width: 600px; margin: 0 auto; background-color: #161e2e; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.05); }
            
            .header { 
              background: linear-gradient(135deg, #166534 0%, #00C853 100%); 
              color: white; 
              padding: 50px 30px; 
              text-align: center; 
              position: relative;
            }
            .header-logo { font-weight: 800; letter-spacing: 2px; font-size: 14px; opacity: 0.8; margin-bottom: 20px; display: block; }
            .header-title { margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; }
            .header-subtitle { margin: 10px 0 0 0; opacity: 0.7; font-size: 14px; font-weight: 400; }

            .content { padding: 40px 35px; }
            .welcome-text { font-size: 20px; margin-bottom: 8px; color: #ffffff; font-weight: 700; }
            .welcome-sub { font-size: 14px; color: #94A3B8; margin-bottom: 30px; }
            
            .stat-grid { display: flex; flex-wrap: wrap; gap: 16px; margin: 30px 0; }
            .stat-card { 
              flex: 1; 
              min-width: 120px; 
              background-color: ${bgCard}; 
              padding: 24px 15px; 
              border-radius: 12px; 
              text-align: center; 
              border: 1px solid rgba(255,255,255,0.03);
              transition: transform 0.2s ease;
            }
            .stat-value { font-size: 26px; font-weight: 800; margin-bottom: 4px; color: #ffffff; display: block; }
            .stat-label { font-size: 11px; color: #64748B; text-transform: uppercase; font-weight: 700; letter-spacing: 1px; }
            
            /* Efeito de brilho para vitórias */
            .stat-card-success { 
              border: 1px solid rgba(0, 200, 83, 0.2);
              box-shadow: inset 0 0 20px rgba(0, 200, 83, 0.05);
            }
            .stat-card-success .stat-value { color: ${colorSuccess}; text-shadow: 0 0 15px rgba(0, 200, 83, 0.3); }

            .profit-box { 
              text-align: center; 
              background-color: ${profitBg}; 
              padding: 40px 30px; 
              border-radius: 16px; 
              margin-top: 25px; 
              border: 1px solid ${stats.netProfit >= 0 ? 'rgba(0, 200, 83, 0.1)' : 'rgba(255, 82, 82, 0.1)'};
            }
            .profit-label { font-size: 12px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 10px; display: block; }
            .profit-value { 
              font-size: 42px; 
              font-weight: 900; 
              color: ${profitColor}; 
              font-family: 'Courier New', Courier, monospace; /* Tabular fallback */
              font-variant-numeric: tabular-nums;
              letter-spacing: -1px;
            }

            .footer { text-align: center; padding: 30px; color: #4B5563; font-size: 12px; background-color: #0f172a; }
            .button-container { text-align: center; margin-top: 35px; }
            .button { 
              display: inline-block; 
              padding: 16px 36px; 
              background: linear-gradient(135deg, #00C853 0%, #00a846 100%);
              color: white; 
              text-decoration: none; 
              border-radius: 8px; 
              font-weight: 800;
              font-size: 14px;
              text-transform: uppercase;
              letter-spacing: 1px;
              box-shadow: 0 10px 20px rgba(0, 200, 83, 0.2);
            }
            
            .support-text { margin-top: 40px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 25px; color: #4B5563; font-size: 13px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="header">
                <span class="header-logo">ZENIX PLATFORM</span>
                <h1 class="header-title">Resumo de Hoje 📈</h1>
                <p class="header-subtitle">Confira seu desempenho detalhado nas últimas 24h</p>
              </div>
              
              <div class="content">
                <div class="welcome-text">Olá, ${name}</div>
                <div class="welcome-sub">Aqui está a análise consolidada da sua inteligência de trading.</div>
                
                <div class="stat-grid">
                  <div class="stat-card">
                    <span class="stat-value">${stats.totalTrades}</span>
                    <span class="stat-label">Operações</span>
                  </div>
                  <div class="stat-card stat-card-success">
                    <span class="stat-value">${stats.wins}</span>
                    <span class="stat-label">Vitórias</span>
                  </div>
                  <div class="stat-card">
                    <span class="stat-value" style="color: ${colorError}; opacity: 0.9;">${stats.losses}</span>
                    <span class="stat-label">Derrotas</span>
                  </div>
                  <div class="stat-card">
                    <span class="stat-value" style="color: #3B82F6;">${winRate}%</span>
                    <span class="stat-label">Eficiência</span>
                  </div>
                </div>

                <div class="profit-box">
                  <span class="profit-label">Resultado Líquido Consolidado</span>
                  <div class="profit-value">${profitSign}$${Math.abs(stats.netProfit).toFixed(2)}</div>
                </div>

                <div class="button-container">
                  <a href="https://iazenix.com/dashboard" class="button">Acessar Painel Completo</a>
                </div>

                <div class="support-text">
                  Continue operando com estratégia. Nosso suporte especializado está pronto para te ajudar a qualquer momento.
                </div>
              </div>
              
              <div class="footer">
                <p>© 2026 ZENIX. Tecnologia de ponta em trading inteligente.</p>
                <p style="opacity: 0.6;">Você está recebendo este resumo diário automático. <br> Configure suas preferências no menu de perfil.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        📊 Resumo Diário de Operações - ZENIX

        Olá ${name},
        
        Aqui estão as estatísticas das suas operações de hoje:

        Total de Operações: ${stats.totalTrades}
        Vitórias: ${stats.wins}
        Derrotas: ${stats.losses}
        Win Rate: ${winRate}%

        Resultado Final: ${profitSign}$${Math.abs(stats.netProfit).toFixed(2)}

        Acesse seu painel completo em: https://iazenix.com/dashboard

        Equipe ZENIX
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Relatório diário premium enviado para ${email}`);
    } catch (error) {
      this.logger.error(`Erro ao enviar relatório diário premium para ${email}: ${error.message}`);
    }
  }
}

