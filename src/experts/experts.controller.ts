import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExpertsService } from './experts.service';

@Controller('experts')
export class ExpertsController {
  constructor(private readonly expertsService: ExpertsService) {}

  @Get()
  async findAll() {
    return this.expertsService.findAll();
  }

  @Get('stats/summary')
  async getSummaryStats() {
    return this.expertsService.getSummaryStats();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.expertsService.findById(id);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  async create(@Body() data: any) {
    return this.expertsService.create(data);
  }

  @Put(':id/toggle-status')
  @UseGuards(AuthGuard('jwt'))
  async toggleStatus(@Param('id') id: string) {
    return this.expertsService.toggleStatus(id);
  }

  @Put(':id/toggle-verified')
  @UseGuards(AuthGuard('jwt'))
  async toggleVerified(@Param('id') id: string) {
    return this.expertsService.toggleVerified(id);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'))
  async update(@Param('id') id: string, @Body() data: any) {
    return this.expertsService.update(id, data);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async delete(@Param('id') id: string) {
    return this.expertsService.delete(id);
  }
}
