import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { SupportService } from './support.service';
import { CreateFaqDto, UpdateFaqDto, CreateSupportItemDto, UpdateSupportItemDto } from '../presentation/dto/support.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get('faqs')
  async getFaqs(@Query('search') search?: string) {
    return await this.supportService.findAllFaqs(search);
  }

  @Get('faqs/:id')
  async getFaqById(@Param('id') id: string) {
    return await this.supportService.findFaqById(id);
  }

  @Post('faqs')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.CREATED)
  async createFaq(@Body() createFaqDto: CreateFaqDto) {
    return await this.supportService.createFaq(createFaqDto);
  }

  @Put('faqs/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateFaq(@Param('id') id: string, @Body() updateFaqDto: UpdateFaqDto) {
    return await this.supportService.updateFaq(id, updateFaqDto);
  }

  @Delete('faqs/:id')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFaq(@Param('id') id: string) {
    await this.supportService.deleteFaq(id);
  }

  @Get('status')
  async getSystemStatus() {
    return await this.supportService.getSystemStatus();
  }

  // ========== Support Items Endpoints ==========
  @Get('items')
  async getSupportItems() {
    return await this.supportService.findAllSupportItems();
  }

  @Get('items/:id')
  async getSupportItemById(@Param('id') id: string) {
    return await this.supportService.findSupportItemById(id);
  }

  @Post('items')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.CREATED)
  async createSupportItem(@Body() createSupportItemDto: CreateSupportItemDto) {
    return await this.supportService.createSupportItem(createSupportItemDto);
  }

  @Put('items/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateSupportItem(@Param('id') id: string, @Body() updateSupportItemDto: UpdateSupportItemDto) {
    return await this.supportService.updateSupportItem(id, updateSupportItemDto);
  }

  @Delete('items/:id')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSupportItem(@Param('id') id: string) {
    await this.supportService.deleteSupportItem(id);
  }
}




