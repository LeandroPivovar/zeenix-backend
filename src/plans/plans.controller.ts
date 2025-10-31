import { Controller, Get, Put, Body, UseGuards, Req, Param } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsNotEmpty } from 'class-validator';
import { PlansService } from './plans.service';

class ActivatePlanDto {
  @IsString()
  @IsNotEmpty()
  planId: string;
}

@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  async getAllPlans() {
    return await this.plansService.getAllPlans();
  }

  @Get(':id')
  async getPlanById(@Param('id') id: string) {
    return await this.plansService.getPlanById(id);
  }

  @Get('user/current')
  @UseGuards(AuthGuard('jwt'))
  async getUserPlan(@Req() req: any) {
    const userId = req.user.userId;
    return await this.plansService.getUserPlan(userId);
  }

  @Put('activate')
  @UseGuards(AuthGuard('jwt'))
  async activatePlan(@Req() req: any, @Body() body: ActivatePlanDto) {
    const userId = req.user.userId;
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    return await this.plansService.activatePlan(userId, body.planId, ipAddress, userAgent);
  }
}

