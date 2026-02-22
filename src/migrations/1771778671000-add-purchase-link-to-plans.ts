import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddPurchaseLinkToPlans1771778671000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            "plans",
            new TableColumn({
                name: "purchase_link",
                type: "varchar",
                length: "255",
                isNullable: true,
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn("plans", "purchase_link");
    }

}
