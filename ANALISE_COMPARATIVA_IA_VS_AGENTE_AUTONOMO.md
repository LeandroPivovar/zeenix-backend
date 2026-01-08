# 📊 Análise Comparativa: IA Orion vs Agente Autônomo

## 🎯 Resumo Executivo

**CONCLUSÃO PRINCIPAL**: O Agente Autônomo **DELEGA 100%** das operações para a IA Orion. Ele é apenas um **wrapper** que adiciona funcionalidades de gerenciamento de sessão diária.

### ✅ Por que funciona na Orion e não no Agente Autônomo?

**A resposta é simples**: Se não funciona no Agente Autônomo, **também não funciona na Orion**, pois **o Agente Autônomo USA a Orion internamente**.

---

## 🔍 Análise Detalhada

### 1. **Arquitetura de Conexão WebSocket**

#### 📌 IA Orion (Padrão Ouro)
```typescript
// Localização: src/ai/strategies/orion.strategy.ts

// ✅ POOL DE WEBSOCKETS REUTILIZÁVEL
private wsConnections: Map<
  string,
  {
    ws: WebSocket;
    authorized: boolean;
    keepAliveInterval: NodeJS.Timeout | null;
    requestIdCounter: number;
    pendingRequests: Map<string, { resolve, reject, timeout }>;
    subscriptions: Map<string, (msg: any) => void>;
  }
> = new Map();

// ✅ Método: getOrCreateWebSocketConnection(token, userId)
// - Cria UMA conexão por token
// - Reutiliza conexão existente se já estiver aberta e autorizada
// - Mantém keep-alive a cada 90 segundos
// - Gerencia fila de requisições pendentes (FIFO)
// - Gerencia subscriptions (proposal_open_contract)
```

**Características:**
- ✅ **Pool de conexões**: Uma conexão WebSocket por token Deriv
- ✅ **Reutilização**: Conexões são reutilizadas entre operações
- ✅ **Keep-alive**: Ping automático a cada 90 segundos
- ✅ **Autorização**: Autoriza uma vez e reutiliza
- ✅ **Fila de requisições**: Gerencia múltiplas requisições simultâneas
- ✅ **Subscriptions**: Monitora contratos em tempo real

#### 📌 Agente Autônomo
```typescript
// Localização: src/autonomous-agent/strategies/orion.strategy.ts

// ✅ DELEGA 100% PARA A ORION
async processTick(tick: Tick): Promise<void> {
  // Processar via Orion Strategy (ela já gerencia tudo)
  if (this.orionStrategy) {
    await this.orionStrategy.processTick(tick, 'R_100');
  }
}

// ✅ ATIVA USUÁRIO NA ORION
private async activateUserInOrion(userId: string, config: AutonomousAgentConfig) {
  const orionConfig = {
    mode: this.mapTradingModeToOrionMode(config.tradingMode),
    stakeAmount: config.initialBalance || config.initialStake,
    derivToken: config.derivToken,
    currency: config.currency,
    modoMartingale: 'moderado' as const,
    entryValue: config.initialStake,
  };

  await this.orionStrategy.activateUser(userId, orionConfig);
}
```

**Características:**
- ✅ **Wrapper puro**: Não tem lógica própria de WebSocket
- ✅ **Delega tudo**: Usa `orionStrategy.processTick()` e `orionStrategy.activateUser()`
- ✅ **Mesma infraestrutura**: Usa o mesmo pool de WebSockets da Orion
- ✅ **Gerenciamento de sessão**: Adiciona apenas controle de sessão diária (daily_profit_target, daily_loss_limit)

---

### 2. **Fluxo de Compra de Contratos**

#### 📌 IA Orion

```typescript
// PASSO 1: Obter/Criar conexão WebSocket reutilizável
const connection = await this.getOrCreateWebSocketConnection(token, userId);

// PASSO 2: Solicitar proposta
const proposalResponse = await connection.sendRequest({
  proposal: 1,
  amount: contractParams.amount,
  basis: 'stake',
  contract_type: contractParams.contract_type, // DIGITEVEN ou DIGITODD
  currency: contractParams.currency || 'USD',
  duration: 1,
  duration_unit: 't',
  symbol: this.symbol, // R_100
}, 60000);

// PASSO 3: Comprar contrato
const buyResponse = await connection.sendRequest({
  buy: proposalId,
  price: proposalPrice,
}, 60000);

// PASSO 4: Monitorar contrato (subscribe)
await connection.subscribe(
  {
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  },
  (msg: any) => {
    // Callback para atualizações do contrato
    if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
      // Contrato finalizado
      resolve({ contractId, profit, exitSpot });
    }
  },
  contractId,
  90000
);
```

