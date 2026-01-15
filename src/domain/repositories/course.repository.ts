import { Course } from '../entities/course.entity';

export interface CourseRepository {
  findAll(): Promise<Course[]>;
  findById(id: string): Promise<Course | null>;
  findByIdWithLessons(id: string): Promise<Course | null>;
}




