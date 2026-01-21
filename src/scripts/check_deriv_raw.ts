
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkUser() {
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
    const result = await ds.query('SELECT u.deriv_raw, s.trade_currency FROM users u LEFT JOIN user_settings s ON u.id = s.user_id WHERE u.id = ?', [userId]);

    console.log('User Data:', JSON.stringify(result, null, 2));
    await ds.destroy();
}

checkUser().catch(console.error);

