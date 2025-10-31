import { Controller, Get, Param, Post, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { CoursesService } from './courses.service';

@Controller('courses')
export class CoursesController {
  constructor(
    private readonly coursesService: CoursesService,
    private readonly jwtService: JwtService,
  ) {}

  @Get()
  findAll() {
    return this.coursesService.findAll();
  }

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
                module.lessons.forEach(lesson => {
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
}

