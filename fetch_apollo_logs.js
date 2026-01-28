const mysql = require('mysql2/promise');

async function run() {
    try {
        const connection = await mysql.createConnection({
            host: '127.0.0.1',
            user: 'ultra_app',
            password: 'UltraApp2024!@#',
            database: 'zeenix'
        });

        const [rows] = await connection.execute(
            'SELECT id, user_id, type, message, details, timestamp FROM ai_logs WHERE details LIKE ? ORDER BY timestamp DESC LIMIT 1000',
            ['%"strategy":"apollo"%']
        );

        console.log(JSON.stringify(rows, null, 2));

        await connection.end();
    } catch (err) {
        console.error('Error:', err);
    }
}

run();
