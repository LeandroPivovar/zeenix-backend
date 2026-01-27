import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EmailService } from '../auth/email.service';

@Injectable()
export class DailySummaryService {
    private readonly logger = new Logger(DailySummaryService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly emailService: EmailService,
    ) { }

    /**
     * Dispara o envio de relatórios diários
     * Agendado para meia-noite (00:00)
     */
    @Cron('*/2 * * * *')
    async handleDailySummary() {
        this.logger.log('[DailySummary] TESTE: Iniciando processamento a cada 2 minutos (dados de hoje)...');

        // Período: dia anterior completo (00:00:00 às 23:59:59)
        // TESTE: Usando data de hoje para o ciclo curto de teste
        const yesterday = new Date();
        // yesterday.setDate(yesterday.getDate() - 1);

        // Configurar para o fuso America/Sao_Paulo (UTC-3 geralmente)
        // Para simplificar e garantir precisão, vamos usar o início e fim do dia no calendário local
        const startOfDay = new Date(yesterday);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(yesterday);
        endOfDay.setHours(23, 59, 59, 999);

        this.logger.log(`[DailySummary] Período de análise: ${startOfDay.toISOString()} até ${endOfDay.toISOString()}`);

        let offset = 0;
        const limit = 50;

        try {
            while (true) {
                // Buscar usuários que optaram por receber notificações
                const users = await this.dataSource.query(
                    `SELECT u.id, u.name, u.email 
           FROM users u
           JOIN user_settings s ON u.id = s.user_id
           WHERE s.email_notifications = true
           LIMIT ? OFFSET ?`,
                    [limit, offset],
                );

                if (!users || users.length === 0) break;

                this.logger.log(`[DailySummary] Processando lote de ${users.length} usuários (offset: ${offset})...`);

                const summaryPromises = users.map(async (user) => {
                    try {
                        const stats = await this.getUserStats(user.id, startOfDay, endOfDay);

                        // Apenas enviar se houver atividade no dia
                        if (stats.totalTrades > 0) {
                            await this.emailService.sendDailySummary(user.email, user.name, stats);
                            this.logger.debug(`[DailySummary] Resumo enviado com sucesso para ${user.email}`);
                        }
                    } catch (error) {
                        this.logger.error(`[DailySummary] Erro ao processar resumo para usuário ${user.id}: ${error.message}`);
                    }
                });

                // Aguardar o lote atual antes de prosseguir para evitar sobrecarga do servidor SMTP ou memória
                await Promise.allSettled(summaryPromises);

                offset += limit;
                if (users.length < limit) break;
            }

            this.logger.log('[DailySummary] Processamento de resumos diários concluído com sucesso.');
        } catch (error) {
            this.logger.error(`[DailySummary] Erro fatal no processamento: ${error.message}`, error.stack);
        }
    }

    /**
     * Calcula agregados de trades da IA e do Agente Autônomo
     */
    private async getUserStats(userId: string, start: Date, end: Date) {
        const queries = [
            this.dataSource.query(
                `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status IN ('WON', 'won') THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status IN ('LOST', 'lost') THEN 1 ELSE 0 END) as losses,
          SUM(COALESCE(profit_loss, 0)) as netProfit
         FROM ai_trades
         WHERE user_id = ? AND created_at BETWEEN ? AND ?`,
                [userId, start, end],
            ),
            this.dataSource.query(
                `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status IN ('WON', 'won') THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status IN ('LOST', 'lost') THEN 1 ELSE 0 END) as losses,
          SUM(COALESCE(profit_loss, 0)) as netProfit
         FROM autonomous_agent_trades
         WHERE user_id = ? AND created_at BETWEEN ? AND ?`,
                [userId, start, end],
            ),
        ];

        const [aiResult, agentResult] = await Promise.all(queries);

        const totalTrades = (parseInt(aiResult[0]?.total) || 0) + (parseInt(agentResult[0]?.total) || 0);
        const wins = (parseInt(aiResult[0]?.wins) || 0) + (parseInt(agentResult[0]?.wins) || 0);
        const losses = (parseInt(aiResult[0]?.losses) || 0) + (parseInt(agentResult[0]?.losses) || 0);
        const netProfit = (parseFloat(aiResult[0]?.netProfit) || 0) + (parseFloat(agentResult[0]?.netProfit) || 0);

        return { totalTrades, wins, losses, netProfit };
    }

    /**
     * Dispara o envio de e-mail de teste para um usuário específico usando dados de hoje
     */
    async triggerManualSummary(userId: string) {
        this.logger.log(`[DailySummary] Disparando resumo manual (teste) para o usuário ${userId}...`);

        const user = await this.dataSource.query(
            `SELECT u.name, u.email FROM users u WHERE u.id = ?`,
            [userId]
        );

        if (!user || user.length === 0) {
            throw new Error('Usuário não encontrado');
        }

        // Usar data de hoje para o teste manual imediato
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        const stats = await this.getUserStats(userId, startOfDay, endOfDay);

        // Para teste manual, enviar mesmo se não houver trades (ou avisar se preferir)
        // Vamos enviar para mostrar o template funcionando
        await this.emailService.sendDailySummary(user[0].email, user[0].name, stats);

        return {
            success: true,
            message: `Resumo manual enviado para ${user[0].email}`,
            stats
        };
    }
}
