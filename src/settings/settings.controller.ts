import { Controller, Get, Put, Body, UseGuards, Req, Post, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsBoolean, IsEmail, MinLength, IsEnum, IsNumber } from 'class-validator';
import { SettingsService } from './settings.service';

enum TradeCurrency {
  USD = 'USD',
  BTC = 'BTC',
  DEMO = 'DEMO',
}

class UpdateNameDto {
  @IsString()
  @MinLength(2)
  name: string;
}

class UpdateEmailDto {
  @IsEmail()
  email: string;
}

class UpdatePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}

class UpdatePhoneDto {
  @IsString()
  @MinLength(8)
  phone: string;
}

class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  profilePictureUrl?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;

  @IsOptional()
  @IsEnum(TradeCurrency)
  tradeCurrency?: TradeCurrency;

  @IsOptional()
  @IsNumber()
  fictitiousBalance?: number;

  @IsOptional()
  @IsBoolean()
  isFictitiousBalanceActive?: boolean;

  @IsOptional()
  @IsBoolean()
  showDollarSign?: boolean;

  @IsOptional()
  @IsString()
  activeContext?: 'ai' | 'agent' | 'all';
}

class UpdateDerivTokenDto {
  @IsString()
  token: string;

  @IsString()
  tradeCurrency: string;

  @IsOptional()
  @IsString()
  activeContext?: 'ai' | 'agent' | 'all';
}

@Controller('settings')
@UseGuards(AuthGuard('jwt'))
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) { }

  @Get()
  async getSettings(@Req() req: any) {
    const userId = req.user.userId;

    const [settings, lastLogin, sessions, activityLogs] = await Promise.all([
      this.settingsService.getSettings(userId),
      this.settingsService.getLastLogin(userId),
      this.settingsService.getSessions(userId),
      this.settingsService.getActivityLogs(userId),
    ]);

    return {
      ...settings,
      lastLogin: lastLogin ? {
        date: lastLogin.lastActivity,
        device: lastLogin.device,
        userAgent: lastLogin.userAgent,
      } : null,
      activeSessions: sessions.length,
      sessions: sessions.slice(0, 5), // Retornar apenas as 5 mais recentes
      activityLogs: activityLogs,
    };
  }

  private getIpAddress(req: any): string {
    return req.ip ||
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.connection?.remoteAddress ||
      'unknown';
  }

  private getUserAgent(req: any): string {
    return req.headers['user-agent'] || 'unknown';
  }

  @Put('name')
  async updateName(@Req() req: any, @Body() body: UpdateNameDto) {
    const userId = req.user.userId;
    return await this.settingsService.updateName(
      userId,
      body.name,
      this.getIpAddress(req),
      this.getUserAgent(req)
    );
  }

  @Put('email')
  async updateEmail(@Req() req: any, @Body() body: UpdateEmailDto) {
    const userId = req.user.userId;
    return await this.settingsService.updateEmail(
      userId,
      body.email,
      this.getIpAddress(req),
      this.getUserAgent(req)
    );
  }

  @Put('password')
  async updatePassword(@Req() req: any, @Body() body: UpdatePasswordDto) {
    const userId = req.user.userId;
    return await this.settingsService.updatePassword(
      userId,
      body.currentPassword,
      body.newPassword,
      this.getIpAddress(req),
      this.getUserAgent(req),
    );
  }

  @Put('phone')
  async updatePhone(@Req() req: any, @Body() body: UpdatePhoneDto) {
    const userId = req.user.userId;
    return await this.settingsService.updatePhone(
      userId,
      body.phone,
      this.getIpAddress(req),
      this.getUserAgent(req)
    );
  }

  @Post('upload-profile-picture')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/profile-pictures',
        filename: (req, file, callback) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = extname(file.originalname);
          const filename = `profile-${uniqueSuffix}${ext}`;
          callback(null, filename);
        },
      }),
      fileFilter: (req, file, callback) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
          return callback(new BadRequestException('Apenas imagens são permitidas!'), false);
        }
        callback(null, true);
      },
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
  )
  async uploadProfilePicture(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Nenhum arquivo foi enviado');
    }

    const userId = req.user.userId;
    // Usar /api/uploads para que o nginx sirva corretamente
    const fileUrl = `/api/uploads/profile-pictures/${file.filename}`;

    // Atualizar a URL da foto no banco de dados
    await this.settingsService.updateSettings(
      userId,
      { profilePictureUrl: fileUrl },
      this.getIpAddress(req),
      this.getUserAgent(req),
    );

    return {
      success: true,
      message: 'Foto de perfil atualizada com sucesso',
      url: fileUrl,
    };
  }

  @Put()
  async updateSettings(@Req() req: any, @Body() body: UpdateSettingsDto) {
    const userId = req.user.userId;
    return await this.settingsService.updateSettings(
      userId,
      body,
      this.getIpAddress(req),
      this.getUserAgent(req),
      body.activeContext
    );
  }

  @Post('deriv-token')
  async updateDerivToken(@Req() req: any, @Body() body: UpdateDerivTokenDto) {
    const userId = req.user.userId;
    return await this.settingsService.updateDerivToken(
      userId,
      body.token,
      body.tradeCurrency,
      this.getIpAddress(req),
      this.getUserAgent(req),
      body.activeContext
    );
  }

  @Get('activity-logs')
  async getActivityLogs(@Req() req: any) {
    const userId = req.user.userId;
    return await this.settingsService.getActivityLogs(userId);
  }

  @Get('sessions')
  async getSessions(@Req() req: any) {
    const userId = req.user.userId;
    return await this.settingsService.getSessions(userId);
  }

  @Put('sessions/end-all')
  async endAllSessions(@Req() req: any) {
    const userId = req.user.userId;
    const token = req.headers.authorization?.replace('Bearer ', '');
    return await this.settingsService.endAllSessions(
      userId,
      token,
      this.getIpAddress(req),
      this.getUserAgent(req)
    );
  }

  @Get('email-connections')
  async getEmailConnections(@Req() req: any) {
    // Endpoint temporário para evitar erro 404
    // Retorna informações básicas sobre conexões de email
    const userId = req.user.userId;
    const settings = await this.settingsService.getSettings(userId);

    return {
      email: settings.email,
      emailNotifications: settings.emailNotifications,
      connections: [],
    };
  }
}

