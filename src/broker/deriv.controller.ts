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
  Res,
  UseGuards,
  HttpException,
  Param,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service';
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
import { DerivWebSocketManagerService } from './deriv-websocket-manager.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { TradeEntity, TradeStatus } from '../infrastructure/database/entities/trade.entity';
import { v4 as uuidv4 } from 'uuid';
import { CopyTradingService } from '../copy-trading/copy-trading.service';

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

class BuyContractDto {
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsString()
  @IsNotEmpty()
  contractType: string; // 'CALL' ou 'PUT'

  @IsInt()
  duration: number;

  @IsString()
  @IsNotEmpty()
  durationUnit: string; // 'm' ou 't'

  @IsInt()
  amount: number;

  @IsOptional()
  @IsString()
  proposalId?: string;

  @IsOptional()
  @IsInt()
  barrier?: number; // Para contratos DIGIT* (dígito previsto 0-9)

  @IsOptional()
  @IsInt()
  multiplier?: number; // Para contratos MULTUP/MULTDOWN

  @IsOptional()
  @IsString()
  token?: string; // Token explícito (padrão IA)
}

class SellContractDto {
  @IsString()
  @IsNotEmpty()
  contractId: string;
}

class ProposalDto {
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsString()
  @IsNotEmpty()
  contractType: string;

  @IsInt()
  duration: number;

  @IsString()
  @IsNotEmpty()
  durationUnit: string;

  @IsInt()
  amount: number;

  @IsOptional()
  @IsInt()
  barrier?: number; // Para contratos DIGIT* (dígito previsto 0-9)

  @IsOptional()
  @IsInt()
  multiplier?: number; // Para contratos MULTUP/MULTDOWN

  @IsOptional()
  @IsString()
  loginid?: string;
}

class DefaultValuesDto {
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsString()
  @IsNotEmpty()
  contractType: string;
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
    private readonly wsManager: DerivWebSocketManagerService,
    @InjectRepository(TradeEntity)
    private readonly tradeRepository: Repository<TradeEntity>,
    private readonly copyTradingService: CopyTradingService,
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

  private async getPreferredCurrency(userId: string, source: string): Promise<string> {
    try {
      const settings = await this.settingsService.getSettings(userId);
      return (settings.tradeCurrency || 'USD').toUpperCase();
    } catch (error) {
      this.logger.warn(
        `[${source}] Não foi possível obter tradeCurrency de ${userId}: ${error.message}`,
      );
      return 'USD';
    }
  }

  private async performConnection(params: {
    userId: string;
    token: string;
    appId: number;
    currencyOverride?: string;
    source: string;
  }) {
    const { userId, token, appId, currencyOverride, source } = params;
    const preferredCurrency = await this.getPreferredCurrency(userId, source);
    const targetCurrency = (currencyOverride ? currencyOverride : 'USD').toUpperCase();

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
          `[${source}] Moeda (${targetCurrency}) não encontrada entre as contas retornadas: ${JSON.stringify(balancesByCurrency)}`,
        );
        throw new BadRequestException(
          `Nenhuma conta Deriv retornada corresponde à moeda ${targetCurrency}. ` +
          'Selecione a conta USD real correta ao autorizar o OAuth.',
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

    // Buscar informações existentes do banco para não perder tokens já armazenados
    const derivInfo = await this.userRepository.getDerivInfo(userId);
    const existingTokens = derivInfo?.raw?.tokensByLoginId || {};

    // Garantir que o token atual seja salvo no raw.tokensByLoginId para uso futuro (ex: buyContract)
    const tokensByLoginId = { ...existingTokens };
    if (preciseAccount.loginid) {
      tokensByLoginId[preciseAccount.loginid] = token;
      this.logger.log(`[${source}] Token mesclado para loginid ${preciseAccount.loginid}. Total: ${Object.keys(tokensByLoginId).length}`);
    }

    const accountForCurrency = {
      ...preciseAccount,
      balancesByCurrency,
      balancesByCurrencyDemo: account?.balancesByCurrencyDemo,
      balancesByCurrencyReal: account?.balancesByCurrencyReal,
      aggregatedBalances: account?.aggregatedBalances,
      tokensByLoginId,
    };

    const sessionPayload = {
      ...this.buildResponse(accountForCurrency, preferredCurrency),
      appId,
    };

    this.logger.log(`[${source}] Salvando dados iniciais no banco de dados...`);
    // Log para debug - verificar o que está sendo salvo como raw
    this.logger.log(`[${source}] DEBUG - accountForCurrency sendo salvo como raw: ${JSON.stringify({
      hasBalancesByCurrencyDemo: !!accountForCurrency?.balancesByCurrencyDemo,
      hasBalancesByCurrencyReal: !!accountForCurrency?.balancesByCurrencyReal,
      balancesByCurrencyDemo: accountForCurrency?.balancesByCurrencyDemo,
      balancesByCurrencyReal: accountForCurrency?.balancesByCurrencyReal,
      balancesByCurrency: accountForCurrency?.balancesByCurrency,
      hasTokensByLoginId: !!accountForCurrency?.tokensByLoginId
    })}`);
    this.derivService.setSession(userId, sessionPayload);
    // Identificar tipo de token para salvar (VRTC = Demo)
    const isDemo = preciseAccount.loginid?.startsWith('VRTC');
    const tokenUpdates: { tokenDemo?: string; tokenReal?: string } = {};

    if (isDemo) {
      tokenUpdates.tokenDemo = token;
    } else {
      tokenUpdates.tokenReal = token;
    }

    await this.userRepository.updateDerivInfo(userId, {
      loginId: sessionPayload.loginid ?? accountForCurrency.loginid ?? userId,
      currency: sessionPayload.currency ?? accountForCurrency.currency,
      balance: sessionPayload.balance?.value ?? undefined,
      raw: accountForCurrency,
      ...tokenUpdates
    });
    this.logger.log(`[${source}] Dados iniciais salvos no banco para usuário ${userId}. Tokens salvos: ${JSON.stringify(Object.keys(tokenUpdates))}`);

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
        ...this.buildResponse(refreshedAccount, preferredCurrency),
        appId,
      };

      // Garantir que os tokens sejam preservados no refresh
      const tokensToKeep = refreshedAccount.tokensByLoginId && Object.keys(refreshedAccount.tokensByLoginId).length > 0
        ? { ...accountForCurrency.tokensByLoginId, ...refreshedAccount.tokensByLoginId }
        : accountForCurrency.tokensByLoginId;

      const refreshedRaw = {
        ...refreshedAccount,
        tokensByLoginId: tokensToKeep
      };

