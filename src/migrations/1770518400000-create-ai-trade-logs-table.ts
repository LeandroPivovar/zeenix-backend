import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateAiTradeLogsTable1770518400000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'ai_trade_logs',
                columns: [
                    {
                        name: 'id',
                        type: 'int',
                        isPrimary: true,
                        isGenerated: true,
                        generationStrategy: 'increment',
                    },
                    {
                        name: 'ai_sessions_id',
                        type: 'int',
                        isNullable: false,
                    },
                    {
                        name: 'invested_value',
                        type: 'decimal',
                        precision: 10,
                        scale: 2,
                        isNullable: false,
                    },
                    {
                        name: 'returned_value',
                        type: 'decimal',
                        precision: 10,
                        scale: 2,
                        isNullable: false,
                    },
                    {
                        name: 'result',
                        type: 'varchar',
                        length: '50',
                        isNullable: false,
                        comment: "'WON', 'LOST'",
                    },
                    {
                        name: 'created_at',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'ai_trade_logs',
            new TableForeignKey({
                columnNames: ['ai_sessions_id'],
                referencedColumnNames: ['id'],
                referencedTableName: 'ai_sessions',
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('ai_trade_logs');
        const foreignKey = table.foreignKeys.find(
            (fk) => fk.columnNames.indexOf('ai_sessions_id') !== -1,
        );
        if (foreignKey) {
            await queryRunner.dropForeignKey('ai_trade_logs', foreignKey);
        }
        await queryRunner.dropTable('ai_trade_logs');
    }
}
