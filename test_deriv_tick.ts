import WebSocket from 'ws';

const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

ws.on('open', () => {
    console.log('Testando 1HZ100V...');
    ws.send(JSON.stringify({
        ticks_history: '1HZ100V',
        adjust_start_time: 1,
        count: 100,
        end: 'latest',
        subscribe: 1,
        style: 'ticks'
    }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.error) {
        console.error('ERRO:', msg.error);
    } else if (msg.msg_type === 'history') {
        console.log('SUCESSO - Histórico recebido:', msg.history.prices.length, 'ticks');
    } else if (msg.msg_type === 'tick') {
        console.log('Tick recebido:', msg.tick.quote);
    }
});

setTimeout(() => {
    ws.close();
    process.exit(0);
}, 5000);
