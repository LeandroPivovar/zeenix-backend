import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionIdToAutonomousAgentTables1740000000001 implements MigrationInterface {
    name = 'AddSessionIdToAutonomousAgentTables1740000000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // --- Table: autonomous_agent_config ---

        // Add session_id to autonomous_agent_config
        const configSessionIdColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `autonomous_agent_config` LIKE 'session_id';",
        );

        if (configSessionIdColumn.length === 0) {
            await queryRunner.query(
                "ALTER TABLE `autonomous_agent_config` ADD COLUMN `session_id` VARCHAR(255) NULL COMMENT 'ID da sessão ativa' AFTER `session_status`;",
            );
        }

        // Add session_source to autonomous_agent_config
        const configSessionSourceColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `autonomous_agent_config` LIKE 'session_source';",
        );

        if (configSessionSourceColumn.length === 0) {
            await queryRunner.query(
                "ALTER TABLE `autonomous_agent_config` ADD COLUMN `session_source` VARCHAR(50) NULL COMMENT 'Origem da sessão (ALUNO ou MASTER)' AFTER `session_id`;",
            );
        }

        // --- Table: autonomous_agent_trades ---

        // Add session_id to autonomous_agent_trades
        const tradesSessionIdColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `autonomous_agent_trades` LIKE 'session_id';",
        );

        if (tradesSessionIdColumn.length === 0) {
            await queryRunner.query(
                "ALTER TABLE `autonomous_agent_trades` ADD COLUMN `session_id` VARCHAR(255) NULL COMMENT 'ID da sessão à qual o trade pertence' AFTER `user_id`;",
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // --- Table: autonomous_agent_trades ---

        const tradesSessionIdColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `autonomous_agent_trades` LIKE 'session_id';",
        );

        if (tradesSessionIdColumn.length > 0) {
            await queryRunner.query(
                'ALTER TABLE `autonomous_agent_trades` DROP COLUMN `session_id`;',
            );
        }

        // --- Table: autonomous_agent_config ---

        const configSessionSourceColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `autonomous_agent_config` LIKE 'session_source';",
        );

        if (configSessionSourceColumn.length > 0) {
            await queryRunner.query(
                'ALTER TABLE `autonomous_agent_config` DROP COLUMN `session_source`;',
            );
        }

        const configSessionIdColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `autonomous_agent_config` LIKE 'session_id';",
        );

        if (configSessionIdColumn.length > 0) {
            await queryRunner.query(
                'ALTER TABLE `autonomous_agent_config` DROP COLUMN `session_id`;',
            );
        }
    }
}
