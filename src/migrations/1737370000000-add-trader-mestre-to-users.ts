import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddTraderMestreToUsers1737370000000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("users");
        if (table && !table.findColumnByName("trader_mestre")) {
            await queryRunner.addColumn("users", new TableColumn({
                name: "trader_mestre",
                type: "boolean",
                default: false,
                isNullable: false
            }));
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("users");
        if (table && table.findColumnByName("trader_mestre")) {
            await queryRunner.dropColumn("users", "trader_mestre");
        }
    }

}
