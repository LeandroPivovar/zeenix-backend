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

  @Column({ type: 'enum', enum: ['Video', 'Text', 'PDF', 'Link'], default: 'Video', name: 'content_type' })
  contentType?: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'content_link' })
  contentLink?: string | null;

  @Column({ type: 'enum', enum: ['Imediata', 'Agendada'], default: 'Imediata', name: 'release_type' })
  releaseType?: string;

  @Column({ type: 'datetime', nullable: true, name: 'release_date' })
  releaseDate?: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive?: boolean;

  @Column({ type: 'varchar', length: 20 })
  duration: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'video_url' })
  videoUrl?: string | null;

  @Column({ type: 'int', default: 0, name: 'order_index' })
  orderIndex: number;

  @Column({ type: 'int', default: 0, name: 'is_deriv_tutorial' })
  isDerivTutorial: number;

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

