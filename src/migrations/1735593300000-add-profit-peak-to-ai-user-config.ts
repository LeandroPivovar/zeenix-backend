import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfitPeakToAiUserConfig1735593300000 implements MigrationInterface {
    name = 'AddProfitPeakToAiUserConfig1735593300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const existingColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `ai_user_config` LIKE 'profit_peak';",
        );

        if (existingColumn.length === 0) {
            await queryRunner.query(
                "ALTER TABLE `ai_user_config` ADD COLUMN `profit_peak` decimal(10,2) DEFAULT 0.00 AFTER `stop_blindado_percent`;",
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const existingColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `ai_user_config` LIKE 'profit_peak';",
        );

        if (existingColumn.length > 0) {
            await queryRunner.query(
                'ALTER TABLE `ai_user_config` DROP COLUMN `profit_peak`;',
            );
        }
    }
}
