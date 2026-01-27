import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as WebSocket from 'ws';

export interface MarkupStatisticsOptions {
    date_from: string;
    date_to: string;
    app_id?: number;
}

export interface MarkupStatisticsResult {
    total_app_markup_usd: number;
    total_transactions_count: number;
    breakdown?: Array<{
        app_id: number;
        app_markup_usd: number;
        app_markup_value: number;
        dev_currcode: string;
        transactions_count: number;
    }>;
}

@Injectable()
export class MarkupService {
    private readonly logger = new Logger(MarkupService.name);

    /**
     * Obtém estatísticas de markup da API da Deriv
     * Utiliza o endpoint app_markup_statistics via WebSocket
     * 
     * @param token - Token de API da Deriv com permissão de leitura
     * @param options - Opções incluindo date_from, date_to e app_id opcional
     * @returns Estatísticas de markup incluindo total em USD e contagem de transações
     */
    async getAppMarkupStatistics(
        token: string,
        options: MarkupStatisticsOptions,
    ): Promise<MarkupStatisticsResult> {
        if (!token) {
            throw new UnauthorizedException('Token ausente');
        }

        const appId = options.app_id || Number(process.env.DERIV_APP_ID || 1089);
        const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

        this.logger.log(
            `[MarkupService] Buscando estatísticas de markup - Período: ${options.date_from} a ${options.date_to}`,
        );

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, {
                headers: { Origin: 'https://app.deriv.com' },
            });

            let authorized = false;

            const send = (msg: unknown) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(msg));
                }
            };

            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Timeout ao obter estatísticas de markup'));
            }, 30000);

            ws.on('open', () => {
                this.logger.log('[MarkupService] WebSocket conectado, autorizando...');
                send({ authorize: token });
            });

            ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.error) {
                        clearTimeout(timeout);
                        ws.close();

                        // Tratamento de erros conhecidos
                        if (
                            msg.error.code === 'PermissionDenied' ||
                            msg.error.code === 'InputValidationFailed' ||
                            msg.error.code === 'InvalidAppID'
                        ) {
                            this.logger.warn(
                                `[MarkupService] Erro tratável ao buscar markup: ${msg.error.message} (${msg.error.code})`,
                            );
                            // Retornar valores zerados em vez de erro para erros esperados
                            resolve({
                                total_app_markup_usd: 0,
                                total_transactions_count: 0,
                                breakdown: [],
                            });
                        } else {
                            // Erros inesperados
                            this.logger.error(`[MarkupService] Erro API Markup:`, msg.error);
                            reject(new Error(msg.error.message || 'Erro na API Deriv'));
                        }
                        return;
                    }

                    if (msg.msg_type === 'authorize') {
                        authorized = true;
                        this.logger.log(
                            `[MarkupService] Autorizado. Solicitando estatísticas de markup...`,
                        );

                        const request: any = {
                            app_markup_statistics: 1,
                            date_from: options.date_from,
                            date_to: options.date_to,
                        };

                        send(request);
                    } else if (msg.msg_type === 'app_markup_statistics') {
                        clearTimeout(timeout);
                        this.logger.log(
                            `[MarkupService] Estatísticas recebidas - Total USD: ${msg.app_markup_statistics?.total_app_markup_usd || 0}, Transações: ${msg.app_markup_statistics?.total_transactions_count || 0}`,
                        );

                        const result: MarkupStatisticsResult = {
                            total_app_markup_usd:
                                msg.app_markup_statistics?.total_app_markup_usd || 0,
                            total_transactions_count:
                                msg.app_markup_statistics?.total_transactions_count || 0,
                            breakdown: msg.app_markup_statistics?.breakdown || [],
                        };

                        resolve(result);
                        ws.close();
                    }
                } catch (error) {
                    this.logger.error(
                        `[MarkupService] Erro ao processar mensagem: ${error}`,
                    );
                    clearTimeout(timeout);
                    reject(error);
                    ws.close();
                }
            });

            ws.on('error', (error) => {
                this.logger.error(`[MarkupService] Erro WebSocket: ${error}`);
                clearTimeout(timeout);
                reject(error);
            });

            ws.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }
}
