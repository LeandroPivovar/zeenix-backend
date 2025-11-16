import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { ClientsService } from './clients.service';
import { ClientMetricsDto } from './dto/client-metrics.dto';
import { ClientListResponseDto } from './dto/client-list.dto';

@Controller('clients')
@UseGuards(JwtAuthGuard)
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get('metrics')
  async getMetrics(): Promise<ClientMetricsDto> {
    return this.clientsService.getMetrics();
  }

  @Get('list')
  async getClients(
    @Query('search') search?: string,
    @Query('balanceFilter') balanceFilter?: string,
  ): Promise<ClientListResponseDto> {
    return this.clientsService.getClients(search, balanceFilter);
  }

  @Get('export')
  async exportClients(): Promise<any[]> {
    return this.clientsService.exportClients();
  }
}

