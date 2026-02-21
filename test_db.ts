import mysql from 'mysql2/promise';

async function main() {
    const connection = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: 'change_me',
        database: 'zeenix'
    });

    try {
        const [rows] = await connection.execute(
            'SELECT id, timestamp, user_id, log_level, module, message FROM autonomous_agent_logs ORDER BY id DESC LIMIT 20'
        );
        console.log('Últimos 20 logs:');
        console.table(rows);
    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await connection.end();
    }
}

main();
