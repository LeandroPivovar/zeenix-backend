import WebSocket from 'ws';

const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

const activeSymbols = [
    'R_100', 'R_10', 'R_25', 'R_50', 'R_75',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
];

ws.on('open', async () => {
    console.log('Testando todos os símbolos...');

    for (const symbol of activeSymbols) {
        ws.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 100,
            end: 'latest',
            subscribe: 1,
            style: 'ticks'
        }));
        await new Promise(r => setTimeout(r, 200));
    }
});

let errorCount = 0;
let successCount = 0;

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.error) {
        console.error(`ERRO: ${msg.error.code} - ${msg.error.message}`);
        errorCount++;
    } else if (msg.msg_type === 'history') {
        console.log(`SUCESSO - Histórico recebido: ${msg.echo_req.ticks_history}`);
        successCount++;
    }
});

setTimeout(() => {
    console.log(`Resumo: ${successCount} sucessos, ${errorCount} erros`);
    ws.close();
    process.exit(0);
}, 6000);
