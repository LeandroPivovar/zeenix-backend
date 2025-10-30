import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { DerivService } from './deriv.service';
import { UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Inject } from '@nestjs/common';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';

class ConnectDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsOptional()
  @IsInt()
  appId?: number;
}

@Controller('broker/deriv')
export class DerivController {
  constructor(
    private readonly derivService: DerivService,
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository,
  ) {}

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  async connect(@Body() body: ConnectDto, @Req() req: any) {
    const { token, appId } = body;
    const account = await this.derivService.connectAndGetAccount(token, appId ?? 1089);
    // guardar na "sessão" (cache em memória) e no banco
    this.derivService.setSession(req.user.userId, account);
    await this.userRepository.updateDerivInfo(req.user.userId, {
      loginId: account.loginid,
      currency: account.currency,
      balance: account.balance?.balance ?? account.balance?.value ?? undefined,
      raw: account,
    });
    return {
      loginid: account.loginid,
      currency: account.currency,
      balance: account.balance,
    };
  }

  @Post('status')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async status(@Req() req: any) {
    const userId = req.user.userId as string;
    const session = this.derivService.getSession(userId);
    if (session) {
      return {
        loginid: session.loginid,
        currency: session.currency,
        balance: session.balance,
        source: 'session',
      };
    }
    const user = await this.userRepository.findById(userId);
    if (user) {
      // repository to domain doesn't expose deriv fields, so read via repo layer directly if needed
      // fallback minimal response
      return { loginid: (user as any).derivLoginId ?? null, currency: (user as any).derivCurrency ?? null, balance: (user as any).derivBalance ?? null, source: 'db' };
    }
    return { loginid: null };
  }
}


