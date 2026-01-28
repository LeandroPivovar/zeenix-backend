import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('markets')
export class MarketEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    symbol: string;

    @Column({ name: 'display_name' })
    displayName: string;

    @Column()
    market: string;

    @Column({ name: 'market_display_name' })
    marketDisplayName: string;

    @Column()
    submarket: string;

    @Column({ name: 'submarket_display_name' })
    submarketDisplayName: string;

    @Column({ name: 'is_active', default: true })
    isActive: boolean;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
