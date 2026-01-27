import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeIsDerivTutorialToInt1769486232895 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Altera a coluna de boolean para int, permitindo nulo
        // MySQL trata boolean como tinyint(1), então vamos mudar para int para suportar 1, 2, 3
        await queryRunner.query(`ALTER TABLE lessons MODIFY is_deriv_tutorial INT NULL DEFAULT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverte para boolean (tinyint(1))
        await queryRunner.query(`UPDATE lessons SET is_deriv_tutorial = 0 WHERE is_deriv_tutorial IS NULL OR is_deriv_tutorial > 1`);
        await queryRunner.query(`ALTER TABLE lessons MODIFY is_deriv_tutorial TINYINT(1) DEFAULT 0`);
    }

}
