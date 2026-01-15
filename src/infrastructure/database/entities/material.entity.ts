import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { LessonEntity } from './lesson.entity';

@Entity('materials')
export class MaterialEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'char', length: 36, name: 'lesson_id' })
  lessonId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({
    type: 'enum',
    enum: ['PDF', 'DOC', 'XLS', 'PPT', 'LINK', 'OTHER'],
    default: 'PDF',
  })
  type: string;

  @Column({ type: 'varchar', length: 500 })
  link: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'file_path' })
  filePath?: string | null;

  @Column({ type: 'int', default: 0, name: 'order_index' })
  orderIndex: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => LessonEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson?: LessonEntity;
}
