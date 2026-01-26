import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('app_configs')
export class AppConfigEntity {
    @PrimaryColumn()
    key: string;

    @Column({ type: 'json', nullable: true })
    value: any;

    @Column({ nullable: true })
    description: string;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
