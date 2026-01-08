# 🔍 Guia de Debugging: Conexões WebSocket e Compra de Contratos

## 🎯 Objetivo

Este guia fornece um passo a passo para diagnosticar e resolver problemas de conexão WebSocket e compra de contratos na Orion (IA e Agente Autônomo).

---

## 📋 Checklist de Diagnóstico

### 1. ✅ Verificar Token Deriv

```sql
-- Verificar token no banco de dados
SELECT user_id, deriv_token, is_active, currency
FROM ai_user_config
WHERE user_id = 'SEU_USER_ID';

-- Verificar token do agente autônomo
SELECT user_id, deriv_token, is_active, currency
FROM autonomous_agent_config
WHERE user_id = 'SEU_USER_ID';
```

**Validações:**
- [ ] Token não está vazio
- [ ] Token tem formato correto (começa com letras e números)
- [ ] Token tem permissões de trading na Deriv
- [ ] Token não expirou

**Como testar o token manualmente:**
```bash
# Testar autorização via WebSocket
wscat -c "wss://ws.derivws.com/websockets/v3?app_id=111346"
> {"authorize": "SEU_TOKEN_AQUI"}

# Resposta esperada:
< {"authorize": {"loginid": "...", "balance": "...", ...}}

# Se houver erro:
< {"error": {"code": "...", "message": "..."}}
```

---

### 2. ✅ Verificar Saldo na Deriv

```sql
-- Verificar capital configurado
SELECT user_id, stake_amount, session_balance, loss_limit, profit_target
FROM ai_user_config
WHERE user_id = 'SEU_USER_ID';
```

**Validações:**
- [ ] Saldo na Deriv >= stake_amount configurado
- [ ] Saldo >= valor mínimo ($0.35)
- [ ] Saldo >= valor da aposta + margem (10%)

**Como verificar saldo via API:**
```bash
wscat -c "wss://ws.derivws.com/websockets/v3?app_id=111346"
> {"authorize": "SEU_TOKEN_AQUI"}
> {"balance": 1, "subscribe": 1}

# Resposta:
< {"balance": {"balance": "100.00", "currency": "USD", ...}}
```

---

### 3. ✅ Verificar Logs de Conexão WebSocket

**Adicionar logs temporários na Orion:**

```typescript
// Em: src/ai/strategies/orion.strategy.ts
// Método: getOrCreateWebSocketConnection()

this.logger.log(`[DEBUG] 🔌 Tentando conectar WebSocket | Token: ${token.substring(0, 8)}...`);
this.logger.log(`[DEBUG] 📊 Pool atual: ${this.wsConnections.size} conexões`);

// Após conexão aberta
this.logger.log(`[DEBUG] ✅ WebSocket conectado | ReadyState: ${socket.readyState}`);

// Após autorização
this.logger.log(`[DEBUG] ✅ Autorizado | LoginID: ${msg.authorize?.loginid}`);

// Ao enviar requisição
this.logger.debug(`[DEBUG] 📤 Enviando requisição: ${JSON.stringify(payload)}`);

// Ao receber resposta
this.logger.debug(`[DEBUG] 📥 Resposta recebida: ${JSON.stringify(msg)}`);
```

**Verificar logs no console:**
```bash
# Filtrar logs de WebSocket
grep "WebSocket" logs/backend.log

# Filtrar logs de autorização
grep "Autorizado" logs/backend.log

# Filtrar logs de erro
grep "ERROR" logs/backend.log | grep -i "websocket\|deriv\|contract"
```

---

### 4. ✅ Verificar Fluxo de Compra de Contrato

**Adicionar logs em cada etapa:**

