import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

export enum TradeType {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum TradeStatus {
  PENDING = 'pending',
  WON = 'won',
  LOST = 'lost',
}

@Entity('trades')
export class TradeEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'char', length: 36, name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 50, name: 'contract_type' })
  contractType: string;

  @Column({ type: 'varchar', length: 20, name: 'time_type' })
  timeType: string;

  @Column({ type: 'varchar', length: 20 })
  duration: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1.0 })
  multiplier: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'entry_value' })
  entryValue: number;

  @Column({ type: 'enum', enum: TradeType, name: 'trade_type' })
  tradeType: TradeType;

  @Column({ type: 'enum', enum: TradeStatus, default: TradeStatus.PENDING })
  status: TradeStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  profit?: number | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'deriv_transaction_id',
  })
  derivTransactionId?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'symbol' })
  symbol?: string | null;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    name: 'exit_value',
  })
  exitValue?: number | null;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    name: 'entry_spot',
  })
  entrySpot?: number | null;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    name: 'exit_spot',
  })
  exitSpot?: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;
}
