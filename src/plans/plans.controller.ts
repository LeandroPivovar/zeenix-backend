import { Controller, Get, Post, Put, Delete, Body, UseGuards, Req, Param, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, IsObject } from 'class-validator';
import { PlansService } from './plans.service';

class ActivatePlanDto {
  @IsString()
  @IsNotEmpty()
  planId: string;
}

class CreatePlanDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsNumber()
  price: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  billingPeriod?: string;

  @IsObject()
  @IsOptional()
  features?: any;

  @IsBoolean()
  @IsOptional()
  isPopular?: boolean;

  @IsBoolean()
  @IsOptional()
  isRecommended?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsObject()
  @IsOptional()
  benefits?: any;

  @IsNumber()
  @IsOptional()
  displayOrder?: number;

  @IsString()
  @IsOptional()
  externalId?: string;
}

class UpdatePlanDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  slug?: string;

  @IsNumber()
  @IsOptional()
  price?: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  billingPeriod?: string;

  @IsObject()
  @IsOptional()
  features?: any;

  @IsBoolean()
  @IsOptional()
  isPopular?: boolean;

  @IsBoolean()
  @IsOptional()
  isRecommended?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsObject()
  @IsOptional()
  benefits?: any;

  @IsNumber()
  @IsOptional()
  displayOrder?: number;

  @IsString()
  @IsOptional()
  externalId?: string;
}

@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) { }

  @Get()
  async getAllPlans() {
    return await this.plansService.getAllPlans();
  }

  @Get('admin/all')
  @UseGuards(AuthGuard('jwt'))
  async getAllPlansAdmin(@Req() req: any) {
    // Verificar se é admin
    const user = req.user;
    if (user.role !== 'admin') {
      throw new ForbiddenException('Acesso negado. Apenas administradores podem acessar.');
    }
    return await this.plansService.getAllPlansAdmin();
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

  @Post()
  @UseGuards(AuthGuard('jwt'))
  async createPlan(@Req() req: any, @Body() body: CreatePlanDto) {
    // Verificar se é admin
    const user = req.user;
    if (user.role !== 'admin') {
      throw new ForbiddenException('Acesso negado. Apenas administradores podem criar planos.');
    }
    return await this.plansService.createPlan(body);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'))
  async updatePlan(@Req() req: any, @Param('id') id: string, @Body() body: UpdatePlanDto) {
    // Verificar se é admin
    const user = req.user;
    if (user.role !== 'admin') {
      throw new ForbiddenException('Acesso negado. Apenas administradores podem atualizar planos.');
    }
    return await this.plansService.updatePlan(id, body);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async deletePlan(@Req() req: any, @Param('id') id: string) {
    // Verificar se é admin
    const user = req.user;
    if (user.role !== 'admin') {
      throw new ForbiddenException('Acesso negado. Apenas administradores podem deletar planos.');
    }
    return await this.plansService.deletePlan(id);
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
