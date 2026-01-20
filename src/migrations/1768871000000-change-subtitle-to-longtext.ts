import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeSubtitleToLongtext1768871000000 implements MigrationInterface {
    name = 'ChangeSubtitleToLongtext1768871000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(\`ALTER TABLE \`support_items\` MODIFY \`subtitle\` LONGTEXT\`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting to what we assume was the previous state (likely VARCHAR or TEXT)
        // Based on the entity having 'varchar' length 500 implies it might have been created as such if synchronize was true once.
        // Or specific length. To be safe on revert, we can use TEXT or VARCHAR(500) if we are sure it fits.
        // Since we are fixing "Data too long", reverting will likely cause that issue again, which is expected for 'down'.
        await queryRunner.query(\`ALTER TABLE \`support_items\` MODIFY \`subtitle\` VARCHAR(500)\`);
    }
}
