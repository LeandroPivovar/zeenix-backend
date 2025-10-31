import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { SettingsService } from '../settings/settings.service';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;
}

class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly settingsService: SettingsService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto, @Req() req: any) {
    const result = await this.authService.login(body.email, body.password);
    const token = result.token;
    
    // Criar sessão e log de atividade
    try {
      // Buscar usuário pelo email para pegar o ID
      const user = await this.authService.findUserByEmail(body.email);
      if (user) {
        const device = req.headers['user-agent']?.includes('Mobile') ? 'Mobile' : 'Desktop';
        const ipAddress = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        
        await this.settingsService.createSession(user.id, token, device, userAgent, ipAddress);
        await this.settingsService.logActivity(
          user.id,
          'LOGIN',
          'Realizou login no sistema',
          ipAddress,
          userAgent
        );
      }
    } catch (err) {
      console.warn('Erro ao criar sessão:', err);
      // Não falhar o login se a criação de sessão falhar
    }
    
    return { token };
  }
}


