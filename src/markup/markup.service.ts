import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

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

    constructor(private readonly configService: ConfigService) { }

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

        const appId = options.app_id || Number(this.configService.get('DERIV_APP_ID') || 111346);
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
                            app_id: appId,
                        };

                        this.logger.log(`[MarkupService] Enviando request de estatísticas: ${JSON.stringify(request)}`);
                        send(request);
                    } else if (msg.msg_type === 'app_markup_statistics') {
                        clearTimeout(timeout);
                        this.logger.log(
                            `[MarkupService] Estatísticas recebidas para AppID ${appId} - Total USD: ${msg.app_markup_statistics?.total_app_markup_usd || 0}, Transações: ${msg.app_markup_statistics?.total_transactions_count || 0}`,
                        );
                        if (msg.app_markup_statistics?.total_app_markup_usd === 0 && msg.app_markup_statistics?.total_transactions_count === 0) {
                            this.logger.warn(`[MarkupService] API retornou ZERO para AppID ${appId} no período ${options.date_from} a ${options.date_to}`);
                        }

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
    /**
     * Obtém detalhes de markup da API da Deriv com suporte a paginação
     * 
     * @param token - Token de API da Deriv
     * @param options - Opções de filtro
     * @returns Lista completa de transações de markup
     */
    async getAppMarkupDetails(
        token: string,
        options: MarkupStatisticsOptions,
    ): Promise<any[]> {
        if (!token) {
            throw new UnauthorizedException('Token ausente');
        }

        const appId = options.app_id || Number(this.configService.get('DERIV_APP_ID') || 111346);
        const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

        this.logger.log(
            `[MarkupService] Buscando detalhes de markup - AppID: ${appId} - Período: ${options.date_from} a ${options.date_to}`,
        );

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, {
                headers: { Origin: 'https://app.deriv.com' },
            });

            const allTransactions: any[] = [];
            let offset = 0;
            const limit = 1000;
            let authorized = false;

            const send = (msg: unknown) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(msg));
                }
            };

            // Timeout de segurança (60s pois pode demorar várias páginas)
            const timeout = setTimeout(() => {
                ws.close();
                if (allTransactions.length > 0) {
                    this.logger.warn(`[MarkupService] Timeout atingido, retornando ${allTransactions.length} transações parciais.`);
                    resolve(allTransactions);
                } else {
                    reject(new Error('Timeout ao obter detalhes de markup'));
                }
            }, 60000);

            ws.on('open', () => {
                this.logger.log('[MarkupService] WebSocket conectado (Details), autorizando...');
                send({ authorize: token });
            });

            ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.error) {
                        this.logger.error(`[MarkupService] Erro API Markup Details:`, msg.error);
                        // Se for erro de permissão ou similar, encerra
                        if (msg.error.code === 'PermissionDenied' || msg.error.code === 'InvalidToken') {
                            clearTimeout(timeout);
                            ws.close();
                            reject(new Error(msg.error.message));
                            return;
                        }
                        clearTimeout(timeout);
                        ws.close();
                        if (allTransactions.length > 0) {
                            resolve(allTransactions);
                        } else {
                            reject(new Error(msg.error.message || 'Erro desconhecido na API da Deriv'));
                        }
                        return;
                    }

                    if (msg.msg_type === 'authorize') {
                        authorized = true;
                        this.logger.log(`[MarkupService] Autorizado. Solicitando primeira página de detalhes...`);

                        const request = {
                            app_markup_details: 1,
                            date_from: options.date_from,
                            date_to: options.date_to,
                            limit: limit,
                            offset: offset,
                            description: 1,
                            sort: 'ASC',
                            sort_fields: ['transaction_time'],
                            app_id: appId,
                        };
                        send(request);

                    } else if (msg.msg_type === 'app_markup_details') {
                        let transactions: any[] = [];

                        // O debug mostrou que app_markup_details é um objeto { transactions: [...] }
                        if (msg.app_markup_details && Array.isArray(msg.app_markup_details.transactions)) {
                            this.logger.log(`[MarkupService] Recebido objeto com array de transações (size: ${msg.app_markup_details.transactions.length})`);
                            transactions = msg.app_markup_details.transactions;
                        }
                        // Fallback: caso a API retorne array direto (comportamento antigo ou documentado)
                        else if (Array.isArray(msg.app_markup_details)) {
                            this.logger.log(`[MarkupService] Recebido array direto de transações (size: ${msg.app_markup_details.length})`);
                            transactions = msg.app_markup_details;
                        } else {
                            this.logger.warn(`[MarkupService] Formato inesperado. Keys: ${Object.keys(msg.app_markup_details || {})}`);
                        }

                        allTransactions.push(...transactions);

                        this.logger.log(`[MarkupService] Recebido lote de ${transactions.length} transações. Total: ${allTransactions.length}`);

                        if (transactions.length < limit) {
                            // Fim da paginação
                            clearTimeout(timeout);
                            this.logger.log(`[MarkupService] Busca concluída. Total de transações: ${allTransactions.length}`);
                            resolve(allTransactions);
                            ws.close();
                        } else {
                            // Buscar próxima página
                            offset += limit;
                            this.logger.log(`[MarkupService] Buscando próxima página. Offset: ${offset}`);
                            const request = {
                                app_markup_details: 1,
                                date_from: options.date_from,
                                date_to: options.date_to,
                                limit: limit,
                                offset: offset,
                                description: 1,
                                sort: 'ASC',
                                sort_fields: ['transaction_time'],
                                app_id: appId,
                            };
                            send(request);
                        }
                    }

                } catch (error) {
                    this.logger.error(`[MarkupService] Erro ao processar mensagem (Details): ${error}`);
                    clearTimeout(timeout);
                    ws.close();
                    reject(error);
                }
            });

            ws.on('error', (error) => {
                this.logger.error(`[MarkupService] Erro WebSocket (Details): ${error}`);
                clearTimeout(timeout);
                reject(error);
            });

            ws.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }
}
