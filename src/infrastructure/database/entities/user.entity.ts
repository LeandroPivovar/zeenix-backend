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

  @Column({ type: 'varchar', length: 20, nullable: true, unique: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'varchar', length: 50, default: 'user' })
  role: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'boolean', default: false, name: 'trader_mestre' })
  traderMestre: boolean;

  @Column({ type: 'boolean', default: true, name: 'first_access' })
  firstAccess: boolean;

  @Column({ type: 'datetime', nullable: true, name: 'last_login_at' })
  lastLoginAt?: Date | null;

  @Column({ type: 'char', length: 36, nullable: true, name: 'plan_id' })
  planId?: string | null;

  @Column({ type: 'datetime', nullable: true, name: 'plan_activated_at' })
  planActivatedAt?: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'deriv_login_id' })
  derivLoginId?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'deriv_currency' })
  derivCurrency?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'token_demo' })
  tokenDemo?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'token_real' })
  tokenReal?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'token_real_currency' })
  tokenRealCurrency?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'token_demo_currency' })
  tokenDemoCurrency?: string | null;

  // suportar cripto (ex.: BTC com muitas casas decimais)
  @Column({ type: 'decimal', precision: 36, scale: 18, nullable: true, name: 'deriv_balance' })
  derivBalance?: string | null;

  @Column({ type: 'decimal', precision: 36, scale: 18, default: 0, name: 'real_amount' })
  realAmount: number;

  @Column({ type: 'decimal', precision: 36, scale: 18, default: 0, name: 'demo_amount' })
  demoAmount: number;

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
