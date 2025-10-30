import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  derivLoginId?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  derivCurrency?: string | null;

  // suportar cripto (ex.: BTC com muitas casas decimais)
  @Column({ type: 'decimal', precision: 36, scale: 18, nullable: true })
  derivBalance?: string | null;

  @Column({ type: 'json', nullable: true })
  derivRaw?: any | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
