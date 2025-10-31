import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { LessonEntity } from './lesson.entity';

@Entity('courses')
export class CourseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'image_placeholder' })
  imagePlaceholder?: string | null;

  @Column({ type: 'int', default: 0, name: 'total_lessons' })
  totalLessons: number;

  @Column({ type: 'varchar', length: 20, name: 'total_duration' })
  totalDuration: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => LessonEntity, lesson => lesson.course)
  lessons?: LessonEntity[];
}

