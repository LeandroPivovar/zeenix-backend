import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeSubtitleToLongtext1768871000000 implements MigrationInterface {
    name = 'ChangeSubtitleToLongtext1768871000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `support_items` MODIFY `subtitle` LONGTEXT");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting
        await queryRunner.query("ALTER TABLE `support_items` MODIFY `subtitle` VARCHAR(500)");
    }
}
