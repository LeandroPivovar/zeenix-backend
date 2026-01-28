import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('markets')
export class MarketEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    symbol: string;

    @Column()
    displayName: string;

    @Column()
    market: string;

    @Column()
    marketDisplayName: string;

    @Column()
    submarket: string;

    @Column()
    submarketDisplayName: string;

    @Column({ default: true })
    isActive: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
