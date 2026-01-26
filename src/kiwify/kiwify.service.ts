import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class KiwifyService {
    private readonly logger = new Logger(KiwifyService.name);
    private readonly baseUrl = 'https://public-api.kiwify.com';
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;

    constructor(
        private configService: ConfigService,
        @InjectRepository(UserEntity)
        private readonly userRepository: Repository<UserEntity>
    ) { }

    private async authenticate() {
        // Verificar se o token atual ainda é válido (com margem de 5 minutos)
        if (this.accessToken && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
            return;
        }

        const clientId = this.configService.get<string>('KIWIFY_CLIENT_ID');
        const clientSecret = this.configService.get<string>('KIWIFY_CLIENT_SECRET');

        if (!clientId || !clientSecret) {
            this.logger.error('Credenciais da Kiwify não configuradas (KIWIFY_CLIENT_ID, KIWIFY_CLIENT_SECRET)');
            throw new HttpException('Configuração da Kiwify incompleta no servidor', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            this.logger.log('Autenticando na API da Kiwify...');
            const response = await fetch(`${this.baseUrl}/v1/oauth/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.error(`Falha na autenticação Kiwify: ${response.status} ${errorText}`);
                throw new HttpException('Falha na autenticação com Kiwify', HttpStatus.BAD_GATEWAY);
            }

            const data = await response.json();
            this.accessToken = data.access_token;
            // Expires in é em segundos, converter para ms e adicionar ao now
            this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
            this.logger.log('Autenticação Kiwify realizada com sucesso');
        } catch (error) {
            this.logger.error('Erro ao conectar com Kiwify', error);
            if (error instanceof HttpException) throw error;
            throw new HttpException('Erro de conexão com Kiwify', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    async getUsers() {
        await this.authenticate();

        const accountId = this.configService.get<string>('KIWIFY_ACCOUNT_ID');
        if (!accountId) {
            throw new HttpException('KIWIFY_ACCOUNT_ID não configurado', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            this.logger.log('Buscando usuários (vendas) na Kiwify...');

            // Definir datas: hoje e 30 dias atrás (formato YYYY-MM-DD para evitar problemas)
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 30);

            const formatDate = (date: Date) => date.toISOString().split('T')[0];

            const startDateStr = formatDate(startDate);
            const endDateStr = formatDate(endDate);

            const url = `${this.baseUrl}/v1/sales?page_size=100&start_date=${startDateStr}&end_date=${endDateStr}`;
            this.logger.log(`Consultando URL: ${url}`);

            // Buscar vendas (sales) - page_size de 100
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'x-kiwify-account-id': accountId,
                    'Accept': 'application/json'
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.error(`Erro ao buscar vendas Kiwify: ${response.status} ${errorText}`);
                // Retornar o erro original para facilitar debug no frontend
                throw new HttpException(`Kiwify Error: ${response.status} ${errorText}`, HttpStatus.BAD_GATEWAY);
            }

            const data = await response.json();
            const sales = data.data || [];

            this.logger.log(`Encontradas ${sales.length} vendas. Processando usuários únicos...`);

            // Extrair usuários únicos das vendas
            const uniqueUsersMap = new Map<string, any>();

            for (const sale of sales) {
                const customer = sale.customer;
                if (customer && customer.email) {
                    // Sincronizar com o banco de dados
                    try {
                        const user = await this.userRepository.findOne({ where: { email: customer.email } });
                        if (user) {
                            let updated = false;

                            // Atualizar telefone se necessário
                            const phone = customer.mobile || customer.phone;
                            if (phone && user.phone !== phone) {
                                user.phone = phone;
                                updated = true;
                            }

                            // Lógica de Expiração do Plano
                            if (sale.product) {
                                const offerId = sale.product.offer_id;
                                if (offerId && sale.created_at) {
                                    let monthsToAdd = 0;

                                    // Mapeamento de duração
                                    if (offerId === '0586b2f0-cda1-45ae-af6b-46a089e0a598') monthsToAdd = 12; // 1 Ano
                                    else if (offerId === '28d36658-7a03-465a-8ae4-daa705493526') monthsToAdd = 60; // 5 Anos
                                    else if (offerId === 'aebd4173-e860-4c16-ac72-1843574f0dd4') monthsToAdd = 6; // 6 Meses

                                    if (monthsToAdd > 0) {
                                        const purchaseDate = new Date(sale.created_at);
                                        const expirationDate = new Date(purchaseDate);
                                        expirationDate.setMonth(expirationDate.getMonth() + monthsToAdd);

                                        user.kiwifyOfferId = offerId;
                                        user.planExpirationDate = expirationDate;
                                        updated = true;
                                    }
                                }
                            }

                            if (updated) {
                                await this.userRepository.save(user);
                                this.logger.log(`Usuário ${user.email} sincronizado via Kiwify.`);
                            }
                        }
                    } catch (dbError) {
                        this.logger.error(`Erro ao sincronizar usuário ${customer.email} no banco`, dbError);
                    }

                    // Usar email como chave para unicidade map do retorno (visualização)
                    if (!uniqueUsersMap.has(customer.email)) {
                        uniqueUsersMap.set(customer.email, {
                            name: customer.name || 'Sem nome',
                            email: customer.email,
                            phone: customer.mobile || customer.phone || '',
                            lastPurchaseDate: sale.created_at,
                            product: sale.product ? sale.product.name : (sale.product_name || 'Produto Desconhecido'),
                            offer_id: sale.product ? sale.product.offer_id : '-',
                            offer_name: sale.product ? sale.product.offer_name : '-',
                            raw: sale
                        });
                    }
                }
            }

            const users = Array.from(uniqueUsersMap.values());
            this.logger.log(`${users.length} usuários únicos processados.`);

            return {
                count: users.length,
                users: users
            };

        } catch (error) {
            this.logger.error('Erro ao processar usuários Kiwify', error);
            if (error instanceof HttpException) throw error;
            throw new HttpException('Erro ao processar dados da Kiwify', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}
