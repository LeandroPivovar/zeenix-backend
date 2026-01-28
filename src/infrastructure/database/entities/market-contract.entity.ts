import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { MarketEntity } from './market.entity';

@Entity('market_contracts')
export class MarketContractEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'market_symbol' })
    marketSymbol: string;

    @Column({ name: 'contract_type' })
    contractType: string;

    @Column({ name: 'contract_category', nullable: true })
    contractCategory: string;

    @Column({ name: 'contract_display', nullable: true })
    contractDisplay: string;

    @Column({ name: 'min_contract_duration', nullable: true })
    minContractDuration: string;

    @Column({ name: 'max_contract_duration', nullable: true })
    maxContractDuration: string;

    @Column({ nullable: true })
    sentiment: string;

    @Column({ nullable: true })
    barriers: number;

    @Column({ name: 'exchange_name', nullable: true })
    exchangeName: string;

    @Column({ nullable: true })
    market: string;

    @Column({ nullable: true })
    submarket: string;

    @Column({ type: 'json', nullable: true })
    payload: any;

    @ManyToOne(() => MarketEntity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'market_symbol', referencedColumnName: 'symbol' })
    marketEntity: MarketEntity;
}
