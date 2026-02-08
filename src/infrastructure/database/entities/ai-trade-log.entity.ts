import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('ai_trade_logs')
export class AiTradeLogEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'ai_sessions_id' })
    aiSessionsId: number;

    @Column({ name: 'invested_value', type: 'decimal', precision: 10, scale: 2 })
    investedValue: number;

    @Column({ name: 'returned_value', type: 'decimal', precision: 10, scale: 2 })
    returnedValue: number;

    @Column({ length: 50 })
    result: string; // 'WON', 'LOST'

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
