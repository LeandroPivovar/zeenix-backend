const WebSocket = require('ws');

class VolatilityMonitor {
    constructor() {
        this.ws = null;
        this.ticks = [];
        this.maxTicks = 10;
        this.appId = process.env.DERIV_APP_ID || '111346';
        this.token = process.env.DERIV_TOKEN || null;
        this.symbol = 'R_100'; // Volatility 100 Index
        this.isConnected = false;
        this.reconnectDelay = 3000;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    connect() {
        console.log('\n🚀 [VolatilityMonitor] Iniciando conexão com Deriv API...');
        
        const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        this.ws = new WebSocket(endpoint);

        this.ws.on('open', () => {
            console.log('✅ [VolatilityMonitor] Conexão WebSocket estabelecida');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            
            // Se tiver token, autoriza; senão, subscreve direto
            if (this.token) {
                this.authorize();
            } else {
                console.log('⚠️  [VolatilityMonitor] Sem token - conectando sem autenticação');
                this.subscribeToTicks();
            }
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this.handleMessage(msg);
            } catch (error) {
                console.error('❌ [VolatilityMonitor] Erro ao processar mensagem:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('❌ [VolatilityMonitor] Erro no WebSocket:', error.message);
        });

        this.ws.on('close', () => {
            console.log('🔌 [VolatilityMonitor] Conexão WebSocket fechada');
            this.isConnected = false;
            this.attemptReconnect();
        });
    }

    authorize() {
        console.log('🔐 [VolatilityMonitor] Autenticando...');
        this.send({ authorize: this.token });
    }

    subscribeToTicks() {
        console.log(`📊 [VolatilityMonitor] Inscrevendo-se nos ticks de ${this.symbol}...`);
        this.send({
            ticks_history: this.symbol,
            adjust_start_time: 1,
            count: this.maxTicks,
            end: 'latest',
            subscribe: 1,
            style: 'ticks'
        });
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error('❌ [VolatilityMonitor] Erro da API:', msg.error.message);
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                console.log('✅ [VolatilityMonitor] Autorizado com sucesso');
                console.log(`   Conta: ${msg.authorize.loginid}`);
                console.log(`   Moeda: ${msg.authorize.currency}`);
                this.subscribeToTicks();
                break;

            case 'history':
                this.processHistory(msg.history);
                break;

            case 'tick':
                this.processTick(msg.tick);
                break;
        }
    }

    processHistory(history) {
        if (!history || !history.prices) {
            return;
        }

        console.log('\n📈 [VolatilityMonitor] Histórico recebido');
        
        this.ticks = history.prices.map((price, index) => ({
            value: parseFloat(price),
            epoch: history.times ? history.times[index] : Date.now() / 1000,
            timestamp: history.times ? new Date(history.times[index] * 1000).toLocaleTimeString('pt-BR') : new Date().toLocaleTimeString('pt-BR')
        }));

        this.displayTicks();
    }

    processTick(tick) {
        if (!tick || !tick.quote) {
            return;
        }

        const newTick = {
            value: parseFloat(tick.quote),
            epoch: tick.epoch || Date.now() / 1000,
            timestamp: new Date((tick.epoch || Date.now() / 1000) * 1000).toLocaleTimeString('pt-BR')
        };

        this.ticks.push(newTick);

        // Manter apenas os últimos 10 ticks
        if (this.ticks.length > this.maxTicks) {
            this.ticks.shift();
        }

        this.displayTicks(newTick);
    }

    displayTicks(currentTick = null) {
        // Limpar console para melhor visualização
        console.clear();
        
        console.log('\n╔═══════════════════════════════════════════════════════════════╗');
        console.log('║          MONITOR DE VOLATILIDADE 100 - DERIV API             ║');
        console.log('╚═══════════════════════════════════════════════════════════════╝\n');

        if (this.ticks.length === 0) {
            console.log('⏳ Aguardando dados...\n');
            return;
        }

        // Mostrar últimos 10 preços
        console.log('📊 ÚLTIMOS 10 PREÇOS:');
        console.log('─────────────────────────────────────────────────────────────────');
        
        this.ticks.forEach((tick, index) => {
            const number = (index + 1).toString().padStart(2, '0');
            const price = tick.value.toFixed(2).padStart(8);
            const time = tick.timestamp;
            
            // Calcular variação em relação ao tick anterior
            let variation = '';
            if (index > 0) {
                const diff = tick.value - this.ticks[index - 1].value;
                const diffStr = diff.toFixed(2);
                if (diff > 0) {
                    variation = `📈 +${diffStr}`;
                } else if (diff < 0) {
                    variation = `📉 ${diffStr}`;
                } else {
                    variation = `➡️  ${diffStr}`;
                }
            }
            
            console.log(`  ${number}. ${price}  [${time}]  ${variation}`);
        });

        // Mostrar preço atual destacado
        if (currentTick) {
            console.log('\n╔═══════════════════════════════════════════════════════════════╗');
            console.log('║                         PREÇO ATUAL                           ║');
            console.log('╠═══════════════════════════════════════════════════════════════╣');
            console.log(`║    ${currentTick.value.toFixed(2).padStart(10)}  [${currentTick.timestamp}]                  ║`);
            console.log('╚═══════════════════════════════════════════════════════════════╝\n');
        }

        // Estatísticas
        const values = this.ticks.map(t => t.value);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const current = values[values.length - 1];
        const first = values[0];
        const change = ((current - first) / first * 100).toFixed(2);

        console.log('📈 ESTATÍSTICAS:');
        console.log('─────────────────────────────────────────────────────────────────');
        console.log(`  Mínimo:  ${min.toFixed(2)}`);
        console.log(`  Máximo:  ${max.toFixed(2)}`);
        console.log(`  Média:   ${avg.toFixed(2)}`);
        console.log(`  Variação: ${change}%`);
        console.log('');

        // Status da conexão
        const status = this.isConnected ? '🟢 ONLINE' : '🔴 OFFLINE';
        console.log(`Status: ${status} | Ticks recebidos: ${this.ticks.length}/${this.maxTicks}`);
        console.log('─────────────────────────────────────────────────────────────────\n');
        console.log('Pressione Ctrl+C para sair\n');
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ [VolatilityMonitor] Máximo de tentativas de reconexão atingido');
            process.exit(1);
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
        
        console.log(`🔄 [VolatilityMonitor] Tentando reconectar em ${delay}ms (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect();
        }, delay);
    }

    send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    disconnect() {
        console.log('\n👋 [VolatilityMonitor] Desconectando...');
        if (this.ws) {
            this.ws.close();
        }
        this.isConnected = false;
    }
}

// Iniciar monitor
const monitor = new VolatilityMonitor();
monitor.connect();

// Tratamento de sinais para encerramento gracioso
process.on('SIGINT', () => {
    console.log('\n\n📴 Recebido sinal de interrupção (Ctrl+C)');
    monitor.disconnect();
    setTimeout(() => {
        console.log('✅ Monitor encerrado com sucesso');
        process.exit(0);
    }, 1000);
});

process.on('SIGTERM', () => {
    console.log('\n\n📴 Recebido sinal de término');
    monitor.disconnect();
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

module.exports = VolatilityMonitor;







