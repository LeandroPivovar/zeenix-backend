import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddFictitiousBalanceToUserSettings1769025000000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns("user_settings", [
            new TableColumn({
                name: "fictitious_balance",
                type: "decimal",
                precision: 20,
                scale: 2,
                default: 10000.00,
                isNullable: false
            }),
            new TableColumn({
                name: "is_fictitious_balance_active",
                type: "boolean",
                default: false,
                isNullable: false
            }),
            new TableColumn({
                name: "show_dollar_sign",
                type: "boolean",
                default: false,
                isNullable: false
            })
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumns("user_settings", [
            "fictitious_balance",
            "is_fictitious_balance_active",
            "show_dollar_sign"
        ]);
    }

}
