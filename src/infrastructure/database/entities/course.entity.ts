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

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  slug?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'seo_title' })
  seoTitle?: string | null;

  @Column({ type: 'text', nullable: true, name: 'seo_description' })
  seoDescription?: string | null;

  @Column({ type: 'json', nullable: true })
  keywords?: string[] | null;

  @Column({ type: 'longtext', nullable: true, name: 'social_image' })
  socialImage?: string | null;

  @Column({ type: 'enum', enum: ['1', '2', '3'], default: '1' })
  access?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0.0 })
  price?: number;

  @Column({ type: 'varchar', length: 10, default: 'R$' })
  currency?: string;

  @Column({ type: 'enum', enum: ['1', '2'], default: '1' })
  subscription?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  discount?: string | null;

  @Column({ type: 'enum', enum: ['draft', 'published', 'archived'], default: 'draft' })
  status?: string;

  @Column({ type: 'datetime', nullable: true, name: 'available_from' })
  availableFrom?: Date | null;

  @Column({ type: 'datetime', nullable: true, name: 'available_until' })
  availableUntil?: Date | null;

  @Column({ type: 'enum', enum: ['public', 'private', 'restricted'], default: 'public' })
  visibility?: string;

  @Column({ type: 'longtext', nullable: true, name: 'cover_image' })
  coverImage?: string | null;

  @Column({ type: 'int', default: 0, name: 'total_lessons' })
  totalLessons: number;

  @Column({ type: 'varchar', length: 20, name: 'total_duration', default: '0 min' })
  totalDuration: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => LessonEntity, lesson => lesson.course)
  lessons?: LessonEntity[];
}

