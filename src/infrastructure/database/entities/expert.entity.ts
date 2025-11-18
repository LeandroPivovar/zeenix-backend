import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('experts')
export class ExpertEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 100 })
  specialty: string;

  @Column({ type: 'text', nullable: true })
  bio?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'avatar_url' })
  avatarUrl?: string | null;

  @Column({ type: 'int', default: 0, name: 'experience_years' })
  experienceYears: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  @Column({ type: 'int', default: 0, name: 'total_reviews' })
  totalReviews: number;

  @Column({ type: 'int', default: 0, name: 'total_followers' })
  totalFollowers: number;

  @Column({ type: 'int', default: 0, name: 'total_signals' })
  totalSignals: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0, name: 'win_rate' })
  winRate: number;

  @Column({ type: 'boolean', default: false, name: 'is_verified' })
  isVerified: boolean;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'json', nullable: true, name: 'social_links' })
  socialLinks?: any | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'login_original' })
  loginOriginal?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'login_alvo' })
  loginAlvo?: string | null;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, name: 'saldo_alvo' })
  saldoAlvo: number;

  @Column({ type: 'varchar', length: 50, default: 'Desconectado', name: 'connection_status' })
  connectionStatus: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'trader_type' })
  traderType?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

