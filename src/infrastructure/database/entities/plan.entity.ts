import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('plans')
export class PlanEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'external_id' })
  externalId?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  @Column({ type: 'varchar', length: 10, default: 'BRL' })
  currency: string;

  @Column({ type: 'varchar', length: 20, default: 'month', name: 'billing_period' })
  billingPeriod: string;

  @Column({ type: 'json', nullable: true })
  features?: any;

  @Column({ type: 'json', nullable: true })
  benefits?: any;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'purchase_link' })
  purchaseLink?: string;

  @Column({ type: 'boolean', default: false, name: 'is_popular' })
  isPopular: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_recommended' })
  isRecommended: boolean;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'int', default: 0, name: 'display_order' })
  displayOrder: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => UserEntity, user => user.plan)
  users?: UserEntity[];
}




