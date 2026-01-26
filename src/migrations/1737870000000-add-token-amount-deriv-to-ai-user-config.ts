import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTokenAmountDerivToAiUserConfig1737870000000 implements MigrationInterface {
    name = 'AddTokenAmountDerivToAiUserConfig1737870000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Verificar se a coluna token_deriv já existe
        const tokenDerivColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `ai_user_config` LIKE 'token_deriv';",
        );

        if (tokenDerivColumn.length === 0) {
            await queryRunner.query(
                "ALTER TABLE `ai_user_config` ADD COLUMN `token_deriv` TEXT NULL COMMENT 'Token da conta padrão do usuário' AFTER `deriv_token`;",
            );
        }

        // Verificar se a coluna amount_deriv já existe
        const amountDerivColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `ai_user_config` LIKE 'amount_deriv';",
        );

        if (amountDerivColumn.length === 0) {
            await queryRunner.query(
                "ALTER TABLE `ai_user_config` ADD COLUMN `amount_deriv` DECIMAL(36, 18) NULL COMMENT 'Saldo da conta padrão do usuário' AFTER `token_deriv`;",
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Verificar se a coluna amount_deriv existe antes de remover
        const amountDerivColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `ai_user_config` LIKE 'amount_deriv';",
        );

        if (amountDerivColumn.length > 0) {
            await queryRunner.query(
                'ALTER TABLE `ai_user_config` DROP COLUMN `amount_deriv`;',
            );
        }

        // Verificar se a coluna token_deriv existe antes de remover
        const tokenDerivColumn = await queryRunner.query(
            "SHOW COLUMNS FROM `ai_user_config` LIKE 'token_deriv';",
        );

        if (tokenDerivColumn.length > 0) {
            await queryRunner.query(
                'ALTER TABLE `ai_user_config` DROP COLUMN `token_deriv`;',
            );
        }
    }
}