      this.logger.log(`[${source}] Atualizando banco de dados com dados atualizados...`);
      // Log para debug - verificar o que está sendo salvo como raw
      this.logger.log(`[${source}] DEBUG - refreshedAccount sendo salvo como raw: ${JSON.stringify({
        hasBalancesByCurrencyDemo: !!refreshedRaw?.balancesByCurrencyDemo,
        hasBalancesByCurrencyReal: !!refreshedRaw?.balancesByCurrencyReal,
        balancesByCurrencyDemo: refreshedRaw?.balancesByCurrencyDemo,
        balancesByCurrencyReal: refreshedRaw?.balancesByCurrencyReal,
        balancesByCurrency: refreshedRaw?.balancesByCurrency,
        hasTokensByLoginId: !!refreshedRaw?.tokensByLoginId
      })}`);
      await this.userRepository.updateDerivInfo(userId, {
        loginId: refreshedSessionPayload.loginid ?? refreshedRaw.loginid ?? userId,
        currency: refreshedSessionPayload.currency ?? refreshedRaw.currency,
        balance:
          refreshedSessionPayload.balance?.value ??
          refreshedRaw.balance?.value ??
          undefined,
        raw: refreshedRaw,
        // Não precisamos atualizar tokens aqui pois já foram salvos ou mantidos
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
      const errorMsg = error.message || JSON.stringify(error);
      const isAppIdError = errorMsg.includes('app ID') || errorMsg.includes('AppIdInvalid');

      if (isAppIdError) {
        this.logger.error(`[CONNECT] ❌ Erro de App ID: O token não é válido para o APP_ID atual. Limpando dados para forçar re-autenticação.`);
        await this.clearDerivData(userId, 'CONNECT');
        throw new BadRequestException('Seu token Deriv não é válido para o aplicativo atual configurado no servidor (APP_ID mudou). Por favor, reconecte sua conta.');
      }

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
        `[CONNECT] Erro na conexão Deriv: ${errorMsg}`,
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

    const normalizedAccounts = body.accounts.map(account => ({
      loginid: account.loginid,
      token: account.token,
      currency: account.currency?.toUpperCase() || 'USD',
    }));

    const expectedCurrency = 'USD';
    const selectedAccount = normalizedAccounts.find(
      account => account.currency === expectedCurrency,
    );

    if (!selectedAccount) {
      throw new BadRequestException(
        `Nenhuma conta OAuth retornada corresponde à moeda ${expectedCurrency}. ` +
        'Selecione a conta USD real na Deriv antes de autorizar o OAuth.',
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

      // Atualizar o raw e os tokens
      const derivInfo = await this.userRepository.getDerivInfo(userId);

      let tokenDemo: string | undefined;
      let tokenReal: string | undefined;

      // Iterar sobre accounts para extrair tokens demo e real
      normalizedAccounts.forEach(account => {
        if (account.loginid?.startsWith('VRTC')) {
          tokenDemo = account.token;
        } else {
          // Assumindo que qualquer outro é Real (CR, etc)
          tokenReal = account.token;
        }
      });

      if (derivInfo?.raw) {
        derivInfo.raw.tokensByLoginId = tokensByLoginId;
        await this.userRepository.updateDerivInfo(userId, {
          loginId: derivInfo.loginId || result.loginid || selectedAccount.loginid,
          raw: derivInfo.raw,
          tokenDemo,
          tokenReal
        });
        this.logger.log(`[CONNECT-OAUTH] Tokens armazenados para ${Object.keys(tokensByLoginId).length} contas. Demo: ${!!tokenDemo}, Real: ${!!tokenReal}`);
      }

      return {
        ...result,
        loginid: result.loginid ?? selectedAccount.loginid,
        tokensByLoginId, // Retornar tokens para o frontend também
      };
    } catch (error) {
      const errorMsg = error.message || JSON.stringify(error);
      const isAppIdError = errorMsg.includes('app ID') || errorMsg.includes('AppIdInvalid');

      if (isAppIdError) {
        this.logger.error(`[CONNECT-OAUTH] ❌ Erro de App ID: O token gerado não é válido para o APP_ID atual.`);
        await this.clearDerivData(userId, 'CONNECT-OAUTH');
        throw new BadRequestException('Os tokens gerados pelo OAuth não são válidos para o APP_ID configurado no servidor. Verifique se o APP_ID no .env corresponde ao aplicativo onde o redirecionamento OAuth está configurado.');
      }

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
        `[CONNECT-OAUTH] Erro na conexão Deriv: ${errorMsg}`,
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
    const preferredCurrency = await this.getPreferredCurrency(userId, 'STATUS');
    const targetCurrency = (currency ? currency : preferredCurrency).toUpperCase();
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

        // Adicionar tokensByLoginId ao account (MERGE) antes de passar para buildResponse e salvar
        // Isso garante que não perderemos os tokens de outras contas ao atualizar o saldo de uma conta específica
        const mergedTokens = {
          ...tokensByLoginIdForAccount,
          ...(account.tokensByLoginId || {})
        };

        const accountWithTokens = {
          ...account,
          tokensByLoginId: mergedTokens,
        };

        const sessionPayload = {
          ...this.buildResponse(accountWithTokens, preferredCurrency),
          appId: appIdToUse,
        };
        this.logger.log(`[STATUS] SessionPayload após buildResponse: ${JSON.stringify({
          balancesByCurrency: sessionPayload.balancesByCurrency,
          balancesByCurrencyDemo: sessionPayload.balancesByCurrencyDemo,
          balancesByCurrencyReal: sessionPayload.balancesByCurrencyReal
        })}`);
        this.derivService.setSession(userId, sessionPayload);
        this.logger.log(`[STATUS] DEBUG - account sendo salvo como raw (WITH TOKENS): ${JSON.stringify({
          hasBalancesByCurrencyDemo: !!accountWithTokens.balancesByCurrencyDemo,
          hasBalancesByCurrencyReal: !!accountWithTokens.balancesByCurrencyReal,
          tokensCount: Object.keys(accountWithTokens.tokensByLoginId || {}).length,
          tokensKeys: Object.keys(accountWithTokens.tokensByLoginId || {})
        })}`);
        await this.userRepository.updateDerivInfo(userId, {
          loginId: sessionPayload.loginid ?? account.loginid ?? userId,
          currency: sessionPayload.currency ?? account.currency,
          balance: sessionPayload.balance?.value ?? account.balance?.value ?? undefined,
          raw: accountWithTokens,
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
        const errorMsg = error.message || JSON.stringify(error);
        const isAppIdError = errorMsg.includes('app ID') || errorMsg.includes('AppIdInvalid');

        if (isAppIdError) {
          this.logger.error(`[STATUS] ❌ Erro de App ID para usuário ${userId}. Limpando dados.`);
          await this.clearDerivData(userId, 'STATUS');
          throw new BadRequestException('Sua sessão Deriv expirou ou o APP_ID foi alterado. Por favor, reconecte sua conta nas configurações.');
        }

        this.logger.error(`[STATUS] Erro ao buscar saldo da Deriv: ${errorMsg}`);
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
            currency: derivInfo.currency ?? preferredCurrency,
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
        ...this.buildResponse(accountData, preferredCurrency),
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
      preferredCurrency: preferredCurrency,
      currencyPrefix: this.getCurrencyPrefix(preferredCurrency),
      preferredCurrencyPrefix: this.getCurrencyPrefix(preferredCurrency),
      appId: appIdToUse,
    };
  }

  @Post('verify-email')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() body: { email: string }, @Req() req: any) {
    try {
      const userId = req.user.userId;
      this.logger.log(`[VerifyEmail] Verificando email para usuário ${userId}`);

      if (!body.email) {
        throw new BadRequestException('Email é obrigatório');
      }

      const result = await this.derivService.verifyEmailForAccount(body.email);

      return {
        success: true,
        message: result.message,
      };
    } catch (error) {
      this.logger.error(`[VerifyEmail] Erro: ${error.message}`, error.stack);
      throw new BadRequestException(error.message || 'Erro ao verificar email');
    }
  }

  @Post('create-account')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async createAccount(@Body() body: any, @Req() req: any) {
    try {
      const userId = req.user.userId;
      this.logger.log(`[CreateAccount] Criando conta Deriv para usuário ${userId}`);

      if (!body.verificationCode) {
        throw new BadRequestException(
          'Código de verificação é obrigatório. ' +
          'Primeiro verifique o email usando o endpoint /verify-email',
        );
      }

      const result = await this.derivService.createDerivAccount(body, userId, body.verificationCode);

      return {
        success: true,
        message: 'Contas criadas com sucesso',
        data: result,
      };
    } catch (error) {
      this.logger.error(`[CreateAccount] Erro: ${error.message}`, error.stack);
      throw new BadRequestException(error.message || 'Erro ao criar conta na Deriv');
    }
  }

  // ========== ENDPOINTS PARA OPERAÇÕES DE TRADING ==========

  // Cache de tokens temporários para SSE (expira em 5 minutos)
  private sseTokens = new Map<string, { userId: string; expiresAt: number }>();

  @Post('trading/sse-token')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async generateSSEToken(@Req() req: any) {
    const userId = req.user.userId;

    // Gerar token temporário (UUID simples)
    const token = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos

    this.sseTokens.set(token, { userId, expiresAt });

    // Limpar tokens expirados periodicamente
    this.cleanExpiredSSETokens();

    this.logger.log(`[Trading] Token SSE gerado para usuário ${userId}`);
    return { token, expiresIn: 300 }; // 5 minutos em segundos
  }

  private cleanExpiredSSETokens() {
    const now = Date.now();
    for (const [token, data] of this.sseTokens.entries()) {
      if (data.expiresAt < now) {
        this.sseTokens.delete(token);
      }
    }
  }

  private validateSSEToken(token: string): string | null {
    const data = this.sseTokens.get(token);
    if (!data) return null;

    if (data.expiresAt < Date.now()) {
      this.sseTokens.delete(token);
      return null;
    }

    return data.userId;
  }

  @Post('trading/connect')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async connectTrading(@Body() body: { token: string; loginid?: string }, @Req() req: any) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Conectando usuário ${userId} ao Deriv WebSocket`);

    try {
      const service = this.wsManager.getOrCreateService(userId);
      await service.connect(body.token, body.loginid);
      return { success: true, message: 'Conectado com sucesso' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao conectar: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao conectar com Deriv');
    }
  }

  @Get('trading/token')
  async getResolvedToken(@Req() req) {
    const userId = req.user.id;
    // ensure resolveTokenForUser is called correctly
    const token = await this.resolveTokenForUser(userId);
    return { token };
  }

  private async resolveTokenForUser(userId: string): Promise<string | null> {
    try {
      const settings = await this.settingsService.getSettings(userId);
      const tradeCurrency = (settings.tradeCurrency || 'USD').toUpperCase();
      const user = await this.userRepository.findById(userId);

      if (!user) return null;

      const wantDemo = tradeCurrency === 'DEMO';
      let token = wantDemo ? user.tokenDemo : user.tokenReal;

      if (!token) {
        // Fallback to raw parsing if columns are empty
        const derivRaw = user.derivRaw;
        if (derivRaw) {
          const raw = typeof derivRaw === 'string' ? JSON.parse(derivRaw) : derivRaw;
          const tokens = raw.tokensByLoginId || {};

          // Ambiguity check for USD preference but raw indicates different account type desire
          // (Simplified logic: just look for VRTC if wantDemo)
          if (wantDemo) {
            const entry = Object.entries(tokens).find(([lid]) => (lid as string).startsWith('VRTC'));
            if (entry) token = entry[1] as string;
          } else {
            const entry = Object.entries(tokens).find(([lid]) => !(lid as string).startsWith('VRTC'));
            if (entry) token = entry[1] as string;
          }
        }
      }

      // Final fallback: Check for ambiguity if user wants USD but we only have VRTC token or vice versa?
      // For now, trust the token we found.

      return token || null;
    } catch (error) {
      this.logger.error(`Error resolving token for user ${userId}: ${error.message}`);
      return null;
    }
  }

  @Get('trading/stream')
  async streamTrading(
    @Query('token') sseToken: string,
    @Query('derivToken') derivToken: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    // Validar token SSE temporário
    let userId: string | null = null;

    if (sseToken) {
      userId = this.validateSSEToken(sseToken);
      if (!userId) {
        res.status(401).json({ error: 'Token SSE inválido ou expirado' });
        return;
      }
    } else {
      // Fallback: usar JWT se não tiver token SSE (menos seguro, mas funcional)
      // Isso requer AuthGuard, mas EventSource não suporta headers
      // Por isso, preferimos usar token temporário
      res.status(400).json({ error: 'Token SSE necessário. Use /trading/sse-token para obter um token.' });
      return;
    }
    this.logger.log(`[Trading] Iniciando stream SSE para usuário ${userId}`);

    // Configurar headers para Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const service = this.wsManager.getOrCreateService(userId);

    // Se não estiver conectado, conectar primeiro
    if (!service['isAuthorized']) {
      // 1. Resolver token internamente usando a preferência do usuário (Demo/Real)
      const finalDerivToken = await this.resolveTokenForUser(userId);

      if (!finalDerivToken) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Token Deriv não encontrado. Verifique se você tem uma conta conectada.' })}\n\n`);
        res.end();
        return;
      }

      // Buscar loginid apenas para referência/log (opcional, mas bom ter)
      let loginid: string | undefined;
      const derivInfo = await this.userRepository.getDerivInfo(userId);
      if (derivInfo?.raw?.tokensByLoginId) {
        for (const [lid, tkn] of Object.entries(derivInfo.raw.tokensByLoginId)) {
          if (tkn === finalDerivToken) {
            loginid = lid;
            break;
          }
        }
      }

      try {
        await service.connect(finalDerivToken, loginid || undefined);
      } catch (error) {
        this.logger.error(`[Trading] Erro ao conectar serviço: ${error.message}`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
        return;
      }
    }

    // Configurar listeners para eventos
    const onTick = (data: any) => {
      // Validar dados antes de enviar
      if (data && typeof data.value === 'number' && isFinite(data.value) && data.value > 0 &&
        typeof data.epoch === 'number' && isFinite(data.epoch) && data.epoch > 0) {
        res.write(`data: ${JSON.stringify({ type: 'tick', data })}\n\n`);
      } else {
        this.logger.warn(`[Trading] Tick inválido ignorado: ${JSON.stringify(data)}`);
      }
    };

    const onHistory = (data: any) => {
      // Validar e filtrar ticks inválidos antes de enviar
      if (data && data.ticks && Array.isArray(data.ticks)) {
        const validTicks = data.ticks.filter((t: any) =>
          t &&
          typeof t.value === 'number' &&
          isFinite(t.value) &&
          t.value > 0 &&
          !isNaN(t.value) &&
          typeof t.epoch === 'number' &&
          isFinite(t.epoch) &&
          t.epoch > 0 &&
          !isNaN(t.epoch)
        );

        if (validTicks.length > 0) {
          res.write(`data: ${JSON.stringify({ type: 'history', data: { ...data, ticks: validTicks } })}\n\n`);
        } else {
          this.logger.warn(`[Trading] History sem ticks válidos: ${data.ticks.length} ticks, 0 válidos`);
        }
      } else {
        this.logger.warn(`[Trading] History inválido ignorado: ${JSON.stringify(data)}`);
      }
    };

    const onProposal = (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'proposal', data })}\n\n`);
    };

    const onBuy = async (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'buy', data })}\n\n`);

      // Salvar operação no banco
      try {
        // Garantir que entrySpot sempre tenha um valor
        let entrySpot = data.entrySpot || data.entry_spot || null;

        // Se não encontrou entrySpot, tentar obter do último tick do serviço WebSocket
        if (entrySpot === null || entrySpot === undefined) {
          try {
            const service = this.wsManager.getService(userId);
            if (service) {
              const ticks = (service as any).getTicks ? (service as any).getTicks() : ((service as any).ticks || []);
              if (ticks && ticks.length > 0) {
                const lastTick = ticks[ticks.length - 1];
                if (lastTick && lastTick.value) {
                  entrySpot = Number(lastTick.value);
                  this.logger.log(`[Trading] EntrySpot não encontrado na resposta, usando último tick: ${entrySpot}`);
                }
              }
            }
          } catch (error) {
            this.logger.warn(`[Trading] Erro ao obter último tick para entrySpot: ${error.message}`);
          }
        }

        // Garantir que entrySpot seja um número válido
        const finalEntrySpot = entrySpot !== null && entrySpot !== undefined ? Number(entrySpot) : null;

        this.logger.log(`[Trading] Salvando compra - entrySpot: ${finalEntrySpot}, entry_spot: ${data.entry_spot}, buyPrice: ${data.buyPrice}`);

        const trade = this.tradeRepository.create({
          id: uuidv4(),
          userId,
          contractType: data.contractType || 'CALL',
          timeType: data.durationUnit === 't' ? 'tick' : 'time',
          duration: String(data.duration || 1),
          multiplier: 1.00,
          entryValue: data.buyPrice || 0, // Valor investido (stake)
          entrySpot: finalEntrySpot, // Preço de entrada (spot price) - sempre salvar se disponível
          tradeType: 'BUY' as any,
          status: TradeStatus.PENDING,
          derivTransactionId: data.contractId ? String(data.contractId) : null,
          symbol: data.symbol ? String(data.symbol) : null,
        });
        const savedTrade = await this.tradeRepository.save(trade);
        this.logger.log(`[Trading] Operação de compra salva no banco: ${savedTrade.id}, entrySpot: ${savedTrade.entrySpot}, entryValue: ${savedTrade.entryValue}`);

        // Verificar se o usuário é expert e replicar operação para copiadores
        try {
          const isMasterTrader = await this.copyTradingService.isMasterTrader(userId);
          if (isMasterTrader) {
            this.logger.log(`[Trading] Usuário ${userId} é expert, replicando operação para copiadores...`);

            // Buscar saldo do usuário para calcular porcentagem
            const user = await this.userRepository.findById(userId);
            const userBalance = user?.derivBalance ? parseFloat(user.derivBalance) : 0;
            const percent = userBalance > 0 ? ((data.buyPrice || 0) / userBalance) * 100 : 0;

            await this.copyTradingService.replicateManualOperation(
              userId,
              {
                contractId: data.contractId,
                contractType: data.contractType || 'CALL',
                symbol: data.symbol,
                duration: data.duration || 1,
                durationUnit: data.durationUnit || 'm',
                stakeAmount: data.buyPrice || 0,
                percent: percent,
                entrySpot: finalEntrySpot || 0,
                entryTime: data.entryTime || Math.floor(Date.now() / 1000),
                barrier: data.barrier || 0.1,
              },
            );
          }
        } catch (error) {
          this.logger.error(`[Trading] Erro ao replicar operação para copiadores: ${error.message}`);
        }
      } catch (error) {
        this.logger.error(`[Trading] Erro ao salvar operação de compra: ${error.message}`);
      }
    };

    const onSell = async (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'sell', data })}\n\n`);

      // Atualizar operação no banco com o resultado
      try {
        // Garantir que exitSpot sempre tenha um valor
        let exitSpot = data.exitSpot || data.exit_spot || null;

        // Se não encontrou exitSpot, tentar obter do último tick do serviço WebSocket
        if (exitSpot === null || exitSpot === undefined) {
          try {
            const service = this.wsManager.getService(userId);
            if (service) {
              const ticks = (service as any).getTicks ? (service as any).getTicks() : ((service as any).ticks || []);
              if (ticks && ticks.length > 0) {
                const lastTick = ticks[ticks.length - 1];
                if (lastTick && lastTick.value) {
                  exitSpot = Number(lastTick.value);
                  this.logger.log(`[Trading] ExitSpot não encontrado na resposta, usando último tick: ${exitSpot}`);
                }
              }
            }
          } catch (error) {
            this.logger.warn(`[Trading] Erro ao obter último tick para exitSpot: ${error.message}`);
          }
        }

        // Garantir que exitSpot seja um número válido
        const finalExitSpot = exitSpot !== null && exitSpot !== undefined ? Number(exitSpot) : null;

        this.logger.log(`[Trading] Atualizando venda - exitSpot: ${finalExitSpot}, exit_spot: ${data.exit_spot}, sellPrice: ${data.sellPrice}, profit: ${data.profit}`);

        const trade = await this.tradeRepository.findOne({
          where: { derivTransactionId: data.contractId, userId },
          order: { createdAt: 'DESC' },
        });

        if (trade) {
          trade.profit = data.profit !== null && data.profit !== undefined ? Number(data.profit) : null;
          trade.exitValue = data.sellPrice !== null && data.sellPrice !== undefined ? Number(data.sellPrice) : null; // Valor recebido na venda
          trade.exitSpot = finalExitSpot; // Preço de saída (spot price) - sempre salvar se disponível
          trade.status = (trade.profit !== null && trade.profit > 0) ? TradeStatus.WON : (trade.profit !== null ? TradeStatus.LOST : TradeStatus.PENDING);
          const savedTrade = await this.tradeRepository.save(trade);
          this.logger.log(`[Trading] Operação de venda atualizada no banco: ${savedTrade.id}, exitSpot: ${savedTrade.exitSpot}, exitValue: ${savedTrade.exitValue}, profit: ${savedTrade.profit}`);

          // Se a operação foi finalizada e o usuário é expert, atualizar operações de copy trading
          if ((savedTrade.status === TradeStatus.WON || savedTrade.status === TradeStatus.LOST) &&
            savedTrade.profit !== null && savedTrade.profit !== undefined &&
            savedTrade.entryValue !== null && savedTrade.entryValue !== undefined) {
            try {
              const isMasterTrader = await this.copyTradingService.isMasterTrader(userId);
              if (isMasterTrader) {
                const result = savedTrade.status === TradeStatus.WON ? 'win' : 'loss';
                const profit = Number(savedTrade.profit);
                const entryValue = Number(savedTrade.entryValue);
                this.logger.log(`[Trading] Atualizando operações de copy trading para contractId ${data.contractId}, result: ${result}, profit: ${profit}`);
                await this.copyTradingService.updateCopyTradingOperationsResult(
                  userId,
                  data.contractId,
                  result,
                  profit,
                  entryValue,
                );
              }
            } catch (error) {
              this.logger.error(`[Trading] Erro ao atualizar operações de copy trading: ${error.message}`);
            }
          }
        } else {
          this.logger.warn(`[Trading] Operação não encontrada para contractId: ${data.contractId}`);
        }
      } catch (error) {
        this.logger.error(`[Trading] Erro ao atualizar operação de venda: ${error.message}`);
      }
    };

    const onError = (error: any) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
    };

    const onContractsFor = (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'contracts_for', data })}\n\n`);
    };

    const onTradingDurations = (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'trading_durations', data })}\n\n`);
    };

    const onActiveSymbols = (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'active_symbols', data })}\n\n`);
    };

    const onContractUpdate = async (data: any) => {
      res.write(`data: ${JSON.stringify({ type: 'contract', data })}\n\n`);

      // Log detalhado para debug
      this.logger.log(`[Trading] [ContractUpdate] Recebido: contract_id=${data?.contract_id}, status=${data?.status}, is_expired=${data?.is_expired}, is_sold=${data?.is_sold}, exit_spot=${data?.exit_spot}, current_spot=${data?.current_spot}, profit=${data?.profit}`);

      // Atualizar operação no banco sempre que houver atualização do contrato
      if (data && data.contract_id) {
        try {
          // Converter contract_id para string para garantir compatibilidade
          const contractId = String(data.contract_id);
          this.logger.log(`[Trading] [ContractUpdate] Buscando trade com contract_id: ${contractId}, userId: ${userId}`);

          // Buscar trade pelo contract_id
          let trade = await this.tradeRepository.findOne({
            where: { derivTransactionId: contractId, userId },
            order: { createdAt: 'DESC' },
          });

          // Se não encontrou, tentar buscar apenas pelo contract_id (pode ser de outro usuário ou sem userId)
          if (!trade) {
            this.logger.warn(`[Trading] [ContractUpdate] Trade não encontrado com userId, tentando buscar apenas por contract_id: ${contractId}`);
            trade = await this.tradeRepository.findOne({
              where: { derivTransactionId: contractId },
              order: { createdAt: 'DESC' },
            });
          }

          if (!trade) {
            this.logger.error(`[Trading] [ContractUpdate] Trade não encontrado no banco para contract_id: ${contractId}, userId: ${userId}`);
            return;
          }

          if (trade) {
            this.logger.log(`[Trading] [ContractUpdate] Trade encontrado: ${trade.id}, status atual: ${trade.status}, symbol atual: ${trade.symbol}`);
            let shouldSave = false;

            // Atualizar symbol se disponível e ainda não tiver sido salvo
            if ((!trade.symbol || trade.symbol === null) && data.symbol !== null && data.symbol !== undefined) {
              trade.symbol = String(data.symbol);
              shouldSave = true;
              this.logger.log(`[Trading] Symbol atualizado do contrato: ${trade.symbol}`);
            }

            // Atualizar entry_spot se disponível e ainda não tiver sido salvo
            if ((trade.entrySpot === null || trade.entrySpot === undefined) && data.entry_spot !== null && data.entry_spot !== undefined) {
              trade.entrySpot = Number(data.entry_spot);
              shouldSave = true;
              this.logger.log(`[Trading] EntrySpot atualizado do contrato: ${trade.entrySpot}`);
            }

            // Verificar se o contrato foi finalizado (vendido ou expirado)
            const isFinalized = data.is_sold || data.status === 'sold' || data.is_expired || data.status === 'expired' || data.status === 'won' || data.status === 'lost';

            // Se o contrato foi vendido ou expirou, atualizar com os dados finais
            if (isFinalized) {
              this.logger.log(`[Trading] [ContractUpdate] Contrato finalizado detectado: is_sold=${data.is_sold}, status=${data.status}, is_expired=${data.is_expired}`);
              // Atualizar preço de saída se disponível
              // A API Deriv pode retornar exit_spot, current_spot, exit_tick, ou exit_tick_time
              let exitSpot = data.exit_spot !== null && data.exit_spot !== undefined ? Number(data.exit_spot) : null;

              // Se não encontrou exit_spot, tentar current_spot (último preço conhecido)
              if ((exitSpot === null || exitSpot === undefined) && data.current_spot !== null && data.current_spot !== undefined) {
                exitSpot = Number(data.current_spot);
                this.logger.log(`[Trading] ExitSpot não encontrado, usando current_spot: ${exitSpot}`);
              }

              // Se ainda não encontrou, tentar obter do último tick do serviço WebSocket
              if (exitSpot === null || exitSpot === undefined) {
                try {
                  const service = this.wsManager.getService(userId);
                  if (service) {
                    const ticks = (service as any).getTicks ? (service as any).getTicks() : ((service as any).ticks || []);
                    if (ticks && ticks.length > 0) {
                      const lastTick = ticks[ticks.length - 1];
                      if (lastTick && lastTick.value) {
                        exitSpot = Number(lastTick.value);
                        this.logger.log(`[Trading] ExitSpot não encontrado na resposta, usando último tick: ${exitSpot}`);
                      }
                    }
                  }
                } catch (error) {
                  this.logger.warn(`[Trading] Erro ao obter último tick para exitSpot: ${error.message}`);
                }
              }

              // Garantir que exitSpot seja salvo se disponível (mesmo que seja igual ao entrySpot)
              if (exitSpot !== null && exitSpot !== undefined && !isNaN(exitSpot) && isFinite(exitSpot)) {
                trade.exitSpot = exitSpot;
                shouldSave = true;
                this.logger.log(`[Trading] ExitSpot definido: ${exitSpot}`);
              }

              // Garantir que entrySpot seja salvo se ainda não tiver
              if ((trade.entrySpot === null || trade.entrySpot === undefined) && data.entry_spot !== null && data.entry_spot !== undefined) {
                trade.entrySpot = Number(data.entry_spot);
                shouldSave = true;
                this.logger.log(`[Trading] EntrySpot atualizado do contrato: ${trade.entrySpot}`);
              } else if ((trade.entrySpot === null || trade.entrySpot === undefined)) {
                // Tentar obter do último tick se ainda não tiver entrySpot
                try {
                  const service = this.wsManager.getService(userId);
                  if (service) {
                    const ticks = (service as any).getTicks ? (service as any).getTicks() : ((service as any).ticks || []);
                    if (ticks && ticks.length > 0) {
                      const lastTick = ticks[ticks.length - 1];
                      if (lastTick && lastTick.value) {
                        trade.entrySpot = Number(lastTick.value);
                        shouldSave = true;
                        this.logger.log(`[Trading] EntrySpot não encontrado, usando último tick: ${trade.entrySpot}`);
                      }
                    }
                  }
                } catch (error) {
                  this.logger.warn(`[Trading] Erro ao obter último tick para entrySpot: ${error.message}`);
                }
              }

              // Atualizar valor de saída se disponível
              // Prioridade: sell_price > payout > (entry_value + profit) > bid_price
              if (data.sell_price !== null && data.sell_price !== undefined) {
                trade.exitValue = Number(data.sell_price) || null;
                shouldSave = true;
                this.logger.log(`[Trading] ExitValue atualizado de sell_price: ${trade.exitValue}`);
              } else if (data.payout !== null && data.payout !== undefined && data.is_expired) {
                // Se expirou e ganhou, usar payout como exit_value
                trade.exitValue = Number(data.payout) || null;
                shouldSave = true;
                this.logger.log(`[Trading] ExitValue atualizado de payout: ${trade.exitValue}`);
              } else if (data.is_expired && data.profit !== null && data.profit !== undefined && trade.entryValue !== null && trade.entryValue !== undefined) {
                // Se expirou, calcular exit_value = entry_value + profit
                const calculatedExitValue = Number(trade.entryValue) + Number(data.profit);
                trade.exitValue = calculatedExitValue;
                shouldSave = true;
                this.logger.log(`[Trading] ExitValue calculado (expirou): entryValue=${trade.entryValue} + profit=${data.profit} = ${calculatedExitValue}`);
              } else if (data.bid_price !== null && data.bid_price !== undefined && data.is_expired) {
                // Fallback: usar bid_price se disponível
                trade.exitValue = Number(data.bid_price) || null;
                shouldSave = true;
                this.logger.log(`[Trading] ExitValue atualizado de bid_price: ${trade.exitValue}`);
              }

              // Atualizar lucro/prejuízo
              if (data.profit !== null && data.profit !== undefined) {
                trade.profit = Number(data.profit) || null;
                shouldSave = true;
                this.logger.log(`[Trading] Profit atualizado: ${trade.profit}`);
              }

              // Atualizar status
              let statusUpdated = false;
              if (data.status) {
                if (data.status === 'won' || data.status === 'win') {
                  trade.status = TradeStatus.WON;
                  statusUpdated = true;
                  this.logger.log(`[Trading] Status atualizado para WON (status=${data.status})`);
                } else if (data.status === 'lost' || data.status === 'loss') {
                  trade.status = TradeStatus.LOST;
                  statusUpdated = true;
                  this.logger.log(`[Trading] Status atualizado para LOST (status=${data.status})`);
                } else if (data.status === 'sold') {
                  trade.status = TradeStatus.WON; // Assumir que venda manual é lucro
                  statusUpdated = true;
                  this.logger.log(`[Trading] Status atualizado para WON (vendido manualmente)`);
                } else if (data.status === 'expired' || data.is_expired) {
                  // Quando expira, determinar se ganhou ou perdeu baseado no profit
                  if (data.profit !== null && data.profit !== undefined) {
                    trade.status = data.profit > 0 ? TradeStatus.WON : TradeStatus.LOST;
                    statusUpdated = true;
                    this.logger.log(`[Trading] Status atualizado para ${trade.status} (expirou, profit=${data.profit})`);
                  } else {
                    trade.status = TradeStatus.LOST; // Por padrão, assumir perda se expirou sem profit definido
                    statusUpdated = true;
                    this.logger.log(`[Trading] Status atualizado para LOST (expirou sem profit)`);
                  }
                }
              } else if (data.is_expired) {
                // Se is_expired mas sem status, determinar baseado no profit
                if (data.profit !== null && data.profit !== undefined) {
                  trade.status = data.profit > 0 ? TradeStatus.WON : TradeStatus.LOST;
                  statusUpdated = true;
                  this.logger.log(`[Trading] Status atualizado para ${trade.status} (is_expired=true, profit=${data.profit})`);
                } else {
                  trade.status = TradeStatus.LOST;
                  statusUpdated = true;
                  this.logger.log(`[Trading] Status atualizado para LOST (is_expired=true sem profit)`);
                }
              }

              if (statusUpdated || shouldSave) {
                shouldSave = true;
              }
            }

            // Salvar apenas se houver mudanças
            if (shouldSave) {
              await this.tradeRepository.save(trade);
              this.logger.log(`[Trading] Contrato atualizado no banco: ${trade.id}, status: ${trade.status}, entrySpot: ${trade.entrySpot}, exitSpot: ${trade.exitSpot}, profit: ${trade.profit}`);

              // Se o contrato foi finalizado e o usuário é expert, atualizar operações de copy trading
              if (isFinalized && (trade.status === TradeStatus.WON || trade.status === TradeStatus.LOST)) {
                try {
                  const isMasterTrader = await this.copyTradingService.isMasterTrader(userId);
                  if (isMasterTrader &&
                    trade.profit !== null && trade.profit !== undefined &&
                    trade.entryValue !== null && trade.entryValue !== undefined) {
                    const result = trade.status === TradeStatus.WON ? 'win' : 'loss';
                    const profit = Number(trade.profit);
                    const entryValue = Number(trade.entryValue);
                    this.logger.log(`[Trading] Atualizando operações de copy trading para contractId ${contractId}, result: ${result}, profit: ${profit}`);
                    await this.copyTradingService.updateCopyTradingOperationsResult(
                      userId,
                      contractId,
                      result,
                      profit,
                      entryValue,
                    );
                  }
                } catch (error) {
                  this.logger.error(`[Trading] Erro ao atualizar operações de copy trading: ${error.message}`);
                }
              }
            }
          }
        } catch (error) {
          this.logger.error(`[Trading] Erro ao atualizar contrato: ${error.message}`);
        }
      }
    };

    service.on('tick', onTick);
    service.on('history', onHistory);
    service.on('proposal', onProposal);
    service.on('buy', onBuy);
    service.on('sell', onSell);
    service.on('error', onError);
    service.on('contracts_for', onContractsFor);
    service.on('trading_durations', onTradingDurations);
    service.on('active_symbols', onActiveSymbols);
    service.on('contract_update', onContractUpdate);

    // Limpar listeners quando a conexão for fechada
    req.on('close', () => {
      this.logger.log(`[Trading] Cliente desconectado do stream para usuário ${userId}`);
      service.removeAllListeners('tick');
      service.removeAllListeners('history');
      service.removeAllListeners('proposal');
      service.removeAllListeners('buy');
      service.removeAllListeners('sell');
      service.removeAllListeners('error');
      service.removeAllListeners('contracts_for');
      service.removeAllListeners('trading_durations');
      service.removeAllListeners('active_symbols');
      service.removeAllListeners('contract_update');
    });

    // Enviar dados iniciais se disponíveis
    const ticks = service.getTicks();
    if (ticks.length > 0) {
      // Filtrar ticks inválidos antes de enviar
      const validTicks = ticks.filter((t: any) =>
        t &&
        typeof t.value === 'number' &&
        isFinite(t.value) &&
        t.value > 0 &&
        !isNaN(t.value) &&
        typeof t.epoch === 'number' &&
        isFinite(t.epoch) &&
        t.epoch > 0 &&
        !isNaN(t.epoch)
      );

      if (validTicks.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'history', data: { ticks: validTicks } })}\n\n`);
      }
    }
  }

  @Post('trading/subscribe-symbol')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async subscribeSymbol(@Body() body: { symbol: string; token?: string; loginid?: string }, @Req() req: any) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} inscrevendo-se no símbolo ${body.symbol}`);

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Se não estiver conectado, conectar primeiro
      if (!service['isAuthorized']) {
        const token = await this.resolveTokenForUser(userId);
        if (!token) {
          throw new BadRequestException('Token não encontrado no backend. Verifique suas configurações.');
        }
        await service.connect(token);
      }

      service.subscribeToSymbol(body.symbol);
      return { success: true, message: 'Inscrição iniciada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao inscrever-se no símbolo: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao inscrever-se no símbolo');
    }
  }

  @Get('trading/active-symbols')
  @UseGuards(AuthGuard('jwt'))
  async getActiveSymbols(@Req() req: any) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} solicitando símbolos ativos`);

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Se não estiver conectado, conectar primeiro
      if (!service['isAuthorized']) {
        const token = await this.resolveTokenForUser(userId);
        if (token) {
          await service.connect(token);
        }
      }

      service.getActiveSymbols();
      return { success: true, message: 'Solicitação de símbolos enviada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao solicitar símbolos: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao solicitar símbolos');
    }
  }

  @Get('trading/ticks')
  @UseGuards(AuthGuard('jwt'))
  async getTicks(@Query('symbol') symbol: string, @Req() req: any): Promise<{ ticks: Array<{ value: number; epoch: number }>; symbol: string; count: number }> {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} solicitando ticks para ${symbol}`);

    const service = this.wsManager.getService(userId);
    if (!service) {
      return { ticks: [], symbol: symbol || 'R_100', count: 0 };
    }

    const ticks = service.getTicks();
    return { ticks, symbol: symbol || 'R_100', count: ticks.length };
  }

  private async getTokenFromStorage(userId: string, targetLoginid?: string): Promise<string | null> {
    try {
      // Buscar informações da Deriv do banco de dados
      const derivInfo = await this.userRepository.getDerivInfo(userId);

      if (!derivInfo?.raw) {
        this.logger.warn(`[getTokenFromStorage] derivInfo.raw não encontrado para userId: ${userId}`);
        return null;
      }

      // Se targetLoginid foi fornecido, buscar token específico desse loginid
      if (targetLoginid && derivInfo.raw.tokensByLoginId?.[targetLoginid]) {
        this.logger.log(`[getTokenFromStorage] Token encontrado para loginid ${targetLoginid}`);
        return derivInfo.raw.tokensByLoginId[targetLoginid];
      }

      // Se não tiver targetLoginid, tentar usar o loginid padrão
      if (derivInfo.loginId && derivInfo.raw.tokensByLoginId?.[derivInfo.loginId]) {
        this.logger.log(`[getTokenFromStorage] Token encontrado para loginid padrão: ${derivInfo.loginId}`);
        return derivInfo.raw.tokensByLoginId[derivInfo.loginId];
      }

      // Tentar qualquer token disponível
      const tokensByLoginId = derivInfo.raw.tokensByLoginId || {};
      const loginIds = Object.keys(tokensByLoginId);
      if (loginIds.length > 0) {
        const firstToken = tokensByLoginId[loginIds[0]];
        this.logger.log(`[getTokenFromStorage] Usando primeiro token disponível do loginid: ${loginIds[0]}`);
        return firstToken;
      }

      this.logger.warn(`[getTokenFromStorage] Nenhum token encontrado para userId: ${userId}`);
      return null;
    } catch (error) {
      this.logger.error(`[getTokenFromStorage] Erro ao buscar token: ${error.message}`);
      return null;
    }
  }

  @Post('trading/subscribe-proposal')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async subscribeProposal(
    @Body() body: {
      symbol: string;
      contractType: string;
      duration: number;
      durationUnit: string;
      amount: number;
      barrier?: number; // Para contratos DIGIT* (dígito previsto)
      multiplier?: number; // Para contratos MULTUP/MULTDOWN
      token?: string;
    },
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} inscrevendo-se em proposta`);

    // Validar contractType
    if (!body.contractType || body.contractType === 'undefined') {
      throw new BadRequestException('contractType é obrigatório');
    }

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Remover listeners antigos de proposta para evitar vazamento de memória
      service.removeAllListeners('proposal');

      // Se não estiver conectado, conectar primeiro
      if (!service['isAuthorized']) {
        const token = await this.resolveTokenForUser(userId);
        if (!token) {
          throw new BadRequestException('Token não encontrado no backend.');
        }
        await service.connect(token);
      }

      // Preparar configuração da proposta
      const proposalConfig: any = {
        symbol: body.symbol,
        contractType: body.contractType,
        duration: body.duration,
        durationUnit: body.durationUnit,
        amount: body.amount,
      };

      // Adicionar barrier para contratos de dígitos
      const digitContracts = ['DIGITMATCH', 'DIGITDIFF', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'];
      if (digitContracts.includes(body.contractType)) {
        if (body.barrier !== undefined && body.barrier !== null) {
          proposalConfig.barrier = body.barrier;
        } else {
          // Por padrão, usar 3 para DIGITOVER, mas 5 para outros se necessário (ajuste conforme lógica)
          // Solicitação específica do usuário: usar 3 como padrão
          proposalConfig.barrier = 0.1;
        }
      }

      // Adicionar multiplier para contratos MULTUP/MULTDOWN
      if (body.contractType === 'MULTUP' || body.contractType === 'MULTDOWN') {
        if (body.multiplier !== undefined && body.multiplier !== null) {
          proposalConfig.multiplier = body.multiplier;
        } else {
          // Por padrão, usar 10 se não especificado
          proposalConfig.multiplier = 10;
        }
      }

      service.subscribeToProposal(proposalConfig);

      return { success: true, message: 'Inscrição em proposta iniciada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao inscrever-se em proposta: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao inscrever-se em proposta');
    }
  }

  @Post('trading/buy')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async buyContract(
    @Body() body: BuyContractDto,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} comprando contrato:`, body);

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Buscar informações da conta para determinar qual loginid usar
      const derivInfo = await this.userRepository.getDerivInfo(userId);
      const preferredCurrency = await this.getPreferredCurrency(userId, 'BUY');

      this.logger.log(`[Trading] PreferredCurrency: ${preferredCurrency}`);

      // Log detalhado das contas disponíveis
      if (derivInfo?.raw?.accountsByCurrency) {
        this.logger.log(`[Trading] 📋 Contas Disponíveis:`);
        const allAccounts = Object.values(derivInfo.raw.accountsByCurrency).flat();
        allAccounts.forEach((acc: any) => {
          const token = derivInfo.raw.tokensByLoginId?.[acc.loginid] ? 'SIM' : 'NÃO';
          this.logger.log(`[Trading]   - LoginID: ${acc.loginid}, Currency: ${acc.currency}, Balance: ${acc.value}, Type: ${acc.isDemo ? 'DEMO' : 'REAL'}, Token: ${token}`);
        });
      } else {
        this.logger.warn(`[Trading] ⚠️ Sem informações detalhadas de contas (accountsByCurrency)`);
      }

      this.logger.log(`[Trading] derivInfo.raw existe: ${!!derivInfo?.raw}`);

      // 1. Resolver token internamente (Backend resolution)
      const token = await this.resolveTokenForUser(userId);

      if (!token) {
        this.logger.error(`[Trading] Token não encontrado para userId: ${userId}`);
        throw new BadRequestException('Token não encontrado no backend. Verifique suas configurações de conta.');
      }

      // Buscar loginid associado ao token para fins de log/conexão
      let targetLoginid: string | undefined;
      // derivInfo já carregado no início da função
      if (derivInfo?.raw?.tokensByLoginId) {
        for (const [lid, tkn] of Object.entries(derivInfo.raw.tokensByLoginId)) {
          if (tkn === token) {
            targetLoginid = lid;
            break;
          }
        }
      }

      const currentLoginid = service['currentLoginid'];
      // Se não estiver conectado OU se estiver conectado com loginid diferente, reconectar
      // IMPORTANTE: Agora usamos o TOKEN para verificar se é o mesmo, além do loginid
      // Mas o loginid é o principal.
      const needsReconnect = !service['isAuthorized'] || (targetLoginid && currentLoginid !== targetLoginid);

      if (needsReconnect) {
        this.logger.log(`[Trading] Reconectando: isAuthorized=${service['isAuthorized']}, currentLoginid=${currentLoginid}, targetLoginid=${targetLoginid}`);
        this.logger.log(`[Trading] Token resolvido: ${token ? 'SIM' : 'NÃO'} (Prefix: ${token ? token.substring(0, 4) : 'N/A'})`);

        await service.connect(token, targetLoginid);
        this.logger.log(`[Trading] ✅ Conectado com loginid: ${targetLoginid}`);
        this.logger.log(`[Trading] ✅ Conectado com loginid: ${targetLoginid}`);
      } else {
        this.logger.log(`[Trading] ✅ Já conectado com loginid correto: ${currentLoginid}`);
      }

      // Validar contractType
      if (!body.contractType) {
        throw new BadRequestException('contractType é obrigatório');
      }

      this.logger.log(`[Trading] Compra solicitada com contractType: ${body.contractType}`);

      // IMPORTANTE: Na API Deriv, quando você compra usando um proposalId, o contract_type já está definido na proposta.
      // Se o contractType enviado não corresponder ao da proposta, a compra será do tipo errado.
      // Por segurança, SEMPRE buscar uma nova proposta com o contractType correto, mesmo se houver proposalId.
      // Isso garante que o tipo correto seja sempre usado.
      this.logger.log(`[Trading] Buscando proposta com contractType: ${body.contractType} (proposalId fornecido: ${body.proposalId || 'nenhum'})`);

      // Buscar proposta com os parâmetros fornecidos (sempre buscar nova para garantir tipo correto)
      const proposalConfig: any = {
        symbol: body.symbol,
        contractType: body.contractType,
        duration: body.duration,
        durationUnit: body.durationUnit,
        amount: body.amount,
      };

      // Adicionar barrier para contratos de dígitos
      const digitContracts = ['DIGITMATCH', 'DIGITDIFF', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'];
      if (digitContracts.includes(body.contractType)) {
        proposalConfig.barrier = body.barrier !== undefined && body.barrier !== null ? body.barrier : 0.1;
      }

      // Adicionar multiplier para contratos MULTUP/MULTDOWN
      if (body.contractType === 'MULTUP' || body.contractType === 'MULTDOWN') {
        proposalConfig.multiplier = body.multiplier !== undefined && body.multiplier !== null ? body.multiplier : 10;
      }

      const proposal = await this.getProposalInternal(service, proposalConfig);

      if (!proposal || !proposal.id) {
        throw new BadRequestException('Não foi possível obter proposta para compra.');
      }

      const proposalId = proposal.id;
      this.logger.log(`[Trading] ✅ Proposta obtida: ${proposalId} para contractType: ${body.contractType}`);

      // Validar que proposalId é uma string válida
      if (!proposalId || typeof proposalId !== 'string') {
        throw new BadRequestException('Proposta inválida para compra.');
      }

      // IMPORTANTE: A Deriv usa o contract_type da proposta quando compra por proposalId
      // Se o contractType enviado não corresponder ao da proposta, buscar nova proposta
      // Por segurança, sempre buscar nova proposta se o contractType for diferente
      // (Isso garante que o tipo correto seja usado)
      this.logger.log(`[Trading] Usando proposalId: ${proposalId} com contractType: ${body.contractType}`);

      // Executar compra, passando durationUnit e duration para preservar valores originais
      // Também passar contractType para validação no processamento
      // ✅ ATUALIZAÇÃO REFACTOR: Passar objeto com token explícito para garantir uso da conexão correta
      service.buyContract({
        proposalId,
        price: body.amount,
        durationUnit: body.durationUnit,
        duration: body.duration,
        contractType: body.contractType,
        token: token, // Token resolvido
        barrier: body.barrier, // Adicionado barrier
        loginid: targetLoginid      // Login ID alvo
      });

      return {
        success: true,
        message: 'Compra executada',
        proposalId,
        amount: body.amount,
      };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao comprar contrato: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao comprar contrato');
    }
  }

  private async getProposalInternal(service: any, config: ProposalDto): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        service.removeListener('proposal', handler); // Clean up on timeout
        reject(new Error('Timeout ao buscar proposta'));
      }, 10000);

      const handler = (proposalData: any) => {
        // Validate if this proposal matches our request context if possible, 
        // but for now just take the first one since we are serialized by user action usually.
        // TODO: In future better to match by ID or internal request tracking.
        clearTimeout(timeout);
        // service.removeListener('proposal', handler); // removed here as 'once' handles it
        resolve(proposalData);
      };

      // REMOVIDO: removeAllListeners causava timeout em requisições paralelas
      // service.removeAllListeners('proposal');

      service.once('proposal', handler);

      // Preparar configuração da proposta
      const proposalConfig: any = {
        symbol: config.symbol,
        contractType: config.contractType,
        duration: config.duration,
        durationUnit: config.durationUnit,
        amount: config.amount,
      };

      // Adicionar barrier para contratos de dígitos
      const digitContracts = ['DIGITMATCH', 'DIGITDIFF', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'];
      if (digitContracts.includes(config.contractType)) {
        if ((config as any).barrier !== undefined && (config as any).barrier !== null) {
          proposalConfig.barrier = (config as any).barrier;
        } else {
          // Por padrão, usar 3 se não especificado (solicitação do usuário)
          proposalConfig.barrier = 0.1;
        }
      }

      // Adicionar multiplier para contratos MULTUP/MULTDOWN
      if (config.contractType === 'MULTUP' || config.contractType === 'MULTDOWN') {
        if ((config as any).multiplier !== undefined && (config as any).multiplier !== null) {
          proposalConfig.multiplier = (config as any).multiplier;
        } else {
          // Por padrão, usar 10 se não especificado
          proposalConfig.multiplier = 10;
        }
      }

      // ✅ Usar token explícito para garantir envio na conexão correta
      service.subscribeToProposal(proposalConfig);
    });
  }

  @Post('trading/sell')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async sellContract(
    @Body() body: SellContractDto,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} vendendo contrato ${body.contractId}`);

    try {
      const service = this.wsManager.getService(userId);
      if (!service) {
        throw new BadRequestException('Serviço WebSocket não encontrado. Conecte-se primeiro.');
      }

      // Buscar preço atual do contrato antes de vender
      // O preço será determinado pela Deriv automaticamente
      service.sellContract(body.contractId, 0); // 0 = vender ao preço atual

      return {
        success: true,
        message: 'Venda executada',
        contractId: body.contractId,
      };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao vender contrato: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao vender contrato');
    }
  }

  @Post('trading/proposal')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async getProposal(
    @Body() body: ProposalDto,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} solicitando proposta:`, body);

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Se não estiver conectado, conectar primeiro
      if (!service['isAuthorized']) {
        const token = await this.getTokenFromStorage(userId);
        if (!token) {
          throw new BadRequestException('Token não encontrado. Conecte-se primeiro.');
        }
        await service.connect(token);
      }

      const proposal = await this.getProposalInternal(service, body);

      return {
        success: true,
        proposal: {
          id: proposal.id,
          askPrice: proposal.askPrice,
          payout: proposal.payout,
          spot: proposal.spot,
          dateStart: proposal.dateStart,
        },
      };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao buscar proposta: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao buscar proposta');
    }
  }

  @Post('trading/default-values')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async getDefaultValues(
    @Body() body: DefaultValuesDto,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} solicitando valores padrão:`, body);

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Se não estiver conectado, conectar primeiro
      if (!service['isAuthorized']) {
        const token = await this.getTokenFromStorage(userId);
        if (!token) {
          throw new BadRequestException('Token não encontrado. Conecte-se primeiro.');
        }
        await service.connect(token);
      }

      // Buscar contratos disponíveis para o símbolo
      let contracts;
      try {
        contracts = await this.getContractsInternal(service, body.symbol, 'USD');
        this.logger.log(`[Trading] Contratos recebidos para ${body.symbol}:`, JSON.stringify(contracts, null, 2));
      } catch (error) {
        this.logger.warn(`[Trading] Erro ao buscar contratos: ${error.message}`);
        contracts = null;
      }

      // Processar contratos para extrair tipos disponíveis
      let availableContracts: any[] = [];
      if (contracts) {
        // A API Deriv retorna contracts_for como um objeto com arrays de contratos
        // Estrutura pode ser: { contracts_for: { [symbol]: [...] } } ou array direto
        if (Array.isArray(contracts)) {
          availableContracts = contracts;
        } else if (contracts.contracts_for && typeof contracts.contracts_for === 'object') {
          // Se for um objeto, extrair os contratos do símbolo
          const symbolContracts = contracts.contracts_for[body.symbol];
          if (Array.isArray(symbolContracts)) {
            availableContracts = symbolContracts;
          } else if (symbolContracts && Array.isArray(symbolContracts.available)) {
            availableContracts = symbolContracts.available;
          } else if (symbolContracts && typeof symbolContracts === 'object') {
            // Pode ser um objeto com propriedades de contratos
            availableContracts = Object.values(symbolContracts).filter(Array.isArray).flat();
          }
        } else if (contracts[body.symbol]) {
          // Se o símbolo for uma chave direta
          availableContracts = Array.isArray(contracts[body.symbol]) ? contracts[body.symbol] : [];
        } else if (typeof contracts === 'object') {
          // Tentar extrair de qualquer estrutura de objeto
          const allValues = Object.values(contracts);
          for (const value of allValues) {
            if (Array.isArray(value)) {
              availableContracts = [...availableContracts, ...value];
            } else if (value && typeof value === 'object' && value[body.symbol]) {
              const symbolData = value[body.symbol];
              if (Array.isArray(symbolData)) {
                availableContracts = [...availableContracts, ...symbolData];
              }
            }
          }
        }

        // Normalizar estrutura dos contratos - garantir que tenham contract_type
        availableContracts = availableContracts.map(contract => {
          if (typeof contract === 'string') {
            return { contract_type: contract };
          }
          if (contract && typeof contract === 'object') {
            // Garantir que tenha contract_type
            if (!contract.contract_type && contract.type) {
              contract.contract_type = contract.type;
            }
            if (!contract.contract_type && contract.name) {
              contract.contract_type = contract.name;
            }
            return contract;
          }
          return contract;
        }).filter(c => c && c.contract_type);

        this.logger.log(`[Trading] Contratos processados (${availableContracts.length}):`, JSON.stringify(availableContracts, null, 2));
      }

      // Buscar durações disponíveis
      const durations = await this.getTradingDurationsInternal(service);

      // Determinar valores padrão baseado no símbolo e tipo de contrato
      const defaultValues = {
        amount: 10, // Valor padrão
        duration: 1,
        durationUnit: 'm' as 'm' | 't',
        availableDurations: durations || [],
        availableContracts: availableContracts,
        minAmount: 0.35,
        maxAmount: 10000,
      };

      // Ajustar valores padrão baseado no tipo de contrato e símbolo
      if (body.contractType === 'CALL' || body.contractType === 'PUT') {
        // Para CALL/PUT, usar minutos por padrão
        defaultValues.durationUnit = 'm';
        defaultValues.duration = 1;
      }

      return {
        success: true,
        defaultValues,
      };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao buscar valores padrão: ${error.message}`);
      // Retornar valores padrão mesmo em caso de erro
      return {
        success: true,
        defaultValues: {
          amount: 10,
          duration: 1,
          durationUnit: 'm',
          minAmount: 0.35,
          maxAmount: 10000,
        },
      };
    }
  }

  private async getContractsInternal(service: any, symbol: string, currency: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout ao buscar contratos'));
      }, 10000);

      const handler = (contractsData: any) => {
        clearTimeout(timeout);
        service.removeListener('contracts_for', handler);
        resolve(contractsData);
      };

      service.once('contracts_for', handler);
      service.getContractsFor(symbol, currency);
    });
  }

  private async getTradingDurationsInternal(service: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout ao buscar durações'));
      }, 10000);

      const handler = (durationsData: any) => {
        clearTimeout(timeout);
        service.removeListener('trading_durations', handler);
        resolve(durationsData);
      };

      service.once('trading_durations', handler);
      service.getTradingDurations('svg');
    });
  }

  @Post('trading/get-contracts')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async getContracts(
    @Body() body: { symbol: string; currency?: string; token?: string },
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} solicitando contratos para ${body.symbol}`);

    try {
      const service = this.wsManager.getOrCreateService(userId);

      // Se não estiver conectado, conectar primeiro
      if (!service['isAuthorized']) {
        const token = await this.resolveTokenForUser(userId);
        if (!token) {
          throw new BadRequestException('Token não encontrado no backend.');
        }
        await service.connect(token);
      }

      service.getContractsFor(body.symbol, body.currency || 'USD');
      return { success: true, message: 'Solicitação de contratos enviada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao buscar contratos: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao buscar contratos');
    }
  }

  @Post('trading/cancel-subscription')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async cancelSubscription(
    @Body() body: { subscriptionId: string },
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} cancelando subscription ${body.subscriptionId}`);

    try {
      const service = this.wsManager.getService(userId);
      if (!service) {
        throw new BadRequestException('Serviço WebSocket não encontrado');
      }

      service.cancelSubscription(body.subscriptionId);
      return { success: true, message: 'Subscription cancelada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao cancelar subscription: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao cancelar subscription');
    }
  }

  @Post('trading/cancel-tick-subscription')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async cancelTickSubscription(@Req() req: any) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} cancelando subscription de ticks`);

    try {
      const service = this.wsManager.getService(userId);
      if (!service) {
        throw new BadRequestException('Serviço WebSocket não encontrado');
      }

      service.cancelTickSubscription();
      return { success: true, message: 'Subscription de ticks cancelada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao cancelar subscription de ticks: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao cancelar subscription de ticks');
    }
  }

  @Post('trading/cancel-proposal-subscription')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async cancelProposalSubscription(@Req() req: any) {
    const userId = req.user.userId;
    this.logger.log(`[Trading] Usuário ${userId} cancelando subscription de proposta`);

    try {
      const service = this.wsManager.getService(userId);
      if (!service) {
        throw new BadRequestException('Serviço WebSocket não encontrado');
      }

      service.cancelProposalSubscription();
      return { success: true, message: 'Subscription de proposta cancelada' };
    } catch (error) {
      this.logger.error(`[Trading] Erro ao cancelar subscription de proposta: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao cancelar subscription de proposta');
    }
  }

  @Get('trading/last-orders')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async getLastOrders(
    @Req() req: any,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user.userId;
    const parsedLimit = parseInt(limit || '50', 10);
    const limitValue = Math.min(parsedLimit, 50); // Máximo de 50 ordens
    this.logger.log(`[Trading] Usuário ${userId} solicitando últimas ${limitValue} ordens Deriv`);

    try {
      // Buscar todas as ordens do usuário
      const orders = await this.tradeRepository.find({
        where: {
          userId,
        },
        order: {
          createdAt: 'DESC',
        },
        take: limitValue,
      });

      this.logger.log(`[Trading] Encontradas ${orders.length} ordens para o usuário ${userId}`);
      if (orders.length > 0) {
        this.logger.log(`[Trading] Primeira ordem exemplo:`, JSON.stringify({
          id: orders[0].id,
          contractType: orders[0].contractType,
          entryValue: orders[0].entryValue,
          entrySpot: orders[0].entrySpot,
          exitValue: orders[0].exitValue,
          exitSpot: orders[0].exitSpot,
          symbol: orders[0].symbol || null,
          derivTransactionId: orders[0].derivTransactionId,
          status: orders[0].status,
        }));
      }

      return orders.map(order => {
        // Mapear status: se expirou e não tem profit definido, considerar como closed
        let displayStatus: TradeStatus = order.status;
        if (order.status === 'pending' && order.exitSpot !== null && order.exitSpot !== undefined) {
          // Se tem exitSpot mas ainda está pending, provavelmente expirou
          const profitValue = order.profit !== null && order.profit !== undefined ? Number(order.profit) : null;
          displayStatus = profitValue !== null && profitValue > 0 ? TradeStatus.WON : TradeStatus.LOST;
        }

        return {
          id: order.id,
          contractType: order.contractType,
          timeType: order.timeType,
          duration: order.duration,
          multiplier: order.multiplier,
          entryValue: order.entryValue, // Valor investido (stake)
          entrySpot: order.entrySpot !== null && order.entrySpot !== undefined ? Number(order.entrySpot) : null, // Preço de entrada (spot)
          exitValue: order.exitValue !== null && order.exitValue !== undefined ? Number(order.exitValue) : null, // Valor recebido na venda
          exitSpot: order.exitSpot !== null && order.exitSpot !== undefined ? Number(order.exitSpot) : null, // Preço de saída (spot)
          tradeType: order.tradeType,
          status: displayStatus,
          profit: order.profit !== null && order.profit !== undefined ? Number(order.profit) : null,
          symbol: order.symbol || null,
          derivTransactionId: order.derivTransactionId,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        };
      });
    } catch (error) {
      this.logger.error(`[Trading] Erro ao buscar últimas ordens: ${error.message}`);
      throw new BadRequestException(error.message || 'Erro ao buscar últimas ordens');
    }
  }
}