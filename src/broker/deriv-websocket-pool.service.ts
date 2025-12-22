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

    // Enfileirar subscribe
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout após ${timeoutMs}ms`)), timeoutMs);
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

    conn.subs.set(subId, { request: subscribePayload, callback });
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
   */
  removeSubscription(token: string, subId: string): void {
    const conn = this.connections.get(token);
    if (conn) conn.subs.delete(subId);
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

        // Autorizado
        if (msg.authorize) {
          conn.ready = true;
          this.flushQueue(conn);
          return;
        }

        // Mensagens de subscribe: encaminhar pelo subscription id ou subId customizado
        const subscriptionId = msg.subscription?.id;
        if (subscriptionId && conn.subs.has(subscriptionId)) {
          const sub = conn.subs.get(subscriptionId)!;
          sub.callback(msg);
          return;
        }

        // Resposta a requests da fila (non-subscribe)
        const pending = conn.queue.shift();
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(msg);
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
    if (!conn.ready) return;
    if (conn.ws.readyState !== WebSocket.OPEN) return;

    while (conn.queue.length) {
      const req = conn.queue.shift();
      if (!req) continue;
      try {
        conn.ws.send(JSON.stringify(req.payload));
      } catch (err) {
        clearTimeout(req.timeout);
        req.reject(err);
      }
    }
  }

  private sendAuthorize(ws: WebSocket, token: string) {
    ws.send(JSON.stringify({ authorize: token }));
  }
}


