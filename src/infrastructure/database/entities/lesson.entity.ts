import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { CourseEntity } from './course.entity';
import { ModuleEntity } from './module.entity';

@Entity('lessons')
export class LessonEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'char', length: 36, name: 'course_id' })
  courseId: string;

  @Column({ type: 'char', length: 36, nullable: true, name: 'module_id' })
  moduleId?: string | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'varchar', length: 20 })
  duration: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'video_url' })
  videoUrl?: string | null;

  @Column({ type: 'int', default: 0, name: 'order_index' })
  orderIndex: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => CourseEntity, course => course.lessons, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course?: CourseEntity;

  @ManyToOne(() => ModuleEntity, module => module.lessons, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'module_id' })
  module?: ModuleEntity | null;
}

