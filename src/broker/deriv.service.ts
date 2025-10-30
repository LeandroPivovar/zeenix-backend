import { Injectable, UnauthorizedException } from '@nestjs/common';
import WebSocket from 'ws';

@Injectable()
export class DerivService {
  private sessionStore = new Map<string, any>();
  async connectAndGetAccount(token: string, appId: number) {
    if (!token) throw new UnauthorizedException('Token ausente');
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    const ws = new WebSocket(url, {
      headers: {
        // Alguns endpoints do Deriv exigem um Origin válido
        Origin: 'https://app.deriv.com',
      },
    });

    const send = (msg: unknown) => ws.send(JSON.stringify(msg));

    const result = await new Promise<any>((resolve, reject) => {
      let authorized = false;

      ws.on('open', () => {
        send({ authorize: token });
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) {
            reject(new UnauthorizedException(msg.error.message || 'Erro na API Deriv'));
            ws.close();
            return;
          }
          if (msg.msg_type === 'authorize') {
            authorized = true;
            send({ balance: 1 });
          } else if (authorized && msg.msg_type === 'balance') {
            resolve({
              loginid: msg.balance.loginid,
              currency: msg.balance.currency,
              balance: { value: msg.balance.balance, currency: msg.balance.currency },
            });
            ws.close();
          }
        } catch (e) {
          reject(e);
          ws.close();
        }
      });

      ws.on('error', (err) => reject(err));
      ws.on('close', () => {
        // noop
      });
    });

    return result;
  }

  setSession(userId: string, data: any) {
    this.sessionStore.set(userId, data);
  }

  getSession(userId: string) {
    return this.sessionStore.get(userId);
  }
}