```typescript
// Em: src/ai/strategies/orion.strategy.ts
// Método: executeOrionTradeViaWebSocket()

// PASSO 1: Conexão
this.logger.log(`[DEBUG] 🔌 PASSO 1: Obtendo conexão WebSocket`);
const connection = await this.getOrCreateWebSocketConnection(token, userId);
this.logger.log(`[DEBUG] ✅ PASSO 1: Conexão obtida`);

// PASSO 2: Proposta
this.logger.log(`[DEBUG] 📤 PASSO 2: Solicitando proposta | Tipo: ${contractParams.contract_type} | Valor: $${contractParams.amount}`);
const proposalResponse = await connection.sendRequest({ ... });
this.logger.log(`[DEBUG] ✅ PASSO 2: Proposta recebida | ID: ${proposalId} | Preço: $${proposalPrice}`);

// PASSO 3: Compra
this.logger.log(`[DEBUG] 💰 PASSO 3: Comprando contrato | ProposalId: ${proposalId}`);
const buyResponse = await connection.sendRequest({ buy: proposalId, price: proposalPrice });
this.logger.log(`[DEBUG] ✅ PASSO 3: Contrato comprado | ContractId: ${contractId}`);

// PASSO 4: Monitoramento
this.logger.log(`[DEBUG] 👁️ PASSO 4: Monitorando contrato | ContractId: ${contractId}`);
await connection.subscribe({ ... }, (msg) => {
  this.logger.debug(`[DEBUG] 📊 Atualização do contrato: is_sold=${contract.is_sold}, status=${contract.status}, profit=${contract.profit}`);
});
this.logger.log(`[DEBUG] ✅ PASSO 4: Contrato finalizado | Profit: $${profit}`);
```

---

### 5. ✅ Verificar Erros Comuns

#### Erro: "Conexão WebSocket não está disponível ou autorizada"

**Causa:**
- Conexão não foi criada
- Conexão não está aberta (readyState !== OPEN)
- Conexão não foi autorizada

**Solução:**
```typescript
// Verificar estado da conexão
const conn = this.wsConnections.get(token);
if (!conn) {
  this.logger.error(`[DEBUG] ❌ Conexão não encontrada no pool | Token: ${token.substring(0, 8)}`);
  // Criar nova conexão
  await this.getOrCreateWebSocketConnection(token, userId);
}

if (conn.ws.readyState !== WebSocket.OPEN) {
  this.logger.error(`[DEBUG] ❌ Conexão não está aberta | ReadyState: ${conn.ws.readyState}`);
  // Remover conexão inválida e criar nova
  this.wsConnections.delete(token);
  await this.getOrCreateWebSocketConnection(token, userId);
}

if (!conn.authorized) {
  this.logger.error(`[DEBUG] ❌ Conexão não está autorizada`);
  // Aguardar autorização ou criar nova conexão
}
```

#### Erro: "InsufficientBalance"

**Causa:**
- Saldo na Deriv < valor da aposta
- Saldo na Deriv < valor mínimo ($0.35)

**Solução:**
```typescript
// Verificar saldo antes de criar proposta
const balanceResponse = await connection.sendRequest({ balance: 1 });
const balance = parseFloat(balanceResponse.balance?.balance || '0');

if (balance < stakeAmount) {
  this.logger.error(`[DEBUG] ❌ Saldo insuficiente | Saldo: $${balance} | Necessário: $${stakeAmount}`);
  throw new Error('Saldo insuficiente na Deriv');
}
```

#### Erro: "ProposalExpired"

**Causa:**
- Proposta expirou antes da compra
- Tempo entre proposta e compra muito longo

**Solução:**
```typescript
// Reduzir tempo entre proposta e compra
const proposalResponse = await connection.sendRequest({ proposal: 1, ... }, 30000); // Reduzir timeout
const buyResponse = await connection.sendRequest({ buy: proposalId, price: proposalPrice }, 30000);

// Ou adicionar retry
try {
  const buyResponse = await connection.sendRequest({ buy: proposalId, price: proposalPrice });
} catch (error) {
  if (error.message.includes('ProposalExpired')) {
    this.logger.warn(`[DEBUG] ⚠️ Proposta expirou. Tentando novamente...`);
    // Solicitar nova proposta
    const newProposalResponse = await connection.sendRequest({ proposal: 1, ... });
    const newBuyResponse = await connection.sendRequest({ buy: newProposalId, price: newProposalPrice });
  }
}
```

#### Erro: "RateLimit"

**Causa:**
- Muitas requisições em pouco tempo
- Limite de taxa da Deriv atingido

