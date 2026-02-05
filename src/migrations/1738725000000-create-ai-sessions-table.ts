import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateAiSessionsTable1738725000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: "ai_sessions",
                columns: [
                    {
                        name: "id",
                        type: "int",
                        isPrimary: true,
                        isGenerated: true,
                        generationStrategy: "increment",
                    },
                    {
                        name: "user_id",
                        type: "varchar",
                        length: "255",
                        isNullable: false,
                    },
                    {
                        name: "ai_name",
                        type: "varchar",
                        length: "255",
                        isNullable: false,
                    },
                    {
                        name: "status",
                        type: "varchar",
                        length: "50",
                        default: "'active'",
                    },
                    {
                        name: "total_trades",
                        type: "int",
                        default: 0,
                    },
                    {
                        name: "total_wins",
                        type: "int",
                        default: 0,
                    },
                    {
                        name: "total_losses",
                        type: "int",
                        default: 0,
                    },
                    {
                        name: "total_profit",
                        type: "decimal",
                        precision: 10,
                        scale: 2,
                        default: 0.00,
                    },
                    {
                        name: "start_time",
                        type: "datetime",
                        default: "CURRENT_TIMESTAMP",
                    },
                    {
                        name: "end_time",
                        type: "datetime",
                        isNullable: true,
                    },
                    {
                        name: "created_at",
                        type: "datetime",
                        default: "CURRENT_TIMESTAMP",
                    },
                    {
                        name: "updated_at",
                        type: "datetime",
                        default: "CURRENT_TIMESTAMP",
                        onUpdate: "CURRENT_TIMESTAMP",
                    }
                ]
            }),
            true
        );

        await queryRunner.createIndex(
            "ai_sessions",
            new TableIndex({
                name: "IDX_AI_SESSIONS_USER_ID",
                columnNames: ["user_id"],
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable("ai_sessions");
    }
}
