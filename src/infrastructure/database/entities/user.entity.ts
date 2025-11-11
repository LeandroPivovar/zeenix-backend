import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { PlanEntity } from './plan.entity';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'char', length: 36, nullable: true, name: 'plan_id' })
  planId?: string | null;

  @Column({ type: 'datetime', nullable: true, name: 'plan_activated_at' })
  planActivatedAt?: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'deriv_login_id' })
  derivLoginId?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'deriv_currency' })
  derivCurrency?: string | null;

  // suportar cripto (ex.: BTC com muitas casas decimais)
  @Column({ type: 'decimal', precision: 36, scale: 18, nullable: true, name: 'deriv_balance' })
  derivBalance?: string | null;

  @Column({ type: 'json', nullable: true, name: 'deriv_raw' })
  derivRaw?: any | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'plan_id' })
  plan?: PlanEntity | null;
}
