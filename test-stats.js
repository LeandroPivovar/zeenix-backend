const WebSocket = require('ws');

async function testMarkupStatistics() {
    const appId = process.env.DERIV_APP_ID || 111346;
    const token = process.env.DERIV_READ_TOKEN;

    if (!token) {
        console.error('ERRO: DERIV_READ_TOKEN não definida');
        return;
    }

    console.log(`Testando app_markup_statistics para APP_ID: ${appId}`);
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);

    ws.on('open', () => {
        console.log('WS Conectado. Autorizando...');
        ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.error) {
            console.error('ERRO API:', msg.error);
            ws.close();
            return;
        }

        if (msg.msg_type === 'authorize') {
            console.log('Autorizado com sucesso!');
            const now = new Date().toISOString().split('T')[0];
            const firstDayMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

            console.log(`Solicitando estatísticas de ${firstDayMonth} até ${now}...`);
            ws.send(JSON.stringify({
                app_markup_statistics: 1,
                date_from: `${firstDayMonth} 00:00:00`,
                date_to: `${now} 23:59:59`,
                app_id: Number(appId)
            }));
        }

        if (msg.msg_type === 'app_markup_statistics') {
            console.log('RESPOSTA app_markup_statistics:');
            console.log(JSON.stringify(msg.app_markup_statistics, null, 2));
            ws.close();
        }
    });

    ws.on('error', (err) => console.error('ERRO WS:', err));
    ws.on('close', () => console.log('WS Fechado.'));
}

testMarkupStatistics();