**Características:**
- ✅ **Conexão reutilizável**: Mesma conexão para proposta, compra e monitoramento
- ✅ **Autorização única**: Autoriza uma vez e reutiliza
- ✅ **Fila de requisições**: Gerencia múltiplas requisições (proposal, buy) em fila FIFO
- ✅ **Subscriptions separadas**: Monitora contratos via subscription independente
- ✅ **Timeout configurável**: 60s para proposta/compra, 90s para monitoramento

#### 📌 Agente Autônomo

```typescript
// ❌ NÃO TEM LÓGICA PRÓPRIA DE COMPRA
// ✅ USA A ORION INTERNAMENTE

// O agente autônomo apenas chama:
await this.orionStrategy.processTick(tick, 'R_100');

// E a Orion executa tudo internamente via:
await this.executeOrionOperation(state, operation, mode, entry);
  └─> await this.executeOrionTradeViaWebSocket(token, contractParams, userId);
      └─> const connection = await this.getOrCreateWebSocketConnection(token, userId);
          └─> [MESMA LÓGICA DA ORION]
```

**Características:**
- ✅ **Usa a mesma infraestrutura**: Pool de WebSockets da Orion
- ✅ **Mesma lógica de compra**: `executeOrionTradeViaWebSocket()`
- ✅ **Mesma lógica de monitoramento**: Subscriptions via `connection.subscribe()`

---

### 3. **Gerenciamento de Pool de WebSocket**

#### 📌 Comparação

| Aspecto | IA Orion | Agente Autônomo |
|---------|----------|-----------------|
| **Pool de conexões** | ✅ Sim (`wsConnections` Map) | ✅ **USA O MESMO** da Orion |
| **Reutilização** | ✅ Uma conexão por token | ✅ **USA O MESMO** da Orion |
| **Keep-alive** | ✅ Ping a cada 90s | ✅ **USA O MESMO** da Orion |
| **Autorização** | ✅ Uma vez por conexão | ✅ **USA O MESMO** da Orion |
| **Fila de requisições** | ✅ FIFO com Map | ✅ **USA O MESMO** da Orion |
| **Subscriptions** | ✅ Map por contractId | ✅ **USA O MESMO** da Orion |

**CONCLUSÃO**: O Agente Autônomo **NÃO TEM** pool próprio. Ele usa **100% o pool da Orion**.

---

### 4. **Diferenças Reais**

#### 📌 O que o Agente Autônomo ADICIONA?

```typescript
// 1. Gerenciamento de sessão diária
async onContractFinish(userId, result) {
  // Atualizar lucro/perda diária
  if (newLoss >= config.dailyLossLimit) {
    sessionStatus = 'stopped_loss';
    // Desativar na Orion Strategy
    await this.orionStrategy.deactivateUser(userId);
  } else if (newProfit >= config.dailyProfitTarget) {
    sessionStatus = 'stopped_profit';
    // Desativar na Orion Strategy
    await this.orionStrategy.deactivateUser(userId);
  }
}

// 2. Reset de sessão diária
async resetDailySession(userId) {
  // Resetar lucro/perda diária
  // Reativar na Orion Strategy
  await this.activateUserInOrion(userId, config);
}
```

**Funcionalidades exclusivas:**
- ✅ **daily_profit_target**: Meta de lucro diária (para no dia)
- ✅ **daily_loss_limit**: Limite de perda diária (para no dia)
- ✅ **session_status**: 'active', 'stopped_loss', 'stopped_profit', 'stopped_blindado'
- ✅ **session_date**: Data da sessão (reseta no próximo dia)
- ✅ **Reset automático**: Reseta sessão no próximo dia

#### 📌 O que o Agente Autônomo NÃO MUDA?

- ❌ **Lógica de sinais**: Usa `check_signal()` da Orion
- ❌ **Lógica de martingale**: Usa `calcularProximaAposta()` da Orion
- ❌ **Lógica de Soros**: Usa `calcularApostaComSoros()` da Orion
- ❌ **Lógica de stop loss/win**: Usa RiskManager da Orion
- ❌ **Lógica de WebSocket**: Usa pool da Orion
- ❌ **Lógica de compra**: Usa `executeOrionTradeViaWebSocket()` da Orion

---

## 🚨 Diagnóstico de Problemas

### ❓ Por que não funciona no Agente Autônomo?

**Resposta**: Se não funciona no Agente Autônomo, **também não funciona na Orion**, pois:

1. **Mesma conexão WebSocket**: Usa o mesmo pool da Orion
2. **Mesma lógica de compra**: Usa `executeOrionTradeViaWebSocket()` da Orion
3. **Mesma lógica de monitoramento**: Usa subscriptions da Orion
4. **Mesma autorização**: Usa `getOrCreateWebSocketConnection()` da Orion

### 🔍 Possíveis Causas de Erro

