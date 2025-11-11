import { Controller, Get, Put, Body, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsBoolean, IsEmail, MinLength, IsEnum } from 'class-validator';
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
}

@Controller('settings')
@UseGuards(AuthGuard('jwt'))
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

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

  @Put()
  async updateSettings(@Req() req: any, @Body() body: UpdateSettingsDto) {
    const userId = req.user.userId;
    return await this.settingsService.updateSettings(
      userId, 
      body, 
      this.getIpAddress(req), 
      this.getUserAgent(req)
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
}

