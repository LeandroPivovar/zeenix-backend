const WebSocket = require('ws');

// Usage: node debug-markup.js <TOKEN> [APP_ID]
const token = process.argv[2];
const appId = process.argv[3] || 1089;

if (!token) {
    console.error('Usage: node debug-markup.js <TOKEN> [APP_ID]');
    console.error('Please provide your Deriv API token.');
    process.exit(1);
}

const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
console.log(`Connecting to ${url}...`);

const ws = new WebSocket(url, {
    headers: { Origin: 'https://app.deriv.com' }
});

ws.on('open', () => {
    console.log('Connected. Sending authorize...');
    ws.send(JSON.stringify({ authorize: token }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.error) {
        console.error('API Error:', JSON.stringify(msg.error, null, 2));
        ws.close();
        return;
    }

    if (msg.msg_type === 'authorize') {
        console.log('Authorized. Requesting app_markup_details...');
        // Request last 30 days
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

        const req = {
            app_markup_details: 1,
            date_from: thirtyDaysAgo.toISOString().split('T')[0] + ' 00:00:00',
            date_to: now.toISOString().split('T')[0] + ' 23:59:59',
            limit: 5,
            description: 1
        };
        console.log('Request:', JSON.stringify(req, null, 2));
        ws.send(JSON.stringify(req));
    } else if (msg.msg_type === 'app_markup_details') {
        console.log('--- RAW RESPONSE (app_markup_details) ---');
        console.log(JSON.stringify(msg.app_markup_details, null, 2));
        console.log('-----------------------------------------');
        console.log('Type of app_markup_details:', typeof msg.app_markup_details);
        console.log('Is Array?', Array.isArray(msg.app_markup_details));
        ws.close();
    } else {
        console.log('Received message:', msg.msg_type);
    }
});

ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
});
