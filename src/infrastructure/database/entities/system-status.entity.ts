import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

export enum SystemStatusType {
  OPERATIONAL = 'operational',
  DEGRADED = 'degraded',
  OUTAGE = 'outage',
  MAINTENANCE = 'maintenance',
}

@Entity('system_status')
export class SystemStatusEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 255, name: 'service_name', unique: true })
  serviceName: string;

  @Column({
    type: 'enum',
    enum: ['operational', 'degraded', 'outage', 'maintenance'],
    default: 'operational',
  })
  status: SystemStatusType;

  @Column({ type: 'text', nullable: true })
  message?: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
