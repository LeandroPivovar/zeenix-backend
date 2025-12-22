import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';

// Solicitação em fila
interface PendingRequest {
  payload: any;
  resolve: (response: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
}

// Assinatura ativa (ex.: proposal_open_contract / ticks)
interface ActiveSubscription {
  request: any;
  callback: (response: any) => void;
  subscriptionId?: string; // ID retornado pela Deriv
  customSubId: string; // ID customizado que passamos (ex.: contractId)
}

/**
 * Pool de WebSockets Deriv por token.
 * - Reutiliza uma conexão por token.
 * - Enfileira requests (authorize/proposal/buy/forget).
 * - Suporta assinaturas com callback e cancelamento.
 */
@Injectable()
export class DerivWebSocketPoolService {
  private readonly logger = new Logger(DerivWebSocketPoolService.name);

  private connections: Map<
    string,
    {
      ws: WebSocket;
      ready: boolean;
      queue: PendingRequest[];
      subs: Map<string, ActiveSubscription>;
    }
  > = new Map();

  private appId: string;

  constructor() {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  /**
   * Envia uma requisição e aguarda resposta única (non-subscribe).
   * @param token Token Deriv
   * @param payload Objeto de requisição (ex.: authorize, proposal, buy, forget)
   */
  async sendRequest(token: string, payload: any, timeoutMs = 30000): Promise<any> {
    const conn = await this.getConnection(token);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout após ${timeoutMs}ms`));
      }, timeoutMs);

      conn.queue.push({ payload, resolve, reject, timeout });
      this.flushQueue(conn);
    });
  }

  /**
   * Cria/garante conexão e registra callback para assinaturas.
   * @param token Token Deriv
   * @param subscribePayload Payload de subscribe (ex.: proposal_open_contract)
   * @param callback Callback para cada mensagem
   * @param subId Identificador da assinatura (ex.: contractId)
   */
  async subscribe(
    token: string,
    subscribePayload: any,
    callback: (response: any) => void,
    subId: string,
    timeoutMs = 30000,
  ): Promise<void> {
    const conn = await this.getConnection(token);

    // ✅ Registrar subscription ANTES de enviar para capturar subscription.id da resposta
    const subscription: ActiveSubscription = {
      request: subscribePayload,
      callback,
      customSubId: subId,
    };
    conn.subs.set(subId, subscription);

    // Enfileirar subscribe e aguardar primeira resposta
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout após ${timeoutMs}ms`)), timeoutMs);
      
      // ✅ Interceptar primeira mensagem para capturar subscription.id
      const originalCallback = subscription.callback;
      subscription.callback = (msg: any) => {
        // ✅ Capturar subscription.id da primeira mensagem
        if (msg.subscription?.id && !subscription.subscriptionId) {
          subscription.subscriptionId = msg.subscription.id;
          this.logger.debug(`[POOL] 📋 Subscription ID capturado: ${msg.subscription.id} -> ${subId}`);
          
          // ✅ Também mapear pelo subscription.id para facilitar lookup
          if (msg.subscription.id !== subId) {
            conn.subs.set(msg.subscription.id, subscription);
          }
        }
        
        // ✅ Verificar erros na mensagem
        if (msg.error) {
          this.logger.error(`[POOL] ❌ Erro na subscription ${subId}: ${JSON.stringify(msg.error)}`);
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          return;
        }
        
        // Chamar callback original
        originalCallback(msg);
      };

