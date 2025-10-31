import { Controller, Get, Query } from '@nestjs/common';
import { SupportService } from './support.service';

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get('faqs')
  async getFaqs(@Query('search') search?: string) {
    return await this.supportService.findAllFaqs(search);
  }

  @Get('status')
  async getSystemStatus() {
    return await this.supportService.getSystemStatus();
  }
}

