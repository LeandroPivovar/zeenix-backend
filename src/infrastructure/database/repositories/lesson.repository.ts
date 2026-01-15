import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lesson } from '../../../domain/entities/lesson.entity';
import { LessonEntity } from '../entities/lesson.entity';
import { ModuleEntity } from '../entities/module.entity';

@Injectable()
export class TypeOrmLessonRepository {
  constructor(
    @InjectRepository(LessonEntity)
    private readonly lessonRepository: Repository<LessonEntity>,
    @InjectRepository(ModuleEntity)
    private readonly moduleRepository: Repository<ModuleEntity>,
  ) {}

  async findByCourseId(courseId: string): Promise<Lesson[]> {
    const entities = await this.lessonRepository.find({
      where: { courseId },
      relations: ['module'],
      order: { orderIndex: 'ASC' },
    });
    return entities.map((e) => this.toDomain(e));
  }

  async findById(id: string): Promise<Lesson | null> {
    const entity = await this.lessonRepository.findOne({
      where: { id },
      relations: ['module', 'course'],
    });
    return entity ? this.toDomain(entity) : null;
  }

  async findModulesByCourseId(courseId: string): Promise<any[]> {
    const modules = await this.moduleRepository.find({
      where: { courseId },
      order: { orderIndex: 'ASC' },
    });
    const lessons = await this.lessonRepository.find({
      where: { courseId },
      order: { orderIndex: 'ASC' },
    });
    return modules.map((m) => ({
      id: m.id,
      title: m.title,
      orderIndex: m.orderIndex,
      lessons: lessons
        .filter((l) => l.moduleId === m.id)
        .map((l) => this.toDomain(l)),
    }));
  }

  private toDomain(entity: LessonEntity): Lesson {
    return new Lesson(
      entity.id,
      entity.courseId,
      entity.moduleId ?? null,
      entity.title,
      entity.description ?? null,
      entity.duration,
      entity.videoUrl ?? null,
      entity.orderIndex,
      entity.createdAt,
      entity.updatedAt,
    );
  }
}
