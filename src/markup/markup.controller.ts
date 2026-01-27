import {
    Controller,
    Get,
    Query,
    Req,
    UseGuards,
    Logger,
    BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MarkupService } from './markup.service';
import { Inject } from '@nestjs/common';
import { USER_REPOSITORY_TOKEN } from '../constants/tokens';
import type { UserRepository } from '../domain/repositories/user.repository';

@Controller('markup')
@UseGuards(AuthGuard('jwt'))
export class MarkupController {
    private readonly logger = new Logger(MarkupController.name);

    constructor(
        private readonly markupService: MarkupService,
        @Inject(USER_REPOSITORY_TOKEN)
        private readonly userRepository: UserRepository,
    ) { }

    /**
     * GET /markup/statistics
     * 
     * Retorna estatísticas de markup da Deriv para o período especificado
     * 
     * @param userId - ID do usuário para buscar markup
     * @param dateFrom - Data de início (formato YYYY-MM-DD)
     * @param dateTo - Data de fim (formato YYYY-MM-DD)
     * @param req - Request object contendo informações do usuário autenticado
     * @returns Estatísticas de markup incluindo total em USD e contagem de transações
     */
    @Get('statistics')
    async getMarkupStatistics(
        @Query('userId') userId: string,
        @Query('dateFrom') dateFrom: string,
        @Query('dateTo') dateTo: string,
        @Req() req: any,
    ) {
        // Validar parâmetros
        if (!userId) {
            throw new BadRequestException('Parâmetro userId é obrigatório');
        }

        if (!dateFrom || !dateTo) {
            throw new BadRequestException(
                'Parâmetros dateFrom e dateTo são obrigatórios',
            );
        }

        // Validar formato de data (YYYY-MM-DD)
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateFrom) || !dateRegex.test(dateTo)) {
            throw new BadRequestException(
                'Formato de data inválido. Use YYYY-MM-DD',
            );
        }

        this.logger.log(
            `[MarkupController] Buscando estatísticas de markup para usuário ${userId} - Período: ${dateFrom} a ${dateTo}`,
        );

        try {
            // Buscar token do usuário no banco de dados
            const derivInfo = await this.userRepository.getDerivInfo(userId);

            if (!derivInfo) {
                throw new BadRequestException(
                    'Usuário não possui conta Deriv conectada',
                );
            }

            // Tentar usar tokenReal primeiro, depois tokenDemo
            const token = derivInfo.tokenReal || derivInfo.tokenDemo;

            if (!token) {
                throw new BadRequestException(
                    'Token Deriv não encontrado. Por favor, reconecte sua conta Deriv.',
                );
            }

            // Converter formato de data para o formato esperado pela API Deriv
            // A API aceita tanto YYYY-MM-DD quanto YYYY-MM-DD HH:MM:SS
            const dateFromFormatted = `${dateFrom} 00:00:00`;
            const dateToFormatted = `${dateTo} 23:59:59`;

            // Chamar serviço de markup
            const statistics = await this.markupService.getAppMarkupStatistics(
                token,
                {
                    date_from: dateFromFormatted,
                    date_to: dateToFormatted,
                },
            );

            this.logger.log(
                `[MarkupController] Estatísticas obtidas com sucesso - Total: $${statistics.total_app_markup_usd}`,
            );

            return {
                success: true,
                data: statistics,
            };
        } catch (error) {
            this.logger.error(
                `[MarkupController] Erro ao buscar estatísticas: ${error.message}`,
            );
            throw error;
        }
    }
}
