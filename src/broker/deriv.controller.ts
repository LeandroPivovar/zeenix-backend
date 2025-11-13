import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { UserRepository } from '../domain/repositories/user.repository';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import { DerivService } from './deriv.service';
import { SettingsService } from '../settings/settings.service';

class ConnectDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsOptional()
  @IsInt()
  appId?: number;

  @IsOptional()
  @IsString()
  currency?: string;
}

class OAuthAccountDto {
  @IsString()
  loginid: string;

  @IsString()
  token: string;

  @IsString()
  currency: string;
}

class OAuthConnectDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OAuthAccountDto)
  accounts: OAuthAccountDto[];

  @IsOptional()
  @IsInt()
  appId?: number;
}

class StatusDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsInt()
  appId?: number;

  @IsOptional()
  @IsString()
  currency?: string;
}

@Controller('broker/deriv')
export class DerivController {
  private readonly logger = new Logger(DerivController.name);
  private readonly defaultAppId: number;
  private readonly oauthRedirectUrl?: string;

  constructor(
    private readonly derivService: DerivService,
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepository: UserRepository,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
  ) {
    this.defaultAppId = Number(this.configService.get('DERIV_APP_ID') ?? 1089);
    this.oauthRedirectUrl = this.configService.get<string>('DERIV_OAUTH_REDIRECT_URL');
  }

  private getCurrencyPrefix(currency?: string): string {
    switch ((currency || '').toUpperCase()) {
      case 'USD':
        return '$';
      case 'EUR':
        return '€';
      case 'BTC':
        return '₿';
      case 'DEMO':
        return 'D$';
      default:
        return currency ? `${currency} ` : '';
    }
  }

  private normalizePreferredCurrency(currency?: string): string {
    const upper = (currency || 'USD').toUpperCase();
    return upper === 'DEMO' ? 'USD' : upper;
  }

  private async getPreferredCurrency(userId: string, source: string): Promise<string> {
    try {
      const settings = await this.settingsService.getSettings(userId);
      return settings.tradeCurrency ?? 'USD';
    } catch (error) {
      this.logger.warn(
        `[${source}] Não foi possível obter tradeCurrency de ${userId}: ${error.message}`,
      );
      return 'USD';
    }
  }

  private buildResponse(
    account: { 
      loginid?: string; 
      currency?: string; 
      balance?: any; 
      balancesByCurrency?: Record<string, number>;
      balancesByCurrencyDemo?: Record<string, number>;
      balancesByCurrencyReal?: Record<string, number>;
      aggregatedBalances?: any;
    },
    preferredCurrency: string,
  ) {
    const currency = account?.currency ?? preferredCurrency;
    const balanceData = account?.balance;
    let normalizedBalance = balanceData;

    if (
      balanceData !== null &&
      balanceData !== undefined &&
      typeof balanceData !== 'object'
    ) {
      normalizedBalance = { value: balanceData, currency };
    }

    const response = {
      loginid: account?.loginid ?? null,
      currency,
      balance: normalizedBalance ?? null,
      preferredCurrency,
      currencyPrefix: this.getCurrencyPrefix(currency),
      preferredCurrencyPrefix: this.getCurrencyPrefix(preferredCurrency),
      balancesByCurrency: account?.balancesByCurrency ?? {},
      balancesByCurrencyDemo: account?.balancesByCurrencyDemo ?? {},
      balancesByCurrencyReal: account?.balancesByCurrencyReal ?? {},
      aggregatedBalances: account?.aggregatedBalances ?? null,
      // Sempre incluir tokensByLoginId, mesmo que vazio
      tokensByLoginId: (account && 'tokensByLoginId' in account && account.tokensByLoginId) ? account.tokensByLoginId : {},
    };
    
    // Log para debug - verificar se os campos estão presentes
    this.logger.log(`[DerivController] buildResponse - balancesByCurrencyDemo: ${JSON.stringify(response.balancesByCurrencyDemo)}, balancesByCurrencyReal: ${JSON.stringify(response.balancesByCurrencyReal)}, hasTokensByLoginId: ${!!response.tokensByLoginId}`);
    
    return response;
  }

