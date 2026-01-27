import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddBenefitsColumnToPlans1769486500000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            "plans",
            new TableColumn({
                name: "benefits",
                type: "json",
                isNullable: true,
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn("plans", "benefits");
    }

}