**Solução:**
```typescript
// Adicionar delay entre operações
await new Promise(resolve => setTimeout(resolve, 1000)); // 1 segundo

// Ou adicionar retry com backoff exponencial
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.message.includes('RateLimit')) {
        const delay = baseDelay * Math.pow(2, i);
        this.logger.warn(`[DEBUG] ⚠️ Rate limit atingido. Aguardando ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries exceeded');
}
```

#### Erro: "WrongResponse"

**Causa:**
- Erro temporário da Deriv
- Resposta inesperada da API

**Solução:**
```typescript
// Adicionar retry para WrongResponse
try {
  const proposalResponse = await connection.sendRequest({ proposal: 1, ... });
} catch (error) {
  if (error.message.includes('WrongResponse')) {
    this.logger.warn(`[DEBUG] ⚠️ WrongResponse. Tentando novamente em 2s...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const proposalResponse = await connection.sendRequest({ proposal: 1, ... });
  }
}
```

---

### 6. ✅ Verificar Pool de WebSocket

**Adicionar logs do pool:**

```typescript
// Método para debug do pool
private debugPool(): void {
  this.logger.log(`[DEBUG] 📊 Pool de WebSockets: ${this.wsConnections.size} conexões`);
  
  for (const [token, conn] of this.wsConnections.entries()) {
    this.logger.log(`[DEBUG] 🔌 Token: ${token.substring(0, 8)}... | ReadyState: ${conn.ws.readyState} | Autorizado: ${conn.authorized} | Requisições pendentes: ${conn.pendingRequests.size} | Subscriptions: ${conn.subscriptions.size}`);
  }
}

// Chamar antes de cada operação
this.debugPool();
```

**Verificar estado do pool:**
- [ ] Conexão existe no pool
- [ ] ReadyState === WebSocket.OPEN (1)
- [ ] authorized === true
- [ ] Requisições pendentes < 10 (evitar sobrecarga)
- [ ] Subscriptions ativas < 50 (evitar sobrecarga)

---

### 7. ✅ Verificar Monitoramento de Contratos

**Adicionar logs de monitoramento:**

```typescript
// Em: executeOrionTradeViaWebSocket()
// Callback de subscription

connection.subscribe(
  { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
  (msg: any) => {
    this.logger.debug(`[DEBUG] 📊 Atualização #${updateCount} | ContractId: ${contractId}`);
    
    const contract = msg.proposal_open_contract;
    if (!contract) {
      this.logger.warn(`[DEBUG] ⚠️ Mensagem sem proposal_open_contract: ${JSON.stringify(msg)}`);
      return;
    }
    
    this.logger.debug(`[DEBUG] 📊 Status: ${contract.status} | is_sold: ${contract.is_sold} | profit: ${contract.profit}`);
    
    const isFinalized = contract.is_sold === 1 || contract.status === 'won' || contract.status === 'lost';
    if (isFinalized) {
      this.logger.log(`[DEBUG] ✅ Contrato finalizado | Status: ${contract.status} | Profit: $${contract.profit}`);
    }
  },
  contractId,
  90000
);
```

**Verificar:**
- [ ] Subscription foi criada (sem erro)
- [ ] Callback está sendo chamado
- [ ] Mensagens estão chegando
- [ ] Contrato está finalizando (is_sold ou status)

---

## 🔧 Script de Teste Completo

```typescript
// test-websocket.ts
import WebSocket from 'ws';

async function testDerivWebSocket(token: string) {
  console.log('🔌 Conectando ao WebSocket da Deriv...');
  
  const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=111346');
  
  ws.on('open', () => {
    console.log('✅ Conectado!');
    console.log('🔐 Enviando autorização...');
    ws.send(JSON.stringify({ authorize: token }));
  });
  
  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('📥 Mensagem recebida:', JSON.stringify(msg, null, 2));
    
    // Autorização
    if (msg.msg_type === 'authorize') {
      if (msg.error) {
        console.error('❌ Erro na autorização:', msg.error);
        ws.close();
        return;
      }
      
      console.log('✅ Autorizado! LoginID:', msg.authorize.loginid);
      console.log('💰 Saldo:', msg.authorize.balance, msg.authorize.currency);
      
      // Solicitar proposta
      console.log('📤 Solicitando proposta...');
      ws.send(JSON.stringify({
        proposal: 1,
        amount: 0.35,
        basis: 'stake',
        contract_type: 'DIGITEVEN',
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: 'R_100',
      }));
    }
    
    // Proposta
    if (msg.proposal) {
      if (msg.error) {
        console.error('❌ Erro na proposta:', msg.error);
        ws.close();
        return;
      }
      
      console.log('✅ Proposta recebida!');
      console.log('📊 ID:', msg.proposal.id);
      console.log('💵 Preço:', msg.proposal.ask_price);
      
      // Comprar contrato
      console.log('💰 Comprando contrato...');
      ws.send(JSON.stringify({
        buy: msg.proposal.id,
        price: msg.proposal.ask_price,
      }));
    }
    
    // Compra
    if (msg.buy) {
      if (msg.error) {
        console.error('❌ Erro na compra:', msg.error);
        ws.close();
        return;
      }
      
      console.log('✅ Contrato comprado!');
      console.log('🎫 ContractId:', msg.buy.contract_id);
      
      // Monitorar contrato
      console.log('👁️ Monitorando contrato...');
      ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: msg.buy.contract_id,
        subscribe: 1,
      }));
    }
    
    // Monitoramento
    if (msg.proposal_open_contract) {
      const contract = msg.proposal_open_contract;
      console.log('📊 Atualização do contrato:');
      console.log('   Status:', contract.status);
      console.log('   is_sold:', contract.is_sold);
      console.log('   profit:', contract.profit);
      
      if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
        console.log('✅ Contrato finalizado!');
        console.log('💰 Profit:', contract.profit);
        console.log('📊 Status:', contract.status);
        ws.close();
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ Erro no WebSocket:', error);
  });
  
  ws.on('close', () => {
    console.log('🔌 Conexão fechada');
  });
}