  private async performConnection(params: {
    userId: string;
    token: string;
    appId: number;
    currencyOverride?: string;
    source: string;
  }) {
    const { userId, token, appId, currencyOverride, source } = params;
    const preferredCurrencyRaw = await this.getPreferredCurrency(userId, source);
    const normalizedPreferredCurrency = this.normalizePreferredCurrency(preferredCurrencyRaw);
    const targetCurrency = (currencyOverride ? currencyOverride : normalizedPreferredCurrency).toUpperCase();

    this.logger.log(`[${source}] Iniciando conexão Deriv para usuário ${userId}`);
    const account = await this.derivService.connectAndGetAccount(token, appId, targetCurrency);
    this.logger.log(`[${source}] Dados recebidos da Deriv: ${JSON.stringify(account)}`);

    const balancesByCurrency = account?.balancesByCurrency ?? {};
    
    // Se targetCurrency for DEMO, não verificar se existe "DEMO" nas moedas
    // pois DEMO não é uma moeda, mas sim um tipo de conta (demo em USD, BTC, etc)
    if (targetCurrency !== 'DEMO' && balancesByCurrency[targetCurrency] === undefined) {
      if (!currencyOverride && targetCurrency === 'USD') {
        this.logger.warn(
          `[${source}] Conta USD real não encontrada; mantendo fallback automático. Contas disponíveis: ${JSON.stringify(balancesByCurrency)}`,
        );
      } else {
        this.logger.warn(
          `[${source}] Moeda preferida (${targetCurrency}) não encontrada entre as contas retornadas: ${JSON.stringify(balancesByCurrency)}`,
        );
        throw new BadRequestException(
          `Nenhuma conta Deriv retornada corresponde à moeda preferida (${targetCurrency}). ` +
            'Ajuste a preferência de moeda ou selecione a conta correta ao autorizar o OAuth.',
        );
      }
    }
    
    // Se for DEMO, verificar se há pelo menos uma conta demo disponível
    if (targetCurrency === 'DEMO') {
      const hasDemoAccount = Object.values(account?.accountsByCurrency ?? {}).some(
        accounts => accounts.some(acc => acc.isDemo === true)
      );
      if (!hasDemoAccount) {
        this.logger.warn(
          `[${source}] Nenhuma conta demo encontrada nas contas retornadas`,
        );
        throw new BadRequestException(
          'Nenhuma conta demo Deriv encontrada. ' +
            'Certifique-se de ter uma conta demo ativa na Deriv.',
        );
      }
    }

    const preciseAccount = this.derivService.pickAccountForCurrency(account, targetCurrency);
    const accountForCurrency = {
      ...preciseAccount,
      balancesByCurrency,
      balancesByCurrencyDemo: account?.balancesByCurrencyDemo,
      balancesByCurrencyReal: account?.balancesByCurrencyReal,
      aggregatedBalances: account?.aggregatedBalances,
    };

    const sessionPayload = {
      ...this.buildResponse(accountForCurrency, normalizedPreferredCurrency),
      appId,
    };

    this.logger.log(`[${source}] Salvando dados iniciais no banco de dados...`);
    // Log para debug - verificar o que está sendo salvo como raw
    this.logger.log(`[${source}] DEBUG - accountForCurrency sendo salvo como raw: ${JSON.stringify({
      hasBalancesByCurrencyDemo: !!accountForCurrency?.balancesByCurrencyDemo,
      hasBalancesByCurrencyReal: !!accountForCurrency?.balancesByCurrencyReal,
      balancesByCurrencyDemo: accountForCurrency?.balancesByCurrencyDemo,
      balancesByCurrencyReal: accountForCurrency?.balancesByCurrencyReal,
      balancesByCurrency: accountForCurrency?.balancesByCurrency
    })}`);
    this.derivService.setSession(userId, sessionPayload);
    await this.userRepository.updateDerivInfo(userId, {
      loginId: sessionPayload.loginid ?? accountForCurrency.loginid ?? userId,
      currency: sessionPayload.currency ?? accountForCurrency.currency,
      balance: sessionPayload.balance?.value ?? undefined,
      raw: accountForCurrency,
    });
    this.logger.log(`[${source}] Dados iniciais salvos no banco de dados para usuário ${userId}`);

    this.logger.log(
      `[${source}] Fazendo nova consulta à API Deriv para buscar saldo atualizado para usuário ${userId}...`,
    );
    try {
      const refreshedAccount = await this.derivService.refreshBalance(
        token,
        appId,
        targetCurrency,
      );
      this.logger.log(
        `[${source}] Saldo atualizado obtido da API Deriv: ${JSON.stringify(refreshedAccount)}`,
      );

      const refreshedSessionPayload = {
        ...this.buildResponse(refreshedAccount, normalizedPreferredCurrency),
        appId,
      };

      this.logger.log(`[${source}] Atualizando banco de dados com dados atualizados...`);
      // Log para debug - verificar o que está sendo salvo como raw
      this.logger.log(`[${source}] DEBUG - refreshedAccount sendo salvo como raw: ${JSON.stringify({
        hasBalancesByCurrencyDemo: !!refreshedAccount?.balancesByCurrencyDemo,
        hasBalancesByCurrencyReal: !!refreshedAccount?.balancesByCurrencyReal,
        balancesByCurrencyDemo: refreshedAccount?.balancesByCurrencyDemo,
        balancesByCurrencyReal: refreshedAccount?.balancesByCurrencyReal,
        balancesByCurrency: refreshedAccount?.balancesByCurrency
      })}`);
      await this.userRepository.updateDerivInfo(userId, {
        loginId: refreshedSessionPayload.loginid ?? refreshedAccount.loginid ?? userId,
        currency: refreshedSessionPayload.currency ?? refreshedAccount.currency,
        balance:
          refreshedSessionPayload.balance?.value ??
          refreshedAccount.balance?.value ??
          undefined,
        raw: refreshedAccount,
      });
      this.derivService.setSession(userId, refreshedSessionPayload);
      this.logger.log(
        `[${source}] Dados atualizados no banco após nova consulta à API Deriv`,
      );

      this.logger.log(`[${source}] Buscando dados do banco para verificação...`);
      const derivInfoFromDb = await this.userRepository.getDerivInfo(userId);
      if (derivInfoFromDb) {
        this.logger.log(
          `[${source}] Dados encontrados no banco após atualização - LoginID: ${derivInfoFromDb.loginId}, Currency: ${derivInfoFromDb.currency}, Balance: ${derivInfoFromDb.balance}`,
        );
      } else {
        this.logger.warn(
          `[${source}] Nenhum dado encontrado no banco após atualização para usuário ${userId}`,
        );
      }

      return refreshedSessionPayload;
    } catch (error) {
      this.logger.error(
        `[${source}] Erro ao buscar saldo atualizado da API Deriv: ${error.message}`,
      );
      if (error.stack) {
        this.logger.error(`[${source}] Stack trace: ${error.stack}`);
      }
      return sessionPayload;
    }
  }

