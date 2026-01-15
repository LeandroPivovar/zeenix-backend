import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from '../services/admin.service';

@Controller('admin')
@UseGuards(AuthGuard('jwt'))
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  async getAdminStats() {
    return this.adminService.getAdminStatistics();
  }

  @Get('users/non-demo')
  async getNonDemoUsers() {
    return this.adminService.getNonDemoUsers();
  }

  @Get('managed-volume')
  async getManagedVolume() {
    return this.adminService.getManagedVolume();
  }

  @Get('administrators')
  async getAdministrators() {
    return this.adminService.getAdministrators();
  }

  @Post('administrators')
  async createAdministrator(@Body() data: any) {
    return this.adminService.createAdministrator(data);
  }

  @Put('administrators/:id')
  async updateAdministrator(@Param('id') id: string, @Body() data: any) {
    return this.adminService.updateAdministrator(id, data);
  }

  @Put('administrators/:id/toggle-status')
  async toggleAdministratorStatus(@Param('id') id: string) {
    return this.adminService.toggleAdministratorStatus(id);
  }

  @Delete('administrators/:id')
  async deleteAdministrator(@Param('id') id: string) {
    return this.adminService.deleteAdministrator(id);
  }

  @Get('activity-logs')
  async getActivityLogs(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    return this.adminService.getActivityLogs(pageNum, limitNum);
  }
}
