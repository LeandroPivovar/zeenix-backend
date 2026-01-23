import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import type { CourseRepository } from '../domain/repositories/course.repository';
import { COURSE_REPOSITORY_TOKEN } from '../constants/tokens';
import { TypeOrmLessonRepository } from '../infrastructure/database/repositories/lesson.repository';
import { UserLessonProgressEntity } from '../infrastructure/database/entities/user-lesson-progress.entity';
import { CourseEntity } from '../infrastructure/database/entities/course.entity';
import { ModuleEntity } from '../infrastructure/database/entities/module.entity';
import { LessonEntity } from '../infrastructure/database/entities/lesson.entity';
import { MaterialEntity } from '../infrastructure/database/entities/material.entity';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import { CreateMaterialDto } from './dto/create-material.dto';
import { UpdateMaterialDto } from './dto/update-material.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CoursesService {
  constructor(
    @Inject(COURSE_REPOSITORY_TOKEN) private readonly courseRepository: CourseRepository,
    private readonly lessonRepository: TypeOrmLessonRepository,
    @InjectRepository(UserLessonProgressEntity)
    private readonly progressRepository: Repository<UserLessonProgressEntity>,
    @InjectRepository(CourseEntity)
    private readonly courseEntityRepository: Repository<CourseEntity>,
    @InjectRepository(ModuleEntity)
    private readonly moduleRepository: Repository<ModuleEntity>,
    @InjectRepository(LessonEntity)
    private readonly lessonEntityRepository: Repository<LessonEntity>,
    @InjectRepository(MaterialEntity)
    private readonly materialRepository: Repository<MaterialEntity>,
  ) { }

  private normalizeMediaPath(path?: string | null): string | null {
    if (!path) {
      return null;
    }
    const trimmed = path.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private parseLessonDuration(duration?: string | null): number {
    if (!duration) {
      return 0;
    }
    const match = duration.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private formatTotalDuration(totalMinutes: number): string {
    if (!totalMinutes || totalMinutes <= 0) {
      return '0 min';
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) {
      return `${hours}h ${minutes}min`;
    }
    if (hours) {
      return `${hours}h`;
    }
    return `${minutes} min`;
  }

  async findAll() {
    const courses = await this.courseEntityRepository.find({
      order: { createdAt: 'DESC' },
    });
    let lessonCountMap: Record<string, number> = {};
    let lessonDurationMap: Record<string, number> = {};
    if (courses.length) {
      const lessonCounts = await this.lessonEntityRepository
        .createQueryBuilder('lesson')
        .select('lesson.course_id', 'courseId')
        .addSelect('COUNT(*)', 'count')
        .where('lesson.course_id IN (:...ids)', { ids: courses.map(c => c.id) })
        .groupBy('lesson.course_id')
        .getRawMany<{ courseId: string; count: string }>();
      lessonCountMap = lessonCounts.reduce((acc, row) => {
        acc[row.courseId] = Number(row.count);
        return acc;
      }, {} as Record<string, number>);

      const lessons = await this.lessonEntityRepository
        .createQueryBuilder('lesson')
        .select('lesson.course_id', 'courseId')
        .addSelect('lesson.duration', 'duration')
        .where('lesson.course_id IN (:...ids)', { ids: courses.map(c => c.id) })
        .getRawMany<{ courseId: string; duration: string }>();
      lessonDurationMap = lessons.reduce((acc, lesson) => {
        const current = acc[lesson.courseId] || 0;
        acc[lesson.courseId] = current + this.parseLessonDuration(lesson.duration);
        return acc;
      }, {} as Record<string, number>);
    }
    return courses.map(c => ({
      id: c.id,
      name: c.title,
      title: c.title,
      description: c.description,
      imagePlaceholder: c.imagePlaceholder,
      coverImage: c.coverImage,
      slug: c.slug,
      seoTitle: c.seoTitle,
      seoDescription: c.seoDescription,
      keywords: c.keywords || [],
      socialImage: c.socialImage,
      access: c.access,
      price: c.price,
      currency: c.currency,
      subscription: c.subscription,
      discount: c.discount,
      status: c.status,
      availableFrom: c.availableFrom,
      availableUntil: c.availableUntil,
      visibility: c.visibility,
      totalLessons: lessonCountMap[c.id] || 0,
      totalDuration: this.formatTotalDuration(lessonDurationMap[c.id] || 0),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async findOne(id: string) {
    const course = await this.courseEntityRepository.findOne({ where: { id } });
    if (!course) throw new NotFoundException('Curso não encontrado');

    const modules = await this.moduleRepository.find({
      where: { courseId: id },
      order: { orderIndex: 'ASC' },
    });

    const lessons = await this.lessonEntityRepository.find({
      where: { courseId: id },
      order: { orderIndex: 'ASC' },
    });

    const modulesWithLessons = modules.map(m => ({
      id: m.id,
      courseId: m.courseId,
      title: m.title,
      shortDescription: m.shortDescription,
      status: m.status,
      orderIndex: m.orderIndex,
      lessons: lessons
        .filter(l => l.moduleId === m.id)
        .map(l => ({
          id: l.id,
          courseId: l.courseId,
          moduleId: l.moduleId,
          name: l.title,
          title: l.title,
          description: l.description,
          contentType: l.contentType,
          contentLink: l.contentLink,
          releaseType: l.releaseType,
          releaseDate: l.releaseDate,
          isActive: l.isActive,
          duration: l.duration,
          videoUrl: l.videoUrl,
          orderIndex: l.orderIndex,
          createdAt: l.createdAt,
          updatedAt: l.updatedAt,
        })),
    }));

    const totalLessonsCount = modulesWithLessons.reduce((acc, module) => {
      return acc + (module.lessons?.length || 0);
    }, 0);

    const totalDurationMinutes = modulesWithLessons.reduce((courseAcc, module) => {
      return (
        courseAcc +
        (module.lessons || []).reduce((moduleAcc, lesson) => {
          return moduleAcc + this.parseLessonDuration(lesson.duration);
        }, 0)
      );
    }, 0);

    return {
      id: course.id,
      name: course.title,
      title: course.title,
      description: course.description,
      imagePlaceholder: course.imagePlaceholder,
      coverImage: course.coverImage,
      slug: course.slug,
      seoTitle: course.seoTitle,
      seoDescription: course.seoDescription,
      keywords: course.keywords || [],
      socialImage: course.socialImage,
      access: course.access,
      price: course.price,
      currency: course.currency,
      subscription: course.subscription,
      discount: course.discount,
      status: course.status,
      availableFrom: course.availableFrom,
      availableUntil: course.availableUntil,
      visibility: course.visibility,
      totalLessons: totalLessonsCount,
      totalDuration: this.formatTotalDuration(totalDurationMinutes),
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      modules: modulesWithLessons,
    };
  }

  // CRUD Courses
  async create(createCourseDto: CreateCourseDto) {
    const course = this.courseEntityRepository.create({
      id: uuidv4(),
      ...createCourseDto,
      title: createCourseDto.title,
      availableFrom: createCourseDto.availableFrom ? new Date(createCourseDto.availableFrom) : null,
      availableUntil: createCourseDto.availableUntil ? new Date(createCourseDto.availableUntil) : null,
      coverImage: this.normalizeMediaPath(createCourseDto.coverImage),
      socialImage: this.normalizeMediaPath(createCourseDto.socialImage),
      totalLessons: 0,
      totalDuration: '0 min',
    });
    return await this.courseEntityRepository.save(course);
  }

  async update(id: string, updateCourseDto: UpdateCourseDto) {
    const course = await this.courseEntityRepository.findOne({ where: { id } });
    if (!course) throw new NotFoundException('Curso não encontrado');

    const updateData: any = { ...updateCourseDto };
    if (updateCourseDto.availableFrom) {
      updateData.availableFrom = new Date(updateCourseDto.availableFrom);
    }
    if (updateCourseDto.availableUntil) {
      updateData.availableUntil = new Date(updateCourseDto.availableUntil);
    }
    if (updateCourseDto.coverImage !== undefined && updateCourseDto.coverImage !== null) {
      updateData.coverImage = this.normalizeMediaPath(updateCourseDto.coverImage);
    } else if (updateCourseDto.coverImage === null || updateCourseDto.coverImage === '') {
      updateData.coverImage = null;
    }
    if (updateCourseDto.socialImage !== undefined && updateCourseDto.socialImage !== null) {
      updateData.socialImage = this.normalizeMediaPath(updateCourseDto.socialImage);
    } else if (updateCourseDto.socialImage === null || updateCourseDto.socialImage === '') {
      updateData.socialImage = null;
    }

    Object.assign(course, updateData);
    return await this.courseEntityRepository.save(course);
  }

  async remove(id: string) {
    const course = await this.courseEntityRepository.findOne({ where: { id } });
    if (!course) throw new NotFoundException('Curso não encontrado');
    await this.courseEntityRepository.remove(course);
    return { success: true, message: 'Curso removido com sucesso' };
  }

  // CRUD Modules
  async createModule(createModuleDto: CreateModuleDto) {
    const module = this.moduleRepository.create({
      id: uuidv4(),
      ...createModuleDto,
    });
    return await this.moduleRepository.save(module);
  }

  async updateModule(id: string, updateModuleDto: UpdateModuleDto) {
    const module = await this.moduleRepository.findOne({ where: { id } });
    if (!module) throw new NotFoundException('Módulo não encontrado');
    Object.assign(module, updateModuleDto);
    return await this.moduleRepository.save(module);
  }

  async removeModule(id: string) {
    const module = await this.moduleRepository.findOne({ where: { id } });
    if (!module) throw new NotFoundException('Módulo não encontrado');
    await this.moduleRepository.remove(module);
    return { success: true, message: 'Módulo removido com sucesso' };
  }

  async findModulesByCourse(courseId: string) {
    return await this.moduleRepository.find({
      where: { courseId },
      order: { orderIndex: 'ASC' },
    });
  }

  // CRUD Lessons
  async createLesson(createLessonDto: CreateLessonDto) {
    const lesson = this.lessonEntityRepository.create({
      id: uuidv4(),
      ...createLessonDto,
      releaseDate: createLessonDto.releaseDate ? new Date(createLessonDto.releaseDate) : null,
      videoUrl: this.normalizeMediaPath(createLessonDto.videoUrl),
      contentLink: this.normalizeMediaPath(createLessonDto.contentLink),
    });
    return await this.lessonEntityRepository.save(lesson);
  }

  async updateLesson(id: string, updateLessonDto: UpdateLessonDto) {
    const lesson = await this.lessonEntityRepository.findOne({ where: { id } });
    if (!lesson) throw new NotFoundException('Aula não encontrada');

    const updateData: any = { ...updateLessonDto };
    if (updateLessonDto.releaseDate) {
      updateData.releaseDate = new Date(updateLessonDto.releaseDate);
    }
    if (updateLessonDto.videoUrl !== undefined) {
      updateData.videoUrl = this.normalizeMediaPath(updateLessonDto.videoUrl);
    }
    if (updateLessonDto.contentLink !== undefined) {
      updateData.contentLink = this.normalizeMediaPath(updateLessonDto.contentLink);
    }

    Object.assign(lesson, updateData);
    return await this.lessonEntityRepository.save(lesson);
  }

  async removeLesson(id: string) {
    const lesson = await this.lessonEntityRepository.findOne({ where: { id } });
    if (!lesson) throw new NotFoundException('Aula não encontrada');
    await this.lessonEntityRepository.remove(lesson);
    return { success: true, message: 'Aula removida com sucesso' };
  }

  async findLessonsByModule(moduleId: string) {
    return await this.lessonEntityRepository.find({
      where: { moduleId },
      order: { orderIndex: 'ASC' },
    });
  }

  // CRUD Materials
  async createMaterial(createMaterialDto: CreateMaterialDto) {
    const material = this.materialRepository.create({
      id: uuidv4(),
      ...createMaterialDto,
      filePath: this.normalizeMediaPath(createMaterialDto.filePath),
      link: this.normalizeMediaPath(createMaterialDto.link) || '',
    });
    return await this.materialRepository.save(material);
  }

  async updateMaterial(id: string, updateMaterialDto: UpdateMaterialDto) {
    const material = await this.materialRepository.findOne({ where: { id } });
    if (!material) throw new NotFoundException('Material não encontrado');

    const updateData: any = { ...updateMaterialDto };
    if (updateMaterialDto.filePath !== undefined) {
      updateData.filePath = this.normalizeMediaPath(updateMaterialDto.filePath);
    }
    if (updateMaterialDto.link !== undefined) {
      updateData.link = this.normalizeMediaPath(updateMaterialDto.link) || '';
    }

    Object.assign(material, updateData);
    return await this.materialRepository.save(material);
  }

  async removeMaterial(id: string) {
    const material = await this.materialRepository.findOne({ where: { id } });
    if (!material) throw new NotFoundException('Material não encontrado');
    await this.materialRepository.remove(material);
    return { success: true, message: 'Material removido com sucesso' };
  }

  async findMaterialsByLesson(lessonId: string) {
    return await this.materialRepository.find({
      where: { lessonId },
      order: { orderIndex: 'ASC' },
    });
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

  async markLessonAsIncomplete(userId: string, lessonId: string): Promise<void> {
    const existing = await this.progressRepository.findOne({
      where: { userId, lessonId },
    });

    if (existing) {
      existing.completed = false;
      existing.completedAt = null;
      await this.progressRepository.save(existing);
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

