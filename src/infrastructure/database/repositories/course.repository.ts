import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CourseRepository } from '../../../domain/repositories/course.repository';
import { Course } from '../../../domain/entities/course.entity';
import { CourseEntity } from '../entities/course.entity';
import { LessonEntity } from '../entities/lesson.entity';
import { ModuleEntity } from '../entities/module.entity';

@Injectable()
export class TypeOrmCourseRepository implements CourseRepository {
  constructor(
    @InjectRepository(CourseEntity)
    private readonly courseRepository: Repository<CourseEntity>,
    @InjectRepository(LessonEntity)
    private readonly lessonRepository: Repository<LessonEntity>,
    @InjectRepository(ModuleEntity)
    private readonly moduleRepository: Repository<ModuleEntity>,
  ) {}

  async findAll(): Promise<Course[]> {
    const entities = await this.courseRepository.find({
      order: { createdAt: 'ASC' },
    });
    return entities.map(e => this.toDomain(e));
  }

  async findById(id: string): Promise<Course | null> {
    const entity = await this.courseRepository.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdWithLessons(id: string): Promise<Course | null> {
    const entity = await this.courseRepository.findOne({
      where: { id },
      relations: ['lessons'],
    });
    return entity ? this.toDomain(entity) : null;
  }

  private toDomain(entity: CourseEntity): Course {
    return new Course(
      entity.id,
      entity.title,
      entity.description,
      entity.imagePlaceholder ?? null,
      entity.totalLessons,
      entity.totalDuration,
      entity.createdAt,
      entity.updatedAt,
    );
  }
}