#### 1. **Erro de Autorização**
```typescript
// Verificar se o token está correto
const authPayload = { authorize: token };
socket.send(JSON.stringify(authPayload));

// Aguardar resposta de autorização
if (msg.msg_type === 'authorize') {
  if (msg.error) {
    // ❌ Token inválido ou expirado
  } else {
    conn.authorized = true; // ✅ Autorizado
  }
}
```

**Sintomas:**
- ❌ Erro: "Conexão WebSocket não está disponível ou autorizada"
- ❌ Erro: "Unauthorized"
- ❌ Conexão fecha imediatamente após abertura

**Soluções:**
- ✅ Verificar se o token Deriv está correto e ativo
- ✅ Verificar se o token tem permissões de trading
- ✅ Verificar se o token não expirou

#### 2. **Erro de Proposta**
```typescript
const proposalResponse = await connection.sendRequest({
  proposal: 1,
  amount: contractParams.amount, // ❌ Valor muito baixo (<0.35)?
  basis: 'stake',
  contract_type: contractParams.contract_type, // ❌ DIGITEVEN ou DIGITODD correto?
  currency: contractParams.currency || 'USD', // ❌ Moeda correta?
  duration: 1,
  duration_unit: 't',
  symbol: this.symbol, // ❌ R_100 correto?
}, 60000);

if (proposalResponse.error) {
  // ❌ Erro na proposta
  // Exemplos: InsufficientBalance, InvalidContractType, RateLimit
}
```

**Sintomas:**
- ❌ Erro: "InsufficientBalance" (saldo insuficiente)
- ❌ Erro: "InvalidContractType" (tipo de contrato inválido)
- ❌ Erro: "RateLimit" (limite de taxa atingido)
- ❌ Erro: "WrongResponse" (erro temporário da Deriv)

**Soluções:**
- ✅ Verificar saldo na conta Deriv
- ✅ Verificar se o tipo de contrato está correto (DIGITEVEN/DIGITODD)
- ✅ Verificar se o valor da aposta é >= $0.35
- ✅ Adicionar retry com backoff exponencial para WrongResponse

#### 3. **Erro de Compra**
```typescript
const buyResponse = await connection.sendRequest({
  buy: proposalId,
  price: proposalPrice,
}, 60000);

if (buyResponse.error) {
  // ❌ Erro na compra
  // Exemplos: ProposalExpired, InsufficientBalance
}
```

**Sintomas:**
- ❌ Erro: "ProposalExpired" (proposta expirou)
- ❌ Erro: "InsufficientBalance" (saldo insuficiente)
- ❌ Timeout ao comprar contrato

**Soluções:**
- ✅ Reduzir tempo entre proposta e compra
- ✅ Verificar saldo antes de comprar
- ✅ Adicionar retry para ProposalExpired

#### 4. **Erro de Monitoramento**
```typescript
await connection.subscribe(
  {
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  },
  (msg: any) => {
    if (msg.error) {
      // ❌ Erro na subscription
    }
    
    const contract = msg.proposal_open_contract;
    if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
      // ✅ Contrato finalizado
    }
  },
  contractId,
  90000
);
```

**Sintomas:**
- ❌ Timeout ao monitorar contrato (90s)
- ❌ Contrato não finaliza
- ❌ Callback nunca é chamado

**Soluções:**
- ✅ Verificar se a subscription foi criada corretamente
- ✅ Verificar se o contractId está correto
- ✅ Aumentar timeout se necessário
- ✅ Adicionar logs para debug

#### 5. **Erro de Pool de WebSocket**
```typescript
// ❌ Conexão não está no pool
const conn = this.wsConnections.get(token);
if (!conn) {
  throw new Error('Conexão não encontrada no pool');
}

// ❌ Conexão não está aberta
if (conn.ws.readyState !== WebSocket.OPEN) {
  throw new Error('Conexão WebSocket não está aberta');
}

// ❌ Conexão não está autorizada
if (!conn.authorized) {
  throw new Error('Conexão WebSocket não está autorizada');
}
```

**Sintomas:**
- ❌ Erro: "Conexão WebSocket não está disponível ou autorizada"
- ❌ Erro: "Conexão não encontrada no pool"
- ❌ Conexão fecha inesperadamente

**Soluções:**
- ✅ Verificar se a conexão foi criada corretamente
- ✅ Verificar se a autorização foi bem-sucedida
- ✅ Adicionar reconexão automática
- ✅ Adicionar logs para debug

---

## 🔧 Recomendações

### 1. **Adicionar Logs Detalhados**

```typescript
// Adicionar logs em cada etapa
this.logger.debug(`[ORION] 📤 Solicitando proposta...`);
this.logger.debug(`[ORION] 📊 Proposta recebida: ${proposalId}`);
this.logger.debug(`[ORION] 💰 Comprando contrato...`);
this.logger.debug(`[ORION] ✅ Contrato criado: ${contractId}`);
this.logger.debug(`[ORION] 👁️ Monitorando contrato...`);
this.logger.debug(`[ORION] ✅ Contrato finalizado: ${profit}`);
```

