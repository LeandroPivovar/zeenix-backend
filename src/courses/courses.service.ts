import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual } from 'typeorm';
import type { CourseRepository } from '../domain/repositories/course.repository';
import { COURSE_REPOSITORY_TOKEN } from '../constants/tokens';
import { TypeOrmLessonRepository } from '../infrastructure/database/repositories/lesson.repository';
import { UserLessonProgressEntity } from '../infrastructure/database/entities/user-lesson-progress.entity';
import { CourseEntity } from '../infrastructure/database/entities/course.entity';
import { ModuleEntity } from '../infrastructure/database/entities/module.entity';
import { LessonEntity } from '../infrastructure/database/entities/lesson.entity';
import { MaterialEntity } from '../infrastructure/database/entities/material.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { PlanEntity } from '../infrastructure/database/entities/plan.entity';
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
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(PlanEntity)
    private readonly plansRepository: Repository<PlanEntity>,
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

  async getAccessiblePlanIds(userPlanId: string): Promise<string[]> {
    if (!userPlanId) return [];

    // Buscar o plano do usuário para saber a ordem
    const userPlan = await this.plansRepository.findOne({ where: { id: userPlanId } });
    console.log(`[CoursesService] Found UserPlan for ID ${userPlanId}:`, userPlan);
    if (!userPlan) return [];

    // Buscar todos os planos com displayOrder <= plano do usuário
    // Isso assume que planos superiores têm displayOrder MAIOR
    const accessiblePlans = await this.plansRepository.find({
      where: {
        displayOrder: LessThanOrEqual(userPlan.displayOrder),
        isActive: true
      },
      select: ['id']
    });

    return accessiblePlans.map(p => p.id);
  }

  async findAll(userPlanId?: string | null, isAdmin?: boolean) {
    const query = this.courseEntityRepository.createQueryBuilder('course');

    // Se for admin, não filtra nada, vê todos os cursos
    if (isAdmin) {
      // Sem filtros de visibilidade para admin
    } else {
      // Se NÃO for admin (estudante ou não logado)
      if (userPlanId) {
        // Obter hierarquia de planos acessíveis
        const accessibleIds = await this.getAccessiblePlanIds(userPlanId);

        // Logado com plano: vê públicos OU restritos a QUALQUER plano acessível (hierarquia)
        if (accessibleIds.length > 0) {
          // Criar string para o JSON_CONTAINS ou ORs
          // MySQL JSON_OVERLAPS seria ideal, mas JSON_CONTAINS funciona para 1 item. 
          // Para lista x lista, precisamos verificar se ALGUM dos accessibleIds está em course.plan_ids
          // Abordagem compatível: (visibility = public) OR (visibility = restricted AND (course.plan_ids REGEXP 'id1|id2|id3...'))
          // Ou usar múltiplos JSON_CONTAINS OR

          // Log para debug
          const checks = accessibleIds.map(id => `JSON_CONTAINS(course.plan_ids, '"${id}"')`).join(' OR ');
          console.log(`[CoursesService] UserPlanId: ${userPlanId}`);
          console.log(`[CoursesService] Accessible Plan IDs:`, accessibleIds);
          console.log(`[CoursesService] Generated Checks: ${checks}`);

          query.where(`(course.visibility = :public OR (course.visibility = :restricted AND (${checks})))`, {
            public: 'public',
            restricted: 'restricted'
          });
        } else {
          // Fallback se não achou planos acessíveis
          query.where('course.visibility = :public', { public: 'public' });
        }
      } else {
        // Não logado ou sem plano: só vê cursos públicos
        query.where('course.visibility = :public', { public: 'public' });
      }
    }

    const courses = await query
      .orderBy('course.orderIndex', 'ASC')
      .addOrderBy('course.createdAt', 'DESC')
      .getMany();
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
      planIds: c.planIds || [],
      totalLessons: lessonCountMap[c.id] || 0,
      totalDuration: this.formatTotalDuration(lessonDurationMap[c.id] || 0),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async findOne(id: string, userPlanId?: string | null, isAdmin?: boolean) {
    const query = this.courseEntityRepository.createQueryBuilder('course')
      .where('course.id = :id', { id });

    // Aplicar as mesmas travas de visibilidade indicadas no findAll
    if (!isAdmin) {
      if (userPlanId) {
        // Obter hierarquia de planos acessíveis
        const accessibleIds = await this.getAccessiblePlanIds(userPlanId);

        if (accessibleIds.length > 0) {
          const checks = accessibleIds.map(pid => `JSON_CONTAINS(course.plan_ids, '"${pid}"')`).join(' OR ');
          query.andWhere(`(course.visibility = :public OR (course.visibility = :restricted AND (${checks})))`, {
            public: 'public',
            restricted: 'restricted'
          });
        } else {
          query.andWhere('course.visibility = :public', { public: 'public' });
        }
      } else {
        query.andWhere('course.visibility = :public', { public: 'public' });
      }
    }

    const course = await query.getOne();
    if (!course) throw new NotFoundException('Curso não encontrado ou você não tem permissão para acessá-lo');

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
          isDerivTutorial: l.isDerivTutorial,
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
      planIds: course.planIds || [],
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
      planIds: createCourseDto.planIds || [],
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

    if (updateCourseDto.planIds !== undefined) {
      course.planIds = updateCourseDto.planIds;
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

  async reorderCourses(orders: { id: string; orderIndex: number }[]) {
    await this.courseEntityRepository.manager.transaction(async transactionalEntityManager => {
      for (const order of orders) {
        await transactionalEntityManager.update(CourseEntity, order.id, { orderIndex: order.orderIndex });
      }
    });
    return { success: true };
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

    // Se for marcado como tutorial da Deriv, desmarcar todos os outros
    if (updateLessonDto.isDerivTutorial) {
      await this.lessonEntityRepository.update({ isDerivTutorial: true }, { isDerivTutorial: false });
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


  async getDerivTutorialVideo() {
    const lesson = await this.lessonEntityRepository.findOne({
      where: { isDerivTutorial: true, isActive: true },
    });

    if (!lesson) return null;

    return {
      videoUrl: lesson.videoUrl,
      contentLink: lesson.contentLink,
      contentType: lesson.contentType,
      title: lesson.title
    };
  }

  async getUserPlanId(userId: string): Promise<string | null> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    return user?.planId || null;
  }
}

