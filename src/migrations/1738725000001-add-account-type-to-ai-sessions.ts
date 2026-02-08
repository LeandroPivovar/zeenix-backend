import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddAccountTypeToAiSessions1738725000001
    implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const tableUser = await queryRunner.getTable('ai_sessions');
        if (tableUser) {
            if (!tableUser.columns.find((c) => c.name === 'account_type')) {
                await queryRunner.addColumn(
                    'ai_sessions',
                    new TableColumn({
                        name: 'account_type',
                        type: 'varchar',
                        length: '20',
                        isNullable: false,
                        default: "'demo'",
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tableUser = await queryRunner.getTable('ai_sessions');
        if (tableUser && tableUser.columns.find((c) => c.name === 'account_type')) {
            await queryRunner.dropColumn('ai_sessions', 'account_type');
        }
    }
}
