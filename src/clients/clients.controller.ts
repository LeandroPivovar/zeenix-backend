import { Controller, Get, Patch, Query, Body, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ClientsService } from './clients.service';
import { ClientMetricsDto } from './dto/client-metrics.dto';
import { ClientListResponseDto } from './dto/client-list.dto';

@Controller('clients')
@UseGuards(AuthGuard('jwt'))
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) { }

  @Get('metrics')
  async getMetrics(): Promise<ClientMetricsDto> {
    return this.clientsService.getMetrics();
  }

  @Get('list')
  async getClients(
    @Query('search') search?: string,
    @Query('balanceFilter') balanceFilter?: string,
    @Query('onlyRealAccount') onlyRealAccount?: string,
    @Query('minBalance') minBalance?: string,
    @Query('maxBalance') maxBalance?: string,
    @Query('noRealBalance') noRealBalance?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
    @Query('activityPeriod') activityPeriod?: string,
  ): Promise<ClientListResponseDto> {
    return this.clientsService.getClients(
      search,
      balanceFilter,
      onlyRealAccount === 'true',
      minBalance ? parseFloat(minBalance) : undefined,
      maxBalance ? parseFloat(maxBalance) : undefined,
      noRealBalance === 'true',
      sortBy,
      sortOrder,
      activityPeriod,
    );
  }

  @Get('export')
  async exportClients(): Promise<any[]> {
    return this.clientsService.exportClients();
  }

  @Patch(':userId/role')
  async updateUserRole(
    @Param('userId') userId: string,
    @Body('role') role: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.clientsService.updateUserRole(userId, role);
  }
}