### 2. **Adicionar Retry com Backoff Exponencial**

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = baseDelay * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

// Uso:
const proposalResponse = await retryWithBackoff(
  () => connection.sendRequest({ proposal: 1, ... }),
  3,
  1000
);
```

### 3. **Adicionar Validações Preventivas**

```typescript
// Validar saldo antes de criar proposta
if (state.capital < stakeAmount * 1.1) {
  throw new Error('Saldo insuficiente');
}

// Validar token antes de criar conexão
if (!token || token.trim() === '') {
  throw new Error('Token Deriv inválido');
}

// Validar valor da aposta
if (stakeAmount < 0.35) {
  throw new Error('Valor da aposta abaixo do mínimo ($0.35)');
}
```

### 4. **Adicionar Reconexão Automática**

```typescript
// Reconectar se a conexão cair
socket.on('close', () => {
  this.logger.warn(`[ORION] 🔌 Conexão fechada. Reconectando...`);
  this.wsConnections.delete(token);
  
  // Tentar reconectar após 5 segundos
  setTimeout(async () => {
    try {
      await this.getOrCreateWebSocketConnection(token, userId);
      this.logger.log(`[ORION] ✅ Reconectado com sucesso`);
    } catch (error) {
      this.logger.error(`[ORION] ❌ Erro ao reconectar:`, error);
    }
  }, 5000);
});
```

---

## 📝 Conclusão

### ✅ Fatos Comprovados

1. **Agente Autônomo = Wrapper da Orion**
   - Delega 100% das operações para a IA Orion
   - Usa o mesmo pool de WebSockets
   - Usa a mesma lógica de compra e monitoramento

2. **Mesma Infraestrutura**
   - Pool de conexões WebSocket reutilizável
   - Autorização única por token
   - Fila de requisições FIFO
   - Subscriptions para monitoramento

3. **Diferenças Reais**
   - Agente Autônomo adiciona apenas gerenciamento de sessão diária
   - daily_profit_target, daily_loss_limit, session_status
   - Reset automático de sessão no próximo dia

### 🚨 Diagnóstico

**Se não funciona no Agente Autônomo, também não funciona na Orion**, pois:
- Usa a mesma conexão WebSocket
- Usa a mesma lógica de compra
- Usa a mesma lógica de monitoramento

**Possíveis causas:**
1. ❌ Token Deriv inválido ou expirado
2. ❌ Saldo insuficiente na conta Deriv
3. ❌ Erro de autorização
4. ❌ Erro de proposta (InsufficientBalance, InvalidContractType, RateLimit)
5. ❌ Erro de compra (ProposalExpired, InsufficientBalance)
6. ❌ Erro de monitoramento (Timeout, Subscription não criada)
7. ❌ Erro de pool de WebSocket (Conexão não encontrada, não autorizada)

### 🔧 Próximos Passos

1. **Adicionar logs detalhados** em cada etapa (proposta, compra, monitoramento)
2. **Verificar token Deriv** (válido, ativo, com permissões de trading)
3. **Verificar saldo** na conta Deriv
4. **Adicionar retry** com backoff exponencial para erros temporários
5. **Adicionar validações** preventivas (saldo, token, valor da aposta)
6. **Adicionar reconexão** automática se a conexão cair
7. **Testar com logs** para identificar exatamente onde está falhando

---

## 📊 Tabela Comparativa Final

| Aspecto | IA Orion | Agente Autônomo |
|---------|----------|-----------------|
| **Pool de WebSocket** | ✅ Próprio | ✅ **USA O MESMO** |
| **Autorização** | ✅ Uma vez por token | ✅ **USA O MESMO** |
| **Proposta** | ✅ `sendRequest()` | ✅ **USA O MESMO** |
| **Compra** | ✅ `sendRequest()` | ✅ **USA O MESMO** |
| **Monitoramento** | ✅ `subscribe()` | ✅ **USA O MESMO** |
| **Geração de sinais** | ✅ `check_signal()` | ✅ **USA O MESMO** |
| **Martingale** | ✅ `calcularProximaAposta()` | ✅ **USA O MESMO** |
| **Soros** | ✅ `calcularApostaComSoros()` | ✅ **USA O MESMO** |
| **Stop Loss/Win** | ✅ RiskManager | ✅ **USA O MESMO** |
| **Sessão Diária** | ❌ Não tem | ✅ **ADICIONA** |
| **Reset Diário** | ❌ Não tem | ✅ **ADICIONA** |

**CONCLUSÃO FINAL**: O Agente Autônomo é um **wrapper puro** da IA Orion. Se há problemas de conexão ou compra de contratos, **o problema está na Orion**, não no Agente Autônomo.
