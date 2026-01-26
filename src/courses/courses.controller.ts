import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import { CreateMaterialDto } from './dto/create-material.dto';
import { UpdateMaterialDto } from './dto/update-material.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Express } from 'express';

const createMediaUploadOptions = (
  relativePath: string[],
  allowedMimePrefixes: string[],
  maxFileSizeMb = 50,
) => {
  return {
    storage: diskStorage({
      destination: (req, file, cb) => {
        const uploadPath = join(process.cwd(), 'uploads', ...relativePath);
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
    limits: { fileSize: maxFileSizeMb * 1024 * 1024 },
    fileFilter: (req: any, file: Express.Multer.File, cb: (error: any, acceptFile: boolean) => void) => {
      if (!allowedMimePrefixes.some(prefix => file.mimetype.startsWith(prefix))) {
        return cb(new BadRequestException('Tipo de arquivo não permitido.'), false);
      }
      cb(null, true);
    },
  };
};

const createImageUploadOptions = (subfolder: string) =>
  createMediaUploadOptions(['courses', subfolder], ['image/'], 10);

const createVideoUploadOptions = () => createMediaUploadOptions(['lessons', 'videos'], ['video/'], 1024);

const createMaterialUploadOptions = () => createMediaUploadOptions(
  ['lessons', 'materials'],
  ['application/', 'text/', 'image/'],
  50
);

@Controller('courses')
export class CoursesController {
  constructor(
    private readonly coursesService: CoursesService,
    private readonly jwtService: JwtService,
  ) { }

  @Post('upload/cover')
  @UseInterceptors(FileInterceptor('file', createImageUploadOptions('covers')))
  uploadCoverImage(@UploadedFile() file: Express.Multer.File) {
    return this.handleUploadedFile(file, ['courses', 'covers']);
  }

  @Post('upload/social')
  @UseInterceptors(FileInterceptor('file', createImageUploadOptions('social')))
  uploadSocialImage(@UploadedFile() file: Express.Multer.File) {
    return this.handleUploadedFile(file, ['courses', 'social']);
  }

  @Post('lessons/upload/video')
  @UseInterceptors(FileInterceptor('file', createVideoUploadOptions()))
  uploadLessonVideo(@UploadedFile() file: Express.Multer.File) {
    return this.handleUploadedFile(file, ['lessons', 'videos']);
  }

  @Post('lessons/upload/material')
  @UseInterceptors(FileInterceptor('file', createMaterialUploadOptions()))
  uploadMaterial(@UploadedFile() file: Express.Multer.File) {
    return this.handleUploadedFile(file, ['lessons', 'materials']);
  }

  // Deriv Tutorial
  @Get('deriv-tutorial-video')
  getDerivTutorialVideo() {
    return this.coursesService.getDerivTutorialVideo();
  }

  // Courses CRUD
  @Get()
  findAll() {
    return this.coursesService.findAll();
  }

  // Modules CRUD - rotas específicas antes das genéricas
  @Get(':courseId/modules')
  findModulesByCourse(@Param('courseId') courseId: string) {
    return this.coursesService.findModulesByCourse(courseId);
  }

  // Lessons CRUD - rotas específicas antes das genéricas
  @Get('modules/:moduleId/lessons')
  findLessonsByModule(@Param('moduleId') moduleId: string) {
    return this.coursesService.findLessonsByModule(moduleId);
  }

  // Materials CRUD - rotas específicas antes das genéricas
  @Get('lessons/:lessonId/materials')
  findMaterialsByLesson(@Param('lessonId') lessonId: string) {
    return this.coursesService.findMaterialsByLesson(lessonId);
  }

  // Progress - rota específica antes das genéricas
  @Post(':courseId/lessons/:lessonId/complete')
  @UseGuards(AuthGuard('jwt'))
  async markLessonAsCompleted(
    @Param('courseId') courseId: string,
    @Param('lessonId') lessonId: string,
    @Req() req: any,
  ) {
    await this.coursesService.markLessonAsCompleted(req.user.userId, lessonId);
    return { success: true, message: 'Aula marcada como concluída' };
  }

  @Delete(':courseId/lessons/:lessonId/complete')
  @UseGuards(AuthGuard('jwt'))
  async markLessonAsIncomplete(
    @Param('courseId') courseId: string,
    @Param('lessonId') lessonId: string,
    @Req() req: any,
  ) {
    await this.coursesService.markLessonAsIncomplete(req.user.userId, lessonId);
    return { success: true, message: 'Conclusão da aula removida' };
  }

  // Rota genérica de curso deve vir por último
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const course = await this.coursesService.findOne(id);

    // Se houver token no header, tentar extrair userId e buscar progresso
    try {
      const authHeader = req.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const payload = this.jwtService.decode(token) as { sub: string; email: string } | null;
        if (payload?.sub) {
          const progress = await this.coursesService.getProgressForCourse(payload.sub, id);
          // Adicionar informação de progresso às aulas
          if (course.modules) {
            course.modules.forEach(module => {
              if (module.lessons) {
                module.lessons.forEach((lesson: any) => {
                  lesson.completed = progress[lesson.id] || false;
                });
              }
            });
          }
        }
      }
    } catch (err) {
      // Se houver erro na autenticação, continua sem progresso
      console.warn('Erro ao buscar progresso:', err);
    }

    return course;
  }

  @Post()
  create(@Body() createCourseDto: CreateCourseDto) {
    return this.coursesService.create(createCourseDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateCourseDto: UpdateCourseDto) {
    return this.coursesService.update(id, updateCourseDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.coursesService.remove(id);
  }

  @Put('reorder/all')
  @UseGuards(AuthGuard('jwt'))
  reorderCourses(@Body() body: { orders: { id: string; orderIndex: number }[] }) {
    return this.coursesService.reorderCourses(body.orders);
  }

  // Modules CRUD
  @Post('modules')
  createModule(@Body() createModuleDto: CreateModuleDto) {
    return this.coursesService.createModule(createModuleDto);
  }

  @Put('modules/:id')
  updateModule(@Param('id') id: string, @Body() updateModuleDto: UpdateModuleDto) {
    return this.coursesService.updateModule(id, updateModuleDto);
  }

  @Delete('modules/:id')
  removeModule(@Param('id') id: string) {
    return this.coursesService.removeModule(id);
  }

  // Lessons CRUD
  @Post('lessons')
  createLesson(@Body() createLessonDto: CreateLessonDto) {
    return this.coursesService.createLesson(createLessonDto);
  }

  @Put('lessons/:id')
  updateLesson(@Param('id') id: string, @Body() updateLessonDto: UpdateLessonDto) {
    return this.coursesService.updateLesson(id, updateLessonDto);
  }

  @Delete('lessons/:id')
  removeLesson(@Param('id') id: string) {
    return this.coursesService.removeLesson(id);
  }

  // Materials CRUD
  @Post('materials')
  createMaterial(@Body() createMaterialDto: CreateMaterialDto) {
    return this.coursesService.createMaterial(createMaterialDto);
  }

  @Put('materials/:id')
  updateMaterial(@Param('id') id: string, @Body() updateMaterialDto: UpdateMaterialDto) {
    return this.coursesService.updateMaterial(id, updateMaterialDto);
  }

  @Delete('materials/:id')
  removeMaterial(@Param('id') id: string) {
    return this.coursesService.removeMaterial(id);
  }

  private handleUploadedFile(file: Express.Multer.File, relativePath: string[]) {
    if (!file) {
      throw new BadRequestException('Nenhum arquivo foi enviado.');
    }
    return {
      path: `/uploads/${relativePath.join('/')}/${file.filename}`,
    };
  }
}

