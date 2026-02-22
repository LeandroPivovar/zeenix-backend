import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('webhook_logs')
export class WebhookLogEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'event_type', length: 100, nullable: true })
    eventType: string;

    @Column({ type: 'longtext' })
    payload: string;

    @Column({ length: 50, default: 'received' })
    status: string;

    @Column({ length: 255, nullable: true })
    email: string;

    @Column({ type: 'text', nullable: true })
    details: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
