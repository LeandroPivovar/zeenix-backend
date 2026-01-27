import { Body, Controller, HttpCode, HttpStatus, Post, Get, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { SettingsService } from '../settings/settings.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CoursesService } from '../courses/courses.service';

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

  @IsString()
  phone?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly settingsService: SettingsService,
    private readonly coursesService: CoursesService,
  ) { }
  // ...
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getMe(@Req() req: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    if (!userId) {
      throw new Error('Usuário não autenticado');
    }
    const user = await this.authService.findUserById(userId);
    if (!user) {
      throw new Error('Usuário não encontrado');
    }
    const userAny = user as any;

    // Obter IDs acessíveis baseados em hierarquia
    let accessiblePlanIds: string[] = [];
    if (userAny.planId) {
      accessiblePlanIds = await this.coursesService.getAccessiblePlanIds(userAny.planId);
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      firstAccess: user.firstAccess,
      planId: userAny.planId,
      role: user.role,
      accessiblePlanIds
    };
  }
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: RegisterDto, @Req() req: any) {
    const frontendUrl = process.env.FRONTEND_URL || req.headers.origin || 'https://iazenix.com';
    return this.authService.register(body, frontendUrl);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto, @Req() req: any) {
    const result = await this.authService.login(body.email, body.password);
    const token = result.token;

    // ✅ OTIMIZAÇÃO: Criar sessão e log de atividade de forma não-bloqueante
    // Isso evita que o login trave esperando operações de banco de dados
    setImmediate(async () => {
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
    });

    return { token };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: { email: string }, @Req() req: any) {
    const frontendUrl = process.env.FRONTEND_URL || req.headers.origin || 'https://iazenix.com';
    return await this.authService.forgotPassword(body.email, frontendUrl);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: { token: string; password: string }) {
    return await this.authService.resetPassword(body.token, body.password);
  }

  @Post('confirm-account')
  @HttpCode(HttpStatus.OK)
  async confirmAccount(@Body() body: { token: string }) {
    return await this.authService.confirmAccount(body.token);
  }
}