// Executar teste
const token = 'SEU_TOKEN_AQUI';
testDerivWebSocket(token);
```

**Como executar:**
```bash
# Instalar dependências
npm install ws @types/ws

# Executar teste
npx ts-node test-websocket.ts
```

---

## 📊 Tabela de Diagnóstico

| Sintoma | Causa Provável | Solução |
|---------|----------------|---------|
| "Conexão WebSocket não está disponível" | Conexão não foi criada ou não está aberta | Verificar pool, criar nova conexão |
| "Unauthorized" | Token inválido ou expirado | Verificar token, obter novo token |
| "InsufficientBalance" | Saldo insuficiente na Deriv | Adicionar saldo ou reduzir stake |
| "ProposalExpired" | Proposta expirou antes da compra | Reduzir tempo entre proposta e compra, adicionar retry |
| "RateLimit" | Muitas requisições em pouco tempo | Adicionar delay, retry com backoff |
| "WrongResponse" | Erro temporário da Deriv | Adicionar retry |
| Timeout ao monitorar contrato | Subscription não foi criada ou callback não está sendo chamado | Verificar logs, aumentar timeout |
| Contrato não finaliza | Subscription não está recebendo atualizações | Verificar logs, recriar subscription |

---

## 🎯 Próximos Passos

1. **Executar script de teste** para verificar se o token e a conexão funcionam
2. **Adicionar logs detalhados** em cada etapa do fluxo de compra
3. **Verificar logs** para identificar exatamente onde está falhando
4. **Aplicar soluções** específicas para cada erro encontrado
5. **Testar novamente** e verificar se o problema foi resolvido

---

## 📝 Notas Importantes

- **Agente Autônomo usa a mesma infraestrutura da Orion**: Se há problemas no Agente Autônomo, também haverá na Orion
- **Pool de WebSockets é compartilhado**: Uma conexão por token, reutilizada entre operações
- **Autorização é única**: Autoriza uma vez e reutiliza a conexão
- **Fila de requisições é FIFO**: Requisições são processadas na ordem de chegada
- **Subscriptions são independentes**: Cada contrato tem sua própria subscription

---

## 🔗 Recursos Úteis

- [Documentação da Deriv API](https://api.deriv.com/)
- [WebSocket API Reference](https://api.deriv.com/api-explorer)
- [Deriv Community](https://community.deriv.com/)
