import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('user_settings')
export class UserSettingsEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'char', length: 36, name: 'user_id', unique: true })
  userId: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'profile_picture_url' })
  profilePictureUrl?: string | null;

  @Column({ type: 'varchar', length: 10, default: 'pt-BR' })
  language: string;

  @Column({ type: 'varchar', length: 50, default: 'America/Sao_Paulo' })
  timezone: string;

  @Column({ type: 'boolean', default: true, name: 'email_notifications' })
  emailNotifications: boolean;

  @Column({ type: 'boolean', default: false, name: 'two_factor_enabled' })
  twoFactorEnabled: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'two_factor_secret' })
  twoFactorSecret?: string | null;

  @Column({ type: 'varchar', length: 10, default: 'USD', name: 'trade_currency' })
  tradeCurrency: string;

  @Column({ type: 'timestamp', nullable: true, name: 'last_notification_cleared_at' })
  lastNotificationClearedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;
}




