import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import WebSocket from 'ws';

type CurrencyAccountEntry = { value: number; loginid: string; isDemo?: boolean };

type AggregatedBalances = {
  by_type: Record<string, {
    real: Record<string, number>;
    demo: Record<string, number>;
  }>;
  global: {
    real: Record<string, number>;
    demo: Record<string, number>;
  };
  warnings: string[];
};

export type DerivAccountResult = {
  loginid: string;
  currency: string;
  balance: { value: number; currency: string };
  balancesByCurrency: Record<string, number>;
  balancesByCurrencyDemo?: Record<string, number>;
  balancesByCurrencyReal?: Record<string, number>;
  accountsByCurrency: Record<string, CurrencyAccountEntry[]>;
  aggregatedBalances?: AggregatedBalances;
  tokensByLoginId?: Record<string, string>;
  realAmount?: number;
  demoAmount?: number;
  idRealAccount?: string;
  idDemoAccount?: string;
};

@Injectable()
export class DerivService {
  private readonly logger = new Logger(DerivService.name);
  private sessionStore = new Map<string, any>();

  /**
   * Agrupa saldos por type, mode (real/demo) e currency
   * Usa converted_amount se disponível, senão balance
   * Ignora loginid/ID das contas na lógica de agregação
   */
  private aggregateBalances(accounts: Record<string, any>): AggregatedBalances {
    this.logger.log(`[DerivService] aggregateBalances chamado com ${Object.keys(accounts).length} contas`);
    const totais: Record<string, { real: Record<string, number>; demo: Record<string, number> }> = {};
    const warnings: string[] = [];

    for (const accountId in accounts) {
      const account = accounts[accountId];

      // Normalizar demo_account: 0 ou false = real, 1 ou true = demo
      const demoFlag = account.demo_account;
      const isDemo = demoFlag === 1 || demoFlag === true || demoFlag === '1';
      const mode = isDemo ? 'demo' : 'real';

      // Obter type (deriv, mt5, etc) ou "unknown" se ausente
      const type = account.type || 'unknown';

      // Normalizar currency para uppercase
      const currency = (account.currency || 'UNKNOWN').toUpperCase();
      if (currency === 'UNKNOWN') {
        warnings.push(`Conta ${accountId} sem currency definida`);
      }

      // Usar converted_amount se existir e for numérico, senão usar balance
      let value = 0;
      if (account.converted_amount !== null && account.converted_amount !== undefined) {
        const converted = parseFloat(account.converted_amount);
        if (!isNaN(converted)) {
          value = converted;
        } else if (account.balance !== null && account.balance !== undefined) {
          const balance = parseFloat(account.balance);
          if (!isNaN(balance)) {
            value = balance;
          } else {
            warnings.push(`Conta ${accountId} sem valor numérico válido (converted_amount e balance inválidos)`);
          }
        } else {
          warnings.push(`Conta ${accountId} sem valor numérico válido`);
        }
      } else if (account.balance !== null && account.balance !== undefined) {
        const balance = parseFloat(account.balance);
        if (!isNaN(balance)) {
          value = balance;
        } else {
          warnings.push(`Conta ${accountId} sem valor numérico válido`);
        }
      } else {
        warnings.push(`Conta ${accountId} sem valor numérico válido`);
      }

      // Inicializar níveis do dicionário se necessário
      if (!totais[type]) {
        totais[type] = { real: {}, demo: {} };
      }
      if (!totais[type][mode][currency]) {
        totais[type][mode][currency] = 0;
      }

      // Somar valor
      totais[type][mode][currency] += value;
    }

    // Calcular totais globais por mode/currency
    const global: { real: Record<string, number>; demo: Record<string, number> } = {
      real: {},
      demo: {},
    };

    for (const typeKey in totais) {
      for (const modeKey of ['real', 'demo'] as const) {
        for (const currencyKey in totais[typeKey][modeKey]) {
          if (!global[modeKey][currencyKey]) {
            global[modeKey][currencyKey] = 0;
          }
          global[modeKey][currencyKey] += totais[typeKey][modeKey][currencyKey];
        }
      }
    }

    const result = {
      by_type: totais,
      global,
      warnings,
    };

    this.logger.log(`[DerivService] aggregateBalances resultado - global.real: ${JSON.stringify(global.real)}, global.demo: ${JSON.stringify(global.demo)}`);

    return result;
  }

