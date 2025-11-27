import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { SupportService } from './support.service';
import { CreateFaqDto, UpdateFaqDto, CreateSupportItemDto, UpdateSupportItemDto } from '../presentation/dto/support.dto';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Express } from 'express';

const createImageUploadOptions = () => {
  return {
    storage: diskStorage({
      destination: (req, file, cb) => {
        const uploadPath = join(process.cwd(), 'uploads', 'support-items');
        if (!existsSync(uploadPath)) {
          mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const fileExt = extname(file.originalname) || '';
        cb(null, `${uniqueSuffix}${fileExt}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req: any, file: Express.Multer.File, cb: (error: any, acceptFile: boolean) => void) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new BadRequestException('Tipo de arquivo não permitido. Apenas imagens são aceitas.'), false);
      }
      cb(null, true);
    },
  };
};

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
  @Post('items/upload/image')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file', createImageUploadOptions()))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Nenhum arquivo foi enviado.');
    }
    return {
      path: `/uploads/support-items/${file.filename}`,
    };
  }

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




