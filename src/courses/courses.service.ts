import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import type { CourseRepository } from '../domain/repositories/course.repository';
import { COURSE_REPOSITORY_TOKEN } from '../constants/tokens';
import { TypeOrmLessonRepository } from '../infrastructure/database/repositories/lesson.repository';
import { UserLessonProgressEntity } from '../infrastructure/database/entities/user-lesson-progress.entity';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CoursesService {
  constructor(
    @Inject(COURSE_REPOSITORY_TOKEN) private readonly courseRepository: CourseRepository,
    private readonly lessonRepository: TypeOrmLessonRepository,
    @InjectRepository(UserLessonProgressEntity)
    private readonly progressRepository: Repository<UserLessonProgressEntity>,
  ) {}

  async findAll() {
    const courses = await this.courseRepository.findAll();
    return courses.map(c => ({
      id: c.id,
      title: c.title,
      description: c.description,
      imagePlaceholder: c.imagePlaceholder,
      totalLessons: c.totalLessons,
      totalDuration: c.totalDuration,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async findOne(id: string) {
    const course = await this.courseRepository.findById(id);
    if (!course) throw new NotFoundException('Curso não encontrado');
    const modules = await this.lessonRepository.findModulesByCourseId(id);
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      imagePlaceholder: course.imagePlaceholder,
      totalLessons: course.totalLessons,
      totalDuration: course.totalDuration,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      modules: modules.map(m => ({
        id: m.id,
        title: m.title,
        orderIndex: m.orderIndex,
        lessons: m.lessons.map(l => ({
          id: l.id,
          courseId: l.courseId,
          moduleId: l.moduleId,
          title: l.title,
          description: l.description,
          duration: l.duration,
          videoUrl: l.videoUrl,
          orderIndex: l.orderIndex,
          createdAt: l.createdAt,
          updatedAt: l.updatedAt,
        })),
      })),
    };
  }

  async markLessonAsCompleted(userId: string, lessonId: string): Promise<void> {
    const existing = await this.progressRepository.findOne({
      where: { userId, lessonId },
    });

    if (existing) {
      existing.completed = true;
      existing.completedAt = new Date();
      await this.progressRepository.save(existing);
    } else {
      const progress = this.progressRepository.create({
        id: uuidv4(),
        userId,
        lessonId,
        completed: true,
        completedAt: new Date(),
      });
      await this.progressRepository.save(progress);
    }
  }

  async getProgressForCourse(userId: string, courseId: string): Promise<Record<string, boolean>> {
    // Buscar todas as aulas do curso
    const lessons = await this.lessonRepository.findByCourseId(courseId);
    const lessonIds = lessons.map(l => l.id);

    if (lessonIds.length === 0) return {};

    // Buscar progresso do usuário para essas aulas
    const progress = await this.progressRepository.find({
      where: {
        userId,
        lessonId: In(lessonIds),
        completed: true,
      },
    });

    const progressMap: Record<string, boolean> = {};
    lessonIds.forEach(id => {
      progressMap[id] = progress.some(p => p.lessonId === id);
    });

    return progressMap;
  }
}

