import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
    const ds = new DataSource({
        type: 'mysql',
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306'),
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    await ds.initialize();

    const userId = '1b8f8e39-0e4b-4c04-b7ad-c385f64bc618';

    console.log('--- Checking ai_sessions ---');
    const sessions = await ds.query('SELECT * FROM ai_sessions WHERE user_id = ?', [userId]);
    console.log('Sessions:', JSON.stringify(sessions, null, 2));

    if (sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);
        console.log(`--- Checking ai_trade_logs for sessions: ${sessionIds.join(', ')} ---`);
        const logs = await ds.query('SELECT * FROM ai_trade_logs WHERE ai_sessions_id IN (?)', [sessionIds]);
        console.log('Trade Logs count:', logs.length);
        if (logs.length > 0) {
            console.log('Sample Log:', JSON.stringify(logs[0], null, 2));
        }
    }

    console.log('--- Checking User derivLoginId ---');
    const user = await ds.query('SELECT id, deriv_login_id, real_amount FROM users WHERE id = ?', [userId]);
    console.log('User:', JSON.stringify(user, null, 2));

    await ds.destroy();
}

run().catch(console.error);