  private async clearDerivData(userId: string, source: string) {
    this.logger.error(
      `[${source}] Token inválido (401) - Limpando dados da Deriv do banco para usuário ${userId}`,
    );
    try {
      await this.userRepository.clearDerivInfo(userId);
      const session = this.derivService.getSession(userId);
      if (session) {
        this.derivService.setSession(userId, null);
      }
      this.logger.log(
        `[${source}] Dados da Deriv removidos do banco e sessão para usuário ${userId}`,
      );
    } catch (clearError) {
      this.logger.error(`[${source}] Erro ao limpar dados da Deriv: ${clearError.message}`);
    }
  }

  @Get('oauth/url')
  @UseGuards(AuthGuard('jwt'))
  async getOAuthUrl(@Query('state') state?: string) {
    const params = new URLSearchParams({
      app_id: this.defaultAppId.toString(),
    });
    if (this.oauthRedirectUrl) {
      params.set('redirect_uri', this.oauthRedirectUrl);
    }
    if (state) {
      params.set('state', state);
    }
    const url = `https://oauth.deriv.com/oauth2/authorize?${params.toString()}`;
    return { url };
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  async connect(@Body() body: ConnectDto, @Req() req: any) {
    const userId = req.user.userId as string;
    const { token, appId, currency } = body;
    const appIdToUse = appId ?? this.defaultAppId;

    try {
      return await this.performConnection({
        userId,
        token,
        appId: appIdToUse,
        currencyOverride: currency,
        source: 'CONNECT',
      });
    } catch (error) {
      const isUnauthorized =
        error.status === 401 ||
        error.statusCode === 401 ||
        (error.message &&
          (error.message.toLowerCase().includes('token') ||
            error.message.toLowerCase().includes('invalid') ||
            error.message.toLowerCase().includes('unauthorized')));

      if (isUnauthorized) {
        await this.clearDerivData(userId, 'CONNECT');
      }

      this.logger.error(
        `[CONNECT] Erro na conexão Deriv: ${error.message || JSON.stringify(error)}`,
      );
      throw error;
    }
  }

  @Post('connect/oauth')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  async connectOAuth(@Body() body: OAuthConnectDto, @Req() req: any) {
    const userId = req.user.userId as string;
    const appId = body.appId ?? this.defaultAppId;

    const preferredCurrency = await this.getPreferredCurrency(userId, 'CONNECT-OAUTH');
    const normalizedAccounts = body.accounts.map(account => ({
      loginid: account.loginid,
      token: account.token,
      currency: account.currency?.toUpperCase() || 'USD',
    }));

    const expectedCurrency = preferredCurrency.toUpperCase();
    const selectedAccount = normalizedAccounts.find(
      account => account.currency === expectedCurrency,
    );

    if (!selectedAccount) {
      throw new BadRequestException(
        `Nenhuma conta OAuth retornada corresponde à moeda preferida (${expectedCurrency}). ` +
          'Selecione a conta correta na Deriv ou ajuste sua preferência nas configurações.',
      );
    }

    try {
      const result = await this.performConnection({
        userId,
        token: selectedAccount.token,
        appId,
        currencyOverride: selectedAccount.currency,
        source: 'CONNECT-OAUTH',
      });

      // Armazenar tokens mapeados por loginid no raw para uso futuro
      const tokensByLoginId: Record<string, string> = {};
      normalizedAccounts.forEach(account => {
        if (account.loginid && account.token) {
          tokensByLoginId[account.loginid] = account.token;
        }
      });

      // Atualizar o raw com os tokens
      const derivInfo = await this.userRepository.getDerivInfo(userId);
      if (derivInfo?.raw) {
        derivInfo.raw.tokensByLoginId = tokensByLoginId;
        await this.userRepository.updateDerivInfo(userId, {
          loginId: derivInfo.loginId || result.loginid || selectedAccount.loginid,
          raw: derivInfo.raw,
        });
        this.logger.log(`[CONNECT-OAUTH] Tokens armazenados para ${Object.keys(tokensByLoginId).length} contas`);
      }

      return {
        ...result,
        loginid: result.loginid ?? selectedAccount.loginid,
        tokensByLoginId, // Retornar tokens para o frontend também
      };
    } catch (error) {
      const isUnauthorized =
        error.status === 401 ||
        error.statusCode === 401 ||
        (error.message &&
          (error.message.toLowerCase().includes('token') ||
            error.message.toLowerCase().includes('invalid') ||
            error.message.toLowerCase().includes('unauthorized')));

      if (isUnauthorized) {
        await this.clearDerivData(userId, 'CONNECT-OAUTH');
      }

      this.logger.error(
        `[CONNECT-OAUTH] Erro na conexão Deriv: ${error.message || JSON.stringify(error)}`,
      );
      throw error;
    }
  }

  @Post('status')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async status(@Body() body: StatusDto, @Req() req: any) {
    const userId = req.user.userId as string;
    const { token, appId, currency } = body;
    const preferredCurrencyRaw = await this.getPreferredCurrency(userId, 'STATUS');
    const normalizedPreferredCurrency = this.normalizePreferredCurrency(preferredCurrencyRaw);
    const targetCurrency = (currency ? currency : normalizedPreferredCurrency).toUpperCase();
    const appIdToUse = appId ?? this.defaultAppId;

    if (token) {
      this.logger.log(`[STATUS] Buscando saldo atualizado da Deriv para usuário ${userId}`);
      try {
        const account = await this.derivService.refreshBalance(
          token,
          appIdToUse,
          targetCurrency,
        );
        this.logger.log(`[STATUS] Account recebido do service: ${JSON.stringify({
          hasBalancesByCurrencyDemo: !!account.balancesByCurrencyDemo,
          hasBalancesByCurrencyReal: !!account.balancesByCurrencyReal,
          balancesByCurrencyDemo: account.balancesByCurrencyDemo,
          balancesByCurrencyReal: account.balancesByCurrencyReal
        })}`);
        this.logger.log(`[STATUS] DEBUG - account completo recebido do service: ${JSON.stringify(account)}`);
        
        // Buscar tokens do raw antes de criar sessionPayload
        const derivInfoForTokens = await this.userRepository.getDerivInfo(userId);
        const tokensByLoginIdForAccount = derivInfoForTokens?.raw?.tokensByLoginId || {};
        
        // Adicionar tokensByLoginId ao account antes de passar para buildResponse
        const accountWithTokens = {
          ...account,
          tokensByLoginId: tokensByLoginIdForAccount,
        };
        
        const sessionPayload = {
          ...this.buildResponse(accountWithTokens, normalizedPreferredCurrency),
          appId: appIdToUse,
        };
        this.logger.log(`[STATUS] SessionPayload após buildResponse: ${JSON.stringify({
          balancesByCurrency: sessionPayload.balancesByCurrency,
          balancesByCurrencyDemo: sessionPayload.balancesByCurrencyDemo,
          balancesByCurrencyReal: sessionPayload.balancesByCurrencyReal
        })}`);
        this.derivService.setSession(userId, sessionPayload);
        this.logger.log(`[STATUS] DEBUG - account sendo salvo como raw: ${JSON.stringify({
          hasBalancesByCurrencyDemo: !!account.balancesByCurrencyDemo,
          hasBalancesByCurrencyReal: !!account.balancesByCurrencyReal,
          balancesByCurrencyDemo: account.balancesByCurrencyDemo,
          balancesByCurrencyReal: account.balancesByCurrencyReal
        })}`);
        await this.userRepository.updateDerivInfo(userId, {
          loginId: sessionPayload.loginid ?? account.loginid ?? userId,
          currency: sessionPayload.currency ?? account.currency,
          balance: sessionPayload.balance?.value ?? account.balance?.value ?? undefined,
          raw: account,
        });
        this.logger.log(`[STATUS] Saldo atualizado com sucesso: ${JSON.stringify(account)}`);
        this.logger.log(`[STATUS] SessionPayload retornado: ${JSON.stringify({
          balancesByCurrency: sessionPayload.balancesByCurrency,
          balancesByCurrencyDemo: sessionPayload.balancesByCurrencyDemo,
          balancesByCurrencyReal: sessionPayload.balancesByCurrencyReal
        })}`);
        // Buscar tokens do raw se disponíveis
        const derivInfo = await this.userRepository.getDerivInfo(userId);
        const tokensByLoginId = derivInfo?.raw?.tokensByLoginId || {};
        
        this.logger.log(`[STATUS] Tokens encontrados no banco: ${JSON.stringify({
          hasRaw: !!derivInfo?.raw,
          hasTokensByLoginId: !!derivInfo?.raw?.tokensByLoginId,
          tokensByLoginIdKeys: Object.keys(tokensByLoginId),
          tokensByLoginIdCount: Object.keys(tokensByLoginId).length
        })}`);

        // Garantir que os campos estejam presentes na resposta final
        const finalResponse = {
          ...sessionPayload,
          balancesByCurrency: sessionPayload.balancesByCurrency ?? {},
          balancesByCurrencyDemo: sessionPayload.balancesByCurrencyDemo ?? {},
          balancesByCurrencyReal: sessionPayload.balancesByCurrencyReal ?? {},
          tokensByLoginId, // Incluir tokens mapeados por loginid
          source: 'deriv_api',
        };
        this.logger.log(`[STATUS] Resposta final retornada: ${JSON.stringify({
          balancesByCurrency: finalResponse.balancesByCurrency,
          balancesByCurrencyDemo: finalResponse.balancesByCurrencyDemo,
          balancesByCurrencyReal: finalResponse.balancesByCurrencyReal,
          hasTokensByLoginId: !!finalResponse.tokensByLoginId,
          tokensByLoginIdKeys: Object.keys(finalResponse.tokensByLoginId || {}),
          tokensByLoginId: finalResponse.tokensByLoginId
        })}`);
        // Garantir que tokensByLoginId sempre esteja presente, mesmo que vazio
        if (!finalResponse.tokensByLoginId) {
          finalResponse.tokensByLoginId = {};
        }
        return finalResponse;
      } catch (error) {
        this.logger.error(`[STATUS] Erro ao buscar saldo da Deriv: ${error.message}`);
      }
    }

    const session = this.derivService.getSession(userId);
    if (session) {
      this.logger.log(`[STATUS] Retornando dados da sessão em memória para usuário ${userId}`);
      // Log para debug - verificar o que está na sessão
      this.logger.log(`[STATUS] DEBUG - dados da sessão: ${JSON.stringify({
        hasBalancesByCurrencyDemo: !!session?.balancesByCurrencyDemo,
        hasBalancesByCurrencyReal: !!session?.balancesByCurrencyReal,
        balancesByCurrencyDemo: session?.balancesByCurrencyDemo,
        balancesByCurrencyReal: session?.balancesByCurrencyReal,
        balancesByCurrency: session?.balancesByCurrency
      })}`);
      // Buscar tokens do raw se disponíveis
      const derivInfo = await this.userRepository.getDerivInfo(userId);
      const tokensByLoginId = derivInfo?.raw?.tokensByLoginId || {};
      
      this.logger.log(`[STATUS] Tokens encontrados no banco (sessão): ${JSON.stringify({
        hasRaw: !!derivInfo?.raw,
        hasTokensByLoginId: !!derivInfo?.raw?.tokensByLoginId,
        tokensByLoginIdKeys: Object.keys(tokensByLoginId),
        tokensByLoginIdCount: Object.keys(tokensByLoginId).length
      })}`);

      // Garantir que os campos estejam presentes mesmo se não estiverem na sessão
      const sessionResponse = {
        ...session,
        balancesByCurrency: session?.balancesByCurrency ?? {},
        balancesByCurrencyDemo: session?.balancesByCurrencyDemo ?? {},
        balancesByCurrencyReal: session?.balancesByCurrencyReal ?? {},
        tokensByLoginId, // Incluir tokens mapeados por loginid
        source: 'session',
      };
      this.logger.log(`[STATUS] DEBUG - sessionResponse final: ${JSON.stringify({
        balancesByCurrency: sessionResponse.balancesByCurrency,
        balancesByCurrencyDemo: sessionResponse.balancesByCurrencyDemo,
        balancesByCurrencyReal: sessionResponse.balancesByCurrencyReal,
        hasTokensByLoginId: !!sessionResponse.tokensByLoginId,
        tokensByLoginIdKeys: Object.keys(sessionResponse.tokensByLoginId || {})
      })}`);
      // Garantir que tokensByLoginId sempre esteja presente, mesmo que vazio
      if (!sessionResponse.tokensByLoginId) {
        sessionResponse.tokensByLoginId = {};
      }
      return sessionResponse;
    }

    const derivInfo = await this.userRepository.getDerivInfo(userId);
    if (derivInfo && derivInfo.loginId) {
      this.logger.log(`[STATUS] Retornando dados do banco de dados para usuário ${userId}`);
      
      // Se temos dados raw completos, usar eles (inclui balancesByCurrencyDemo e balancesByCurrencyReal)
      const accountData = derivInfo.raw || {
        loginid: derivInfo.loginId ?? undefined,
        currency: derivInfo.currency ?? undefined,
        balance: derivInfo.balance
          ? {
              value: parseFloat(derivInfo.balance),
              currency: derivInfo.currency ?? normalizedPreferredCurrency,
            }
          : null,
      };
      
      // Log para debug - verificar o que está no raw
      this.logger.log(`[STATUS] DEBUG - accountData do banco: ${JSON.stringify({
        hasRaw: !!derivInfo.raw,
        hasBalancesByCurrencyDemo: !!accountData?.balancesByCurrencyDemo,
        hasBalancesByCurrencyReal: !!accountData?.balancesByCurrencyReal,
        balancesByCurrencyDemo: accountData?.balancesByCurrencyDemo,
        balancesByCurrencyReal: accountData?.balancesByCurrencyReal,
        balancesByCurrency: accountData?.balancesByCurrency
      })}`);
      
      // Garantir que accountData tenha os campos necessários mesmo se não estiverem no raw
      if (!accountData.balancesByCurrencyDemo) {
        accountData.balancesByCurrencyDemo = {};
      }
      if (!accountData.balancesByCurrencyReal) {
        accountData.balancesByCurrencyReal = {};
      }
      if (!accountData.balancesByCurrency) {
        accountData.balancesByCurrency = {};
      }
      
      const formatted = {
        ...this.buildResponse(accountData, normalizedPreferredCurrency),
        appId: appIdToUse,
      };
      
      // Log para debug - verificar o que está sendo retornado após buildResponse
      this.logger.log(`[STATUS] DEBUG - formatted após buildResponse: ${JSON.stringify({
        balancesByCurrencyDemo: formatted.balancesByCurrencyDemo,
        balancesByCurrencyReal: formatted.balancesByCurrencyReal,
        balancesByCurrency: formatted.balancesByCurrency
      })}`);
      
      // Buscar tokens do raw se disponíveis
      const tokensByLoginId = derivInfo.raw?.tokensByLoginId || {};
      
      this.logger.log(`[STATUS] Tokens encontrados no banco (db): ${JSON.stringify({
        hasRaw: !!derivInfo.raw,
        hasTokensByLoginId: !!derivInfo.raw?.tokensByLoginId,
        tokensByLoginIdKeys: Object.keys(tokensByLoginId),
        tokensByLoginIdCount: Object.keys(tokensByLoginId).length
      })}`);

      // Garantir que os campos estejam presentes na resposta final
      const dbResponse = {
        ...formatted,
        balancesByCurrency: formatted.balancesByCurrency ?? {},
        balancesByCurrencyDemo: formatted.balancesByCurrencyDemo ?? {},
        balancesByCurrencyReal: formatted.balancesByCurrencyReal ?? {},
        tokensByLoginId, // Incluir tokens mapeados por loginid
        source: 'db',
      };
      
      this.logger.log(`[STATUS] DEBUG - dbResponse final: ${JSON.stringify({
        balancesByCurrency: dbResponse.balancesByCurrency,
        balancesByCurrencyDemo: dbResponse.balancesByCurrencyDemo,
        balancesByCurrencyReal: dbResponse.balancesByCurrencyReal,
        hasTokensByLoginId: !!dbResponse.tokensByLoginId,
        tokensByLoginIdKeys: Object.keys(dbResponse.tokensByLoginId || {})
      })}`);
      // Garantir que tokensByLoginId sempre esteja presente, mesmo que vazio
      if (!dbResponse.tokensByLoginId) {
        dbResponse.tokensByLoginId = {};
      }
      return dbResponse;
    }

    this.logger.log(`[STATUS] Nenhuma conexão Deriv encontrada para usuário ${userId}`);
    return {
      loginid: null,
      tokensByLoginId: {}, // Sempre retornar, mesmo que vazio
      currency: null,
      balance: null,
      preferredCurrency: normalizedPreferredCurrency,
      currencyPrefix: this.getCurrencyPrefix(normalizedPreferredCurrency),
      preferredCurrencyPrefix: this.getCurrencyPrefix(normalizedPreferredCurrency),
      appId: appIdToUse,
    };
  }
}