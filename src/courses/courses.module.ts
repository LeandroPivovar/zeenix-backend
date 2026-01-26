import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { CourseEntity } from '../infrastructure/database/entities/course.entity';
import { LessonEntity } from '../infrastructure/database/entities/lesson.entity';
import { ModuleEntity } from '../infrastructure/database/entities/module.entity';
import { MaterialEntity } from '../infrastructure/database/entities/material.entity';
import { UserLessonProgressEntity } from '../infrastructure/database/entities/user-lesson-progress.entity';
import { UserEntity } from '../infrastructure/database/entities/user.entity';
import { TypeOrmCourseRepository } from '../infrastructure/database/repositories/course.repository';
import { TypeOrmLessonRepository } from '../infrastructure/database/repositories/lesson.repository';
import { COURSE_REPOSITORY_TOKEN } from '../constants/tokens';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseEntity, LessonEntity, ModuleEntity, MaterialEntity, UserLessonProgressEntity, UserEntity]),
    JwtModule,
  ],
  controllers: [CoursesController],
  providers: [
    {
      provide: COURSE_REPOSITORY_TOKEN,
      useClass: TypeOrmCourseRepository,
    },
    TypeOrmLessonRepository,
    CoursesService,
  ],
  exports: [COURSE_REPOSITORY_TOKEN, TypeOrmLessonRepository],
})
export class CoursesModule { }

