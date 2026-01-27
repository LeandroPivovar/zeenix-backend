import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('user_balances')
export class UserBalanceEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'user_id', type: 'varchar', length: 36 })
    userId: string;

    @Column({ name: 'demo_balance', type: 'decimal', precision: 36, scale: 18, default: 0 })
    demoBalance: number;

    @Column({ name: 'real_balance', type: 'decimal', precision: 36, scale: 18, default: 0 })
    realBalance: number;

    @Column({ type: 'varchar', length: 10, default: 'USD' })
    currency: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user: UserEntity;
}
