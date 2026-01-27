import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('notifications')
export class NotificationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    @Column({ type: 'text' })
    description: string;

    @Column({ name: 'display_until', type: 'datetime' })
    displayUntil: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
