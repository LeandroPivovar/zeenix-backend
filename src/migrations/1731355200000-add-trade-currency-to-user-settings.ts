import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTradeCurrencyToUserSettings1731355200000 implements MigrationInterface {
  name = 'AddTradeCurrencyToUserSettings1731355200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existingColumn = await queryRunner.query(
      "SHOW COLUMNS FROM `user_settings` LIKE 'trade_currency';",
    );

    if (existingColumn.length === 0) {
      await queryRunner.query(
        "ALTER TABLE `user_settings` ADD COLUMN `trade_currency` varchar(10) DEFAULT 'USD' AFTER `timezone`;",
      );
      await queryRunner.query(
        "UPDATE `user_settings` SET `trade_currency` = 'USD' WHERE `trade_currency` IS NULL;",
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const existingColumn = await queryRunner.query(
      "SHOW COLUMNS FROM `user_settings` LIKE 'trade_currency';",
    );

    if (existingColumn.length > 0) {
      await queryRunner.query(
        'ALTER TABLE `user_settings` DROP COLUMN `trade_currency`;',
      );
    }
  }
}