  async connectAndGetAccount(token: string, appId: number, targetCurrency?: string): Promise<DerivAccountResult> {
    if (!token) throw new UnauthorizedException('Token ausente');
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    const ws = new WebSocket(url, {
      headers: {
        Origin: 'https://app.deriv.com',
      },
    });

    const send = (msg: unknown) => ws.send(JSON.stringify(msg));

    const result = await new Promise<DerivAccountResult>((resolve, reject) => {
      let authorized = false;
      let tryingAllAccounts = true;
      let fallbackInProgress = false;

      const sendBalanceRequest = () => {
        const payload: Record<string, any> = { balance: 1 };
        if (tryingAllAccounts) {
          payload.account = 'all';
        }
        send(payload);
      };

      ws.on('open', () => {
        send({ authorize: token });
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) {
            if (
              tryingAllAccounts &&
              !fallbackInProgress &&
              (msg.error.code === 'PermissionDenied' ||
                msg.error.message?.toLowerCase().includes('all accounts'))
            ) {
              this.logger.warn(
                '[DerivService] Permissão negada para balance account:all. Tentando fallback simples.',
              );
              tryingAllAccounts = false;
              fallbackInProgress = true;
              sendBalanceRequest();
              return;
            }
            this.logger.error(`Erro na API Deriv: ${JSON.stringify(msg.error)}`);
            reject(new UnauthorizedException(msg.error.message || 'Erro na API Deriv'));
            ws.close();
            return;
          }
          if (msg.msg_type === 'authorize') {
            authorized = true;
            sendBalanceRequest();
          } else if (authorized && msg.msg_type === 'balance') {
            this.logger.log(
              `[DerivService] Resposta completa da API Deriv: ${JSON.stringify(msg, null, 2)}`,
            );
            this.logger.log(
              `[DerivService] Estrutura do balance: ${JSON.stringify(msg.balance, null, 2)}`,
            );

            const balanceData = msg.balance;
            const desiredCurrency = targetCurrency?.toUpperCase();

            // Agregar saldos usando a nova lógica
            this.logger.log(`[DerivService] DEBUG - balanceData.accounts existe? ${!!balanceData.accounts}`);
            this.logger.log(`[DerivService] DEBUG - balanceData.accounts keys: ${balanceData.accounts ? Object.keys(balanceData.accounts).join(', ') : 'N/A'}`);

            const aggregatedBalances = balanceData.accounts
              ? this.aggregateBalances(balanceData.accounts)
              : { by_type: {}, global: { real: {}, demo: {} }, warnings: [] };

            // Log dos warnings se houver
            if (aggregatedBalances.warnings.length > 0) {
              this.logger.warn(`[DerivService] Warnings ao processar contas: ${aggregatedBalances.warnings.join(', ')}`);
            }

            // Log da estrutura agregada
            this.logger.log(
              `[DerivService] Saldos agregados: ${JSON.stringify(aggregatedBalances, null, 2)}`,
            );
            this.logger.log(
              `[DerivService] DEBUG - aggregatedBalances.global.real: ${JSON.stringify(aggregatedBalances.global.real)}`,
            );
            this.logger.log(
              `[DerivService] DEBUG - aggregatedBalances.global.demo: ${JSON.stringify(aggregatedBalances.global.demo)}`,
            );

            // Manter estrutura antiga para compatibilidade (accountsByCurrency)
            const accountsByCurrency: Record<string, CurrencyAccountEntry[]> = {};
            const allDemoAccounts: CurrencyAccountEntry[] = [];
            const allRealAccounts: CurrencyAccountEntry[] = [];

            if (balanceData.accounts) {
              for (const accountId in balanceData.accounts) {
                const account = balanceData.accounts[accountId];
                const currencyCode = (account.currency || '').toUpperCase();
                if (!currencyCode) continue;

                // Usar converted_amount se disponível, senão balance
                const numericBalance = account.converted_amount !== null && account.converted_amount !== undefined
                  ? parseFloat(account.converted_amount)
                  : parseFloat(account.balance ?? 0);

                // Identificar se é conta demo: usar demo_account como fonte primária
                const isDemoAccount =
                  account.demo_account === 1 ||
                  account.demo_account === true;

                const accountEntry = {
                  value: numericBalance,
                  loginid: accountId,
                  isDemo: isDemoAccount,
                };

                if (!accountsByCurrency[currencyCode]) {
                  accountsByCurrency[currencyCode] = [];
                }
                accountsByCurrency[currencyCode].push(accountEntry);

                // Separar contas demo e reais para facilitar seleção
                if (isDemoAccount) {
                  allDemoAccounts.push(accountEntry);
                } else {
                  allRealAccounts.push(accountEntry);
                }

                this.logger.log(
                  `[DerivService] Conta ${accountId}: moeda ${currencyCode}, saldo ${numericBalance}, tipo: ${isDemoAccount ? 'DEMO' : 'REAL'}, demo_account: ${account.demo_account}, type: ${account.type || 'unknown'}`,
                );
              }
            }

            const mainCurrency = (balanceData.currency || desiredCurrency || 'USD').toUpperCase();
            const mainBalanceValue = parseFloat(balanceData.balance ?? 0);
            // Usar demo_account como fonte primária para identificar se é demo
            const mainIsDemo = balanceData.demo_account === 1 || balanceData.demo_account === true;

            if (!accountsByCurrency[mainCurrency] || !accountsByCurrency[mainCurrency].length) {
              accountsByCurrency[mainCurrency] = [
                { value: mainBalanceValue, loginid: balanceData.loginid || '', isDemo: mainIsDemo },
              ];
            }

            // Se o usuário configurou DEMO, buscar contas demo (priorizando USD demo)
            // Se configurou USD/BTC, priorizar contas reais (CR), mas usar demo se não houver
            let selectedEntry;
            let selectedCurrency;

            if (desiredCurrency === 'DEMO') {
              // Para DEMO, buscar contas demo (verificar propriedade isDemo)
              // Priorizar USD demo se disponível, senão usar qualquer conta demo
              const usdDemoAccounts = accountsByCurrency['USD']?.filter(acc => acc.isDemo === true) || [];
              if (usdDemoAccounts.length > 0) {
                selectedEntry = usdDemoAccounts[0];
                selectedCurrency = 'USD';
              } else if (allDemoAccounts.length > 0) {
                // Se não houver USD demo, usar a primeira conta demo disponível
                selectedEntry = allDemoAccounts[0];
                // Determinar a moeda da conta demo selecionada
                for (const [currency, accounts] of Object.entries(accountsByCurrency)) {
                  if (accounts.some(acc => acc.loginid === selectedEntry.loginid)) {
                    selectedCurrency = currency;
                    break;
                  }
                }
                selectedCurrency = selectedCurrency || 'USD';
              } else {
                // Fallback: usar conta principal se não houver contas demo
                selectedEntry = { value: mainBalanceValue, loginid: balanceData.loginid, isDemo: false };
                selectedCurrency = mainCurrency;
              }
            } else {
              // Para USD/BTC, priorizar contas reais (não demo), mas usar demo se não houver
              const desiredEntries = desiredCurrency ? accountsByCurrency[desiredCurrency] : undefined;
              const currencyEntries =
                desiredEntries && desiredEntries.length
                  ? desiredEntries
                  : accountsByCurrency[mainCurrency] ?? [];

              selectedEntry =
                currencyEntries.find(entry => entry.isDemo === false || entry.isDemo === undefined) ||
                currencyEntries[0] ||
                { value: mainBalanceValue, loginid: balanceData.loginid, isDemo: false };

              selectedCurrency =
                desiredCurrency && desiredEntries && desiredEntries.length
                  ? desiredCurrency
                  : mainCurrency;
            }

            const flattenedBalances = Object.fromEntries(
              Object.entries(accountsByCurrency).map(([currencyKey, entries]) => [
                currencyKey,
                entries.reduce((sum, entry) => sum + entry.value, 0),
              ]),
            );

            // Usar dados agregados para balancesByCurrencyDemo e balancesByCurrencyReal
            // Isso garante que usamos converted_amount quando disponível e agrupamos corretamente
            const balancesByCurrencyDemo: Record<string, number> = { ...aggregatedBalances.global.demo };
            const balancesByCurrencyReal: Record<string, number> = { ...aggregatedBalances.global.real };

            // Log para debug - verificar se os dados estão sendo criados
            this.logger.log(
              `[DerivService] DEBUG - aggregatedBalances.global.demo: ${JSON.stringify(aggregatedBalances.global.demo)}`,
            );
            this.logger.log(
              `[DerivService] DEBUG - aggregatedBalances.global.real: ${JSON.stringify(aggregatedBalances.global.real)}`,
            );
            this.logger.log(
              `[DerivService] DEBUG - balancesByCurrencyDemo criado: ${JSON.stringify(balancesByCurrencyDemo)}`,
            );
            this.logger.log(
              `[DerivService] DEBUG - balancesByCurrencyReal criado: ${JSON.stringify(balancesByCurrencyReal)}`,
            );

            const accountData: DerivAccountResult = {
              loginid: selectedEntry.loginid || balanceData.loginid,
              currency: selectedCurrency || mainCurrency,
              balance: {
                value: selectedEntry.value,
                currency: selectedCurrency,
              },
              balancesByCurrency: flattenedBalances,
              balancesByCurrencyDemo,
              balancesByCurrencyReal,
              accountsByCurrency,
              aggregatedBalances,
              tokensByLoginId: {
                [selectedEntry.loginid || balanceData.loginid]: token
              },
              idRealAccount: allRealAccounts.length > 0 ? allRealAccounts[0].loginid : undefined,
              idDemoAccount: allDemoAccounts.length > 0 ? allDemoAccounts[0].loginid : undefined,
            };

            this.logger.log(
              `[DerivService] Retorno da Deriv - LoginID: ${accountData.loginid}, Currency: ${accountData.currency}, Balance: ${accountData.balance.value}`,
            );
            this.logger.log(
              `[DerivService] Saldos separados - Demo: ${JSON.stringify(accountData.balancesByCurrencyDemo)}, Real: ${JSON.stringify(accountData.balancesByCurrencyReal)}`,
            );
            this.logger.log(
              `[DerivService] Retorno completo: ${JSON.stringify({
                loginid: accountData.loginid,
                currency: accountData.currency,
                balance: accountData.balance,
                balancesByCurrency: accountData.balancesByCurrency,
                balancesByCurrencyDemo: accountData.balancesByCurrencyDemo,
                balancesByCurrencyReal: accountData.balancesByCurrencyReal
              })}`,
            );

            // Log do objeto completo antes de resolver
            this.logger.log(`[DerivService] DEBUG - accountData completo antes de resolve: ${JSON.stringify(accountData)}`);

            resolve(accountData);
            ws.close();
          }
        } catch (error) {
          this.logger.error(`Erro ao processar mensagem da API Deriv: ${error.message}`);
          reject(new UnauthorizedException('Erro ao processar mensagem da API Deriv'));
          ws.close();
        }
      });

      ws.on('error', error => {
        this.logger.error(`Erro de conexão WebSocket: ${error.message}`);
        reject(new UnauthorizedException('Erro de conexão WebSocket'));
      });

      ws.on('close', () => {
        this.logger.warn('[DerivService] Conexão WebSocket fechada.');
      });
    });

    return result;
  }

  async refreshBalance(token: string, appId: number = 1089, targetCurrency?: string) {
    this.logger.log(`Buscando saldo atualizado da Deriv para token...`);
    try {
      return await this.connectAndGetAccount(token, appId, targetCurrency);
    } catch (error) {
      this.logger.error(`Erro ao atualizar saldo da Deriv: ${error.message}`);
      throw error;
    }
  }

  pickAccountForCurrency(account: DerivAccountResult, currency: string): DerivAccountResult {
    const desiredCurrency = currency.toUpperCase();

    // Se o usuário configurou DEMO, buscar contas demo (priorizando USD demo)
    // Se configurou USD/BTC, priorizar contas reais (CR), mas usar demo se não houver
    let selectedEntry;
    let selectedCurrency;

    if (desiredCurrency === 'DEMO') {
      // Para DEMO, buscar contas demo em todas as moedas (verificar propriedade isDemo)
      // Priorizar USD demo se disponível
      const allAccounts = Object.values(account.accountsByCurrency ?? {}).flat();
      const usdDemoAccounts = (account.accountsByCurrency?.['USD'] ?? []).filter(
        acc => acc.isDemo === true
      );

      if (usdDemoAccounts.length > 0) {
        selectedEntry = usdDemoAccounts[0];
        selectedCurrency = 'USD';
      } else {
        // Buscar qualquer conta demo
        const demoAccounts = allAccounts.filter(acc => acc.isDemo === true);
        if (demoAccounts.length > 0) {
          selectedEntry = demoAccounts[0];
          // Determinar a moeda da conta demo selecionada
          for (const [curr, accounts] of Object.entries(account.accountsByCurrency ?? {})) {
            if (accounts.some(acc => acc.loginid === selectedEntry.loginid)) {
              selectedCurrency = curr;
              break;
            }
          }
          selectedCurrency = selectedCurrency || 'USD';
        } else {
          // Fallback
          selectedEntry = { value: 0, loginid: account.loginid, isDemo: false };
          selectedCurrency = account.currency || 'USD';
        }
      }
    } else {
      // Para USD/BTC, priorizar contas reais (não demo), mas usar demo se não houver
      const accounts = account.accountsByCurrency?.[desiredCurrency] ?? [];
      selectedEntry =
        accounts.find(entry => entry.isDemo === false || entry.isDemo === undefined) ||
        accounts[0] ||
        { value: 0, loginid: account.loginid, isDemo: false };
      selectedCurrency = desiredCurrency;
    }

    return {
      loginid: selectedEntry.loginid || account.loginid,
      currency: selectedCurrency || account.currency || 'USD',
      balance: {
        value: selectedEntry.value ?? account.balance?.value ?? 0,
        currency: selectedCurrency || account.currency || 'USD',
      },
      balancesByCurrency: account.balancesByCurrency ?? {},
      balancesByCurrencyDemo: account.balancesByCurrencyDemo ?? {},
      balancesByCurrencyReal: account.balancesByCurrencyReal ?? {},
      accountsByCurrency: account.accountsByCurrency ?? {},
      tokensByLoginId: account.tokensByLoginId ?? {},
      idRealAccount: account.idRealAccount,
      idDemoAccount: account.idDemoAccount,
    };
  }

  setSession(userId: string, data: any) {
    if (data === null || data === undefined) {
      this.sessionStore.delete(userId);
    } else {
      this.sessionStore.set(userId, data);
    }
  }

  getSession(userId: string) {
    return this.sessionStore.get(userId);
  }

  clearSession(userId: string) {
    this.logger.log(`[DerivService] Limpando sessão para usuário ${userId}`);
    this.sessionStore.delete(userId);
  }

  /**
   * Verifica email e envia código de verificação
   * Seguindo a documentação oficial da Deriv: https://deriv.com/
   * Passo 1: Verificar email antes de criar conta
   */
  async verifyEmailForAccount(email: string): Promise<{ success: boolean; message: string }> {
    const appId = Number(process.env.DERIV_APP_ID || 1089);
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      const send = (msg: unknown) => ws.send(JSON.stringify(msg));
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout ao verificar email'));
      }, 30000);

      ws.on('open', () => {
        this.logger.log(`[VerifyEmail] Enviando verificação de email para: ${email}`);
        send({
          verify_email: email,
          type: 'account_opening', // Tipo correto conforme documentação
        });
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const response = JSON.parse(data.toString());

          if (response.error) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(response.error.message || 'Erro ao verificar email'));
            return;
          }

          if (response.verify_email) {
            clearTimeout(timeout);
            ws.close();
            this.logger.log('[VerifyEmail] Código de verificação enviado por email');
            // A Deriv envia o código por email, não retorna na resposta
            // Retornamos um indicador de sucesso
            resolve({
              success: true,
              message: 'Código de verificação enviado por email. Verifique sua caixa de entrada.',
            });
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error('Erro de conexão ao verificar email'));
      });
    });
  }

  /**
   * Cria contas DEMO e REAL na Deriv
   * Seguindo a documentação oficial: https://deriv.com/
   * Passo 2: Criar conta usando o código de verificação recebido por email
   */
  async createDerivAccount(formData: any, userId: string, verificationCode: string): Promise<any> {
    const appId = Number(process.env.DERIV_APP_ID || 1089);
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

    // Parâmetros de afiliado - utilizando o código fornecido pelo usuário
    const AFFILIATE_TOKEN = process.env.DERIV_AFFILIATE_TOKEN || '_FhZ1bYVH34z1k0YPxVS0A2Nd7ZgqdRLk/1/';
    const UTM_CAMPAIGN = process.env.DERIV_UTM_CAMPAIGN || 'zeenix_affiliate';
    const UTM_MEDIUM = process.env.DERIV_UTM_MEDIUM || 'affiliate';
    const UTM_SOURCE = process.env.DERIV_UTM_SOURCE || 'FhZ1bYVH34z1k0YPxVS0A2Nd7ZgqdRLk';

    if (AFFILIATE_TOKEN) {
      this.logger.log(
        `[CreateAccount] Usando token de afiliado: ${AFFILIATE_TOKEN}`,
      );
    } else {
      this.logger.warn(
        '[CreateAccount] Token de afiliado não configurado. Criando conta sem tracking de afiliado.',
      );
    }

    // Validar se o código de verificação foi fornecido
    if (!verificationCode) {
      throw new Error(
        'Código de verificação é obrigatório. ' +
        'Primeiro é necessário verificar o email usando o endpoint verify-email.',
      );
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      const send = (msg: unknown) => ws.send(JSON.stringify(msg));
      let demoAccountCreated = false;
      let realAccountCreated = false;
      const results: any = {};
      let demoTimeout: NodeJS.Timeout | null = null;
      let realTimeout: NodeJS.Timeout | null = null;
      let globalTimeout: NodeJS.Timeout | null = null;

      // Timeout global de 90 segundos (aumentado para dar mais tempo)
      globalTimeout = setTimeout(() => {
        this.logger.error('[CreateAccount] Timeout global atingido após 90 segundos');
        if (demoTimeout) clearTimeout(demoTimeout);
        if (realTimeout) clearTimeout(realTimeout);
        ws.close();
        reject(new Error('Timeout ao criar contas - a operação demorou mais de 90 segundos. Verifique sua conexão e tente novamente.'));
      }, 90000);

      // Timeout específico para conta DEMO (30 segundos - aumentado)
      const setDemoTimeout = () => {
        if (demoTimeout) clearTimeout(demoTimeout);
        demoTimeout = setTimeout(() => {
          this.logger.error('[CreateAccount] Timeout ao criar conta DEMO após 30 segundos');
          if (!demoAccountCreated) {
            if (globalTimeout) clearTimeout(globalTimeout);
            if (realTimeout) clearTimeout(realTimeout);
            ws.close();
            reject(new Error('Timeout ao criar conta DEMO - a operação demorou mais de 30 segundos. Verifique se o código de verificação está correto e se o email foi verificado.'));
          }
        }, 30000);
      };

      // Timeout específico para conta REAL (50 segundos após DEMO - aumentado)
      const setRealTimeout = () => {
        if (realTimeout) clearTimeout(realTimeout);
        realTimeout = setTimeout(() => {
          this.logger.error('[CreateAccount] Timeout ao criar conta REAL após 50 segundos');
          if (!realAccountCreated) {
            this.logger.warn('[CreateAccount] Conta REAL não foi criada a tempo, mas DEMO foi criada com sucesso');
            // Se a DEMO foi criada, retornar apenas ela
            if (demoAccountCreated && results.demoAccount) {
              if (globalTimeout) clearTimeout(globalTimeout);
              if (demoTimeout) clearTimeout(demoTimeout);
              ws.close();
              resolve({
                demoAccountId: results.demoAccount.client_id,
                realAccountId: null,
                demoToken: results.demoAccount.oauth_token,
                realToken: null,
                email: results.demoAccount.email,
                warning: 'Apenas a conta DEMO foi criada. A conta REAL pode ser criada posteriormente.',
              });
            } else {
              if (globalTimeout) clearTimeout(globalTimeout);
              if (demoTimeout) clearTimeout(demoTimeout);
              ws.close();
              reject(new Error('Timeout ao criar conta REAL - nenhuma conta foi criada com sucesso'));
            }
          }
        }, 50000);
      };

      ws.on('open', () => {
        this.logger.log('[CreateAccount] WebSocket aberto, criando contas...');
        this.logger.debug(
          `[CreateAccount] Configuração - AppID: ${appId}, AffiliateToken: ${AFFILIATE_TOKEN ? AFFILIATE_TOKEN.substring(0, 10) + '...' : 'não configurado'}`,
        );

        // Iniciar timeout para conta DEMO
        setDemoTimeout();

        // Validar dados obrigatórios
        if (!formData.email) {
          if (demoTimeout) clearTimeout(demoTimeout);
          if (realTimeout) clearTimeout(realTimeout);
          if (globalTimeout) clearTimeout(globalTimeout);
          ws.close();
          reject(new Error('Email é obrigatório para criar conta'));
          return;
        }

        // Gerar senha (o código de verificação vem do email)
        const password = this.generatePassword();

        // Criar conta DEMO primeiro - seguindo documentação oficial da Deriv
        const demoRequest: any = {
          new_account_virtual: 1,
          client_password: password,
          verification_code: verificationCode, // Código recebido por email
          type: 'dynamic',
          residence: formData.pais || 'br',
          date_first_contact: new Date().toISOString().split('T')[0],
          signup_device: 'desktop',
          email: formData.email,
          utm_campaign: UTM_CAMPAIGN,
          utm_medium: UTM_MEDIUM,
          utm_source: UTM_SOURCE,
        };

        // Adicionar affiliate_token apenas se estiver configurado (opcional)
        if (AFFILIATE_TOKEN) {
          demoRequest.affiliate_token = AFFILIATE_TOKEN;
        }

        this.logger.log('[CreateAccount] Enviando request para conta DEMO');
        this.logger.log(`[CreateAccount] Request DEMO (sem senha/código): ${JSON.stringify({
          ...demoRequest,
          client_password: '<hidden>',
          verification_code: '<hidden>'
        })}`);
        this.logger.debug(`[CreateAccount] Código de verificação usado: ${verificationCode.substring(0, 3)}...`);
        send(demoRequest);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const response = JSON.parse(data.toString());
          this.logger.log('[CreateAccount] Resposta recebida da Deriv:', JSON.stringify(response));

          if (response.error) {
            this.logger.error('[CreateAccount] Erro da Deriv:', response.error);
            if (demoTimeout) clearTimeout(demoTimeout);
            if (realTimeout) clearTimeout(realTimeout);
            if (globalTimeout) clearTimeout(globalTimeout);
            ws.close();

            // Mensagens de erro mais específicas
            let errorMessage = response.error.message || 'Erro ao criar conta';
            if (response.error.code === 'InvalidToken') {
              if (AFFILIATE_TOKEN) {
                errorMessage =
                  'Token de afiliado inválido ou expirado. ' +
                  'O token configurado no sistema não é válido ou expirou. ' +
                  'Entre em contato com o administrador do sistema para atualizar o token de afiliado.';
                this.logger.error(
                  `[CreateAccount] Token de afiliado inválido. Token usado: ${AFFILIATE_TOKEN.substring(0, 10)}...`,
                );
              } else {
                errorMessage =
                  'Erro ao criar conta. ' +
                  'Se você é um afiliado, configure um token de afiliado válido. ' +
                  'Caso contrário, entre em contato com o suporte.';
                this.logger.error(
                  '[CreateAccount] Erro InvalidToken sem affiliate_token configurado.',
                );
              }
              this.logger.error(
                '[CreateAccount] Verifique se o token de afiliado está correto e válido na Deriv.',
              );
            } else if (response.error.code === 'InputValidationFailed') {
              errorMessage = `Dados inválidos: ${response.error.message}. Verifique os dados fornecidos.`;
            } else if (response.error.code === 'RateLimit') {
              errorMessage = 'Limite de requisições excedido. Aguarde alguns instantes e tente novamente.';
            }

            reject(new Error(errorMessage));
            return;
          }

          // Resposta da conta DEMO
          if (response.new_account_virtual && !demoAccountCreated) {
            demoAccountCreated = true;
            if (demoTimeout) clearTimeout(demoTimeout);

            results.demoAccount = {
              client_id: response.new_account_virtual.client_id,
              email: response.new_account_virtual.email,
              currency: response.new_account_virtual.currency,
              oauth_token: response.new_account_virtual.oauth_token,
            };
            this.logger.log('[CreateAccount] Conta DEMO criada:', results.demoAccount.client_id);

            // Iniciar timeout para conta REAL
            setRealTimeout();

            // Agora criar conta REAL
            const realRequest: any = {
              new_account_real: 1,
              currency: 'USD',
              email: formData.email,
              first_name: formData.nome,
              last_name: formData.sobrenome,
              date_of_birth: formData.dataNascimento,
              address_line_1: formData.endereco,
              address_city: formData.cidade,
              address_postcode: formData.cep.replace(/\D/g, ''),
              address_state: formData.estado.toUpperCase(),
              residence: formData.pais,
              citizen: formData.pais,
              phone: formData.telefone.replace(/\D/g, ''),
              place_of_birth: formData.pais,
              account_opening_reason: 'Speculative',
              tax_residence: formData.pais,
              employment_status: 'Employed',
              tnc_acceptance: 1,
              fatca_declaration: formData.naoFATCA ? 0 : 1,
              non_pep_declaration: formData.naoPEP ? 1 : 0,
              tin_skipped: 1,
              utm_campaign: UTM_CAMPAIGN,
              utm_medium: UTM_MEDIUM,
              utm_source: UTM_SOURCE,
            };

            // Adicionar affiliate_token apenas se estiver configurado (opcional)
            if (AFFILIATE_TOKEN) {
              realRequest.affiliate_token = AFFILIATE_TOKEN;
            }

            this.logger.log('[CreateAccount] Enviando request para conta REAL');
            send(realRequest);
            return;
          }

          // Resposta da conta REAL
          if (response.new_account_real && !realAccountCreated) {
            realAccountCreated = true;
            if (realTimeout) clearTimeout(realTimeout);

            results.realAccount = {
              client_id: response.new_account_real.client_id,
              email: response.new_account_real.email,
              currency: response.new_account_real.currency,
              oauth_token: response.new_account_real.oauth_token,
            };
            this.logger.log('[CreateAccount] Conta REAL criada:', results.realAccount.client_id);

            // Limpar todos os timeouts
            if (demoTimeout) clearTimeout(demoTimeout);
            if (realTimeout) clearTimeout(realTimeout);
            if (globalTimeout) clearTimeout(globalTimeout);

            ws.close();
            resolve({
              demoAccountId: results.demoAccount.client_id,
              realAccountId: results.realAccount.client_id,
              demoToken: results.demoAccount.oauth_token,
              realToken: results.realAccount.oauth_token,
              email: results.demoAccount.email || results.realAccount.email,
            });
          }
        } catch (error) {
          this.logger.error('[CreateAccount] Erro ao processar resposta:', error);
          if (demoTimeout) clearTimeout(demoTimeout);
          if (realTimeout) clearTimeout(realTimeout);
          if (globalTimeout) clearTimeout(globalTimeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error) => {
        this.logger.error('[CreateAccount] Erro no WebSocket:', error);
        if (demoTimeout) clearTimeout(demoTimeout);
        if (realTimeout) clearTimeout(realTimeout);
        if (globalTimeout) clearTimeout(globalTimeout);
        reject(new Error('Erro de conexão com a Deriv'));
      });

      ws.on('close', () => {
        // Limpar todos os timeouts ao fechar
        if (demoTimeout) clearTimeout(demoTimeout);
        if (realTimeout) clearTimeout(realTimeout);
        if (globalTimeout) clearTimeout(globalTimeout);

        // Se a conexão foi fechada antes de completar, verificar o que foi criado
        if (!demoAccountCreated && !realAccountCreated) {
          this.logger.error('[CreateAccount] Conexão fechada sem criar nenhuma conta');
          reject(new Error('Não foi possível criar as contas - conexão fechada prematuramente'));
        } else if (demoAccountCreated && !realAccountCreated) {
          this.logger.warn('[CreateAccount] Conexão fechada após criar apenas conta DEMO');
          // Retornar apenas a conta DEMO se ela foi criada
          resolve({
            demoAccountId: results.demoAccount.client_id,
            realAccountId: null,
            demoToken: results.demoAccount.oauth_token,
            realToken: null,
            email: results.demoAccount.email,
            warning: 'Apenas a conta DEMO foi criada. A conta REAL pode ser criada posteriormente.',
          });
        }
        // Se ambas foram criadas, o resolve já foi chamado no handler de mensagem
      });
    });
  }

  private generatePassword(): string {
    // Deriv requer: ^(?=.*[a-z])(?=.*[0-9])(?=.*[A-Z])[ -~]{8,25}$
    // Garantir pelo menos: 1 minúscula, 1 número, 1 maiúscula, 1 caractere especial
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const special = '!@#$%^&*';
    const allChars = lowercase + uppercase + numbers + special;

    // Garantir pelo menos um de cada tipo (4 chars)
    let password = '';
    password += lowercase.charAt(Math.floor(Math.random() * lowercase.length));
    password += uppercase.charAt(Math.floor(Math.random() * uppercase.length));
    password += numbers.charAt(Math.floor(Math.random() * numbers.length));
    password += special.charAt(Math.floor(Math.random() * special.length));

    // Preencher o restante até 12 caracteres
    for (let i = 4; i < 12; i++) {
      password += allChars.charAt(Math.floor(Math.random() * allChars.length));
    }

    // Embaralhar para não ter padrão previsível
    return password.split('').sort(() => Math.random() - 0.5).join('');
  }

  private generateVerificationCode(): string {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
  }
  /**
 * Obtém detalhes de markup da conta via API
 * Requer token da conta (normalmente do desenvolvedor ou do cliente para ver seus próprios dados)
 */
  async getAppMarkupDetails(token: string, options: {
    date_from: string;
    date_to: string;
    limit?: number;
    client_loginid?: string;
    app_id?: number;
  }): Promise<any> {
    if (!token) throw new UnauthorizedException('Token ausente');
    const appId = options.app_id || Number(process.env.DERIV_APP_ID || 1089);
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.deriv.com' } });
      let authorized = false;

      const send = (msg: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      };

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout ao obter detalhes de markup'));
      }, 30000);

      ws.on('open', () => {
        send({ authorize: token });
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            this.logger.error(`[DerivService] Erro API Markup:`, msg.error);
            clearTimeout(timeout);
            ws.close();
            // Resolver com array vazio em caso de erro de permissão ou dados não encontrados para não quebrar o fluxo geral
            if (msg.error.code === 'PermissionDenied' || msg.error.code === 'InputValidationFailed') {
              this.logger.warn(`[DerivService] Erro tratável ao buscar markup: ${msg.error.message}`);
              resolve({ transactions: [] });
            } else {
              reject(new Error(msg.error.message || 'Erro na API Deriv'));
            }
            return;
          }

          if (msg.msg_type === 'authorize') {
            authorized = true;
            this.logger.log(`[DerivService] Autorizado para markup. Solicitando detalhes...`);

            const request: any = {
              app_markup_details: 1,
              date_from: options.date_from,
              date_to: options.date_to,
              limit: options.limit || 100,
              description: 1,
            };

            if (options.client_loginid) {
              request.client_loginid = options.client_loginid;
            }

            send(request);
          } else if (msg.msg_type === 'app_markup_details') {
            clearTimeout(timeout);
            this.logger.log(`[DerivService] Dados de markup recebidos: ${msg.app_markup_details?.transactions?.length || 0} registros`);
            resolve(msg.app_markup_details);
            ws.close();
          }
        } catch (error) {
          this.logger.error(`[DerivService] Erro ao processar mensagem: ${error}`);
          clearTimeout(timeout);
          reject(error);
          ws.close();
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[DerivService] Erro WebSocket: ${error}`);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
}