      conn.queue.push({
        payload: subscribePayload,
        resolve: () => {
          clearTimeout(timeout);
          resolve(undefined);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });
      this.flushQueue(conn);
    });
  }

  /**
   * Cancela assinatura (forget) se houver subscription id.
   */
  async forget(token: string, forgetId: string): Promise<void> {
    const conn = await this.getConnection(token);
    await this.sendRequest(token, { forget: forgetId });
    // Não removemos aqui; será removido quando a Deriv confirmar forget ou se caller remover manualmente.
    conn.subs.delete(forgetId);
  }

  /**
   * Remove callback localmente (sem enviar forget).
   * Remove tanto pelo customSubId quanto pelo subscriptionId se existir.
   */
  removeSubscription(token: string, subId: string): void {
    const conn = this.connections.get(token);
    if (!conn) return;

    // ✅ Remover pelo customSubId
    const sub = conn.subs.get(subId);
    if (sub) {
      // ✅ Se tiver subscriptionId mapeado, remover também
      if (sub.subscriptionId && sub.subscriptionId !== subId) {
        conn.subs.delete(sub.subscriptionId);
      }
      conn.subs.delete(subId);
      this.logger.debug(`[POOL] 🗑️ Subscription removida: ${subId}${sub.subscriptionId ? ` (subscriptionId: ${sub.subscriptionId})` : ''}`);
    }
  }

  private async getConnection(token: string) {
    if (this.connections.has(token)) {
      return this.connections.get(token)!;
    }

    const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    const ws = new WebSocket(endpoint, {
      headers: { Origin: 'https://app.deriv.com' },
    });

    const conn = {
      ws,
      ready: false,
      queue: [] as PendingRequest[],
      subs: new Map<string, ActiveSubscription>(),
    };
    this.connections.set(token, conn);

    ws.on('open', () => {
      this.logger.log(`[POOL] 🔌 Conexão aberta para token`);
      // Autorizar logo no open para reduzir latência
      this.sendAuthorize(ws, token);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());

        // Falha na autorização
        if (msg.authorize?.error) {
          this.logger.error(`[POOL] ❌ Erro na autorização: ${msg.authorize.error.message}`);
          // rejeita todos pendentes
          while (conn.queue.length) {
            const req = conn.queue.shift();
            if (req) {
              clearTimeout(req.timeout);
              req.reject(new Error(`Authorize error: ${msg.authorize.error.message}`));
            }
          }
          return;
        }

        // Autorizado (já verificamos erro acima)
        if (msg.authorize && !msg.authorize.error) {
          conn.ready = true;
          this.logger.debug(`[POOL] ✅ Autorizado com sucesso | LoginID: ${msg.authorize.loginid || 'N/A'}`);
          
          // ✅ Pequeno delay para garantir estabilidade da conexão
          setTimeout(() => {
            this.flushQueue(conn);
          }, 100);
          return;
        }

        // ✅ Verificar erros primeiro
        if (msg.error) {
          this.logger.error(`[POOL] ❌ Erro recebido: ${JSON.stringify(msg.error)}`);
          // Tentar encontrar subscription afetada
          const subscriptionId = msg.subscription?.id;
          if (subscriptionId && conn.subs.has(subscriptionId)) {
            const sub = conn.subs.get(subscriptionId)!;
            sub.callback(msg);
            return;
          }
          // Se não encontrou, pode ser erro em request pendente
          const pending = conn.queue.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            return;
          }
        }

        // ✅ Mensagens de subscribe: encaminhar pelo subscription.id retornado pela Deriv
        const subscriptionId = msg.subscription?.id;
        if (subscriptionId && conn.subs.has(subscriptionId)) {
          const sub = conn.subs.get(subscriptionId)!;
          sub.callback(msg);
          return;
        }

        // ✅ FALLBACK: Para proposal_open_contract, também verificar contract_id
        // Isso permite usar contractId como subId mesmo que subscription.id seja diferente
        if (msg.proposal_open_contract) {
          const contractId = msg.proposal_open_contract.contract_id;
          if (contractId && conn.subs.has(contractId)) {
            const sub = conn.subs.get(contractId)!;
            sub.callback(msg);
            return;
          }
        }

        // ✅ Resposta a requests da fila (non-subscribe)
        // Verificar se é erro primeiro
        if (msg.error) {
          const pending = conn.queue.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            const errorMsg = msg.error.message || JSON.stringify(msg.error);
            this.logger.error(`[POOL] ❌ Erro em request pendente: ${errorMsg}`);
            pending.reject(new Error(errorMsg));
            return;
          }
        }

        const pending = conn.queue.shift();
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(msg);
        } else {
          // ✅ Log de mensagem não processada (pode ser útil para debug)
          if (msg.msg_type && msg.msg_type !== 'ping' && msg.msg_type !== 'pong') {
            this.logger.debug(`[POOL] ⚠️ Mensagem não processada: msg_type=${msg.msg_type}, subscription=${msg.subscription?.id || 'N/A'}`);
          }
        }
      } catch (err) {
        this.logger.error('[POOL] Erro ao processar mensagem', err as any);
      }
    });

    ws.on('error', (err) => {
      this.logger.error('[POOL] Erro no WebSocket', err as any);
      // Rejeitar pendentes
      while (conn.queue.length) {
        const req = conn.queue.shift();
        if (req) {
          clearTimeout(req.timeout);
          req.reject(err);
        }
      }
      // Limpar subs
      conn.subs.clear();
      this.connections.delete(token);
    });

    ws.on('close', () => {
      this.logger.warn('[POOL] WebSocket fechado');
      // Rejeitar pendentes
      while (conn.queue.length) {
        const req = conn.queue.shift();
        if (req) {
          clearTimeout(req.timeout);
          req.reject(new Error('WebSocket closed'));
        }
      }
      conn.subs.clear();
      this.connections.delete(token);
    });

    return conn;
  }

  private flushQueue(conn: { ws: WebSocket; ready: boolean; queue: PendingRequest[] }) {
    if (!conn.ready) {
      this.logger.debug(`[POOL] ⏳ Aguardando autorização... (${conn.queue.length} requisições na fila)`);
      return;
    }
    if (conn.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[POOL] ⚠️ WebSocket não está aberto (readyState: ${conn.ws.readyState})`);
      return;
    }

    while (conn.queue.length) {
      const req = conn.queue.shift();
      if (!req) continue;
      try {
        const payloadStr = JSON.stringify(req.payload);
        this.logger.debug(`[POOL] 📤 Enviando requisição: ${req.payload.proposal ? 'proposal' : req.payload.buy ? 'buy' : req.payload.proposal_open_contract ? 'subscribe' : 'other'}`);
        conn.ws.send(payloadStr);
      } catch (err) {
        clearTimeout(req.timeout);
        this.logger.error(`[POOL] ❌ Erro ao enviar requisição:`, err);
        req.reject(err);
      }
    }
  }

  private sendAuthorize(ws: WebSocket, token: string) {
    ws.send(JSON.stringify({ authorize: token }));
  }
}


