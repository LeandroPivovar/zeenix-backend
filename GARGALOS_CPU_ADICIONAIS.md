# Gargalos de CPU Adicionais Identificados
## Análise Complementar de Performance

**Data:** 2025-01-XX  
**Status:** 🔴 ANÁLISE CRÍTICA  
**Prioridade:** ALTA

---

## 📋 RESUMO EXECUTIVO

Além dos gargalos já identificados no agente autônomo e nas estratégias de IA, foram encontrados **outros pontos críticos** que podem estar contribuindo para o alto uso de CPU:

1. 🔴 **Scheduler de IA rodando a cada 10 segundos** (ainda muito frequente)
2. 🔴 **Processamento de ticks em múltiplas estratégias simultaneamente**
3. 🔴 **Loops processando TODOS os usuários a cada tick recebido**
4. 🟡 **LogQueueService com cron a cada 5 segundos**
5. 🟡 **Múltiplos keep-alive intervals de WebSocket**
6. 🟡 **Processamento de arrays grandes sem otimização**

---

## 🔴 PROBLEMAS CRÍTICOS IDENTIFICADOS

### 1. **Scheduler de IA Fast Mode - A cada 10 segundos** ⚠️ CRÍTICO

**Localização:** `backend/src/ai/ai.scheduler.ts` (linha 47)

**Problema:**
```typescript
@Cron('*/10 * * * * *', {
  name: 'process-fast-mode-ais',
})
async handleFastModeAIs() {
  await this.aiService.processFastModeUsers();
}
```

**Impacto:**
- Executa **6 vezes por minuto** (a cada 10 segundos)
- Processa TODOS os usuários em modo fast
- Se houver 20 usuários, são **120 processamentos por minuto**
- **CPU constantemente ocupada** com processamento de scheduler

**Solução Recomendada:**
```typescript
// Aumentar intervalo para 15-20 segundos
@Cron('*/15 * * * * *', {
  name: 'process-fast-mode-ais',
})
```

**Redução Esperada:** 33-50% menos execuções do scheduler

---

### 2. **Processamento de Ticks em Múltiplas Estratégias Simultaneamente** ⚠️ CRÍTICO

**Localização:** `backend/src/ai/strategies/strategy-manager.service.ts` (linha 48)

**Problema:**
```typescript
async processTick(tick: Tick, symbol?: string): Promise<void> {
  // Processa TODAS as estratégias em paralelo para cada tick
  await Promise.all([
    this.orionStrategy.processTick(tick, 'R_100').catch(...),
    this.apolloStrategy.processTick(tick, 'R_100').catch(...),
    this.titanStrategy.processTick(tick, 'R_100').catch(...),
    this.nexusStrategy.processTick(tick, 'R_100').catch(...),
    this.atlasStrategy.processTick(tick, symbol).catch(...),
  ]);
}
```

**Impacto:**
- **Cada tick recebido** (a cada 1-2 segundos) processa **5 estratégias diferentes**
- Cada estratégia processa **todos os seus usuários ativos**
- Se há 10 usuários por estratégia = **50 processamentos por tick**
- Com ticks a cada 1 segundo = **3000 processamentos por minuto**

**Solução Recomendada:**
```typescript
// Processar apenas estratégias que têm usuários ativos
async processTick(tick: Tick, symbol?: string): Promise<void> {
  const strategiesToProcess = [];
  
  if (this.orionStrategy.hasActiveUsers()) {
    strategiesToProcess.push(this.orionStrategy.processTick(tick, 'R_100'));
  }
  if (this.apolloStrategy.hasActiveUsers()) {
    strategiesToProcess.push(this.apolloStrategy.processTick(tick, 'R_100'));
  }
  // ... outras estratégias
  
  if (strategiesToProcess.length > 0) {
    await Promise.all(strategiesToProcess.map(p => p.catch(...)));
  }
}
```

**Redução Esperada:** 60-80% menos processamento quando estratégias estão inativas

---

### 3. **Loops Processando TODOS os Usuários a Cada Tick** ⚠️ CRÍTICO

**Localização:** `backend/src/ai/strategies/orion.strategy.ts` (linhas 438-473, 840-940)

**Problema:**
```typescript
async processTick(tick: Tick, symbol?: string): Promise<void> {
  // Processa TODOS os modos em paralelo
  await Promise.all([
    this.processVelozStrategies(tick),
    this.processModeradoStrategies(tick),
    this.processPrecisoStrategies(tick),
    this.processLentaStrategies(tick),
  ]);
  
  // Incrementa ticks para TODOS os usuários
  for (const state of this.velozUsers.values()) state.ticksColetados++;
  for (const state of this.moderadoUsers.values()) state.ticksColetados++;
  for (const state of this.precisoUsers.values()) state.ticksColetados++;
  for (const state of this.lentaUsers.values()) state.ticksColetados++;
}

private async processVelozStrategies(latestTick: Tick): Promise<void> {
  // ❌ PROBLEMA: Loop processando TODOS os usuários veloz a cada tick
  for (const [userId, state] of this.velozUsers.entries()) {
    // Verifica se coletou amostra suficiente
    if (state.ticksColetados < VELOZ_CONFIG.amostraInicial) {
      // Logs e verificações mesmo quando não precisa processar
      continue;
    }
    
    // Verifica se operação está ativa
    if (state.isOperationActive) {
      continue; // Pula, mas já gastou CPU verificando
    }
    
    // Gera sinal (cálculos pesados)
    const sinal = this.check_signal(state, modoSinal, riskManager);
    
    // Executa operação
    await this.executeOrionOperation(state, sinal, 'veloz', entryNumber);
  }
}
```

**Impacto:**
- **Cada tick** (1-2 segundos) processa **TODOS os usuários** de **TODOS os modos**
- Se há 20 usuários distribuídos em 4 modos = **80 processamentos por tick**
- Com ticks a cada 1 segundo = **4800 processamentos por minuto**
- **CPU constantemente ocupada** processando loops
- **Muitos usuários são processados mesmo quando não precisam** (ainda coletando amostra, operação ativa, etc.)

**Solução Recomendada:**
```typescript
// Processar apenas usuários que precisam de processamento
private async processVelozStrategies(latestTick: Tick): Promise<void> {
  // Filtrar apenas usuários que coletaram ticks suficientes
  const usersToProcess = Array.from(this.velozUsers.entries())
    .filter(([userId, state]) => 
      state.ticksColetados >= VELOZ_CONFIG.intervaloTicks && 
      !state.isOperationActive
    );
  
  // Processar em batches limitados
  for (let i = 0; i < usersToProcess.length; i += 5) {
    const batch = usersToProcess.slice(i, i + 5);
    await Promise.all(
      batch.map(([userId, state]) => 
        this.processVelozUser(state, latestTick).catch(...)
      )
    );
  }
  
  // Incrementar ticks para todos (rápido, não bloqueia)
  for (const state of this.velozUsers.values()) {
    state.ticksColetados++;
  }
}
```

**Redução Esperada:** 70-90% menos processamento desnecessário

---

### 4. **Atlas Strategy - Processamento Paralelo de Todos os Usuários** ⚠️ CRÍTICO

**Localização:** `backend/src/ai/strategies/atlas.strategy.ts` (linhas 144-196)

**Problema:**
```typescript
async processTick(tick: Tick, symbol?: string): Promise<void> {
  const activeUsers = Array.from(this.users.values())
    .filter(state => state.symbol === assetSymbol && !state.isOperationActive);
  
  if (activeUsers.length === 0) return;
  
  // Processa TODOS os usuários em paralelo
  const processPromises = activeUsers.map(state => {
    state.digitBuffer.push(tick.digit);
    if (state.digitBuffer.length > 100) {
      state.digitBuffer.shift();
    }
    return this.processAtlasStrategies(tick, state).catch(...);
  });
  
  await Promise.all(processPromises);
}
```

**Impacto:**
- Se há **20 usuários ativos**, processa **todos em paralelo** a cada tick
- Com ticks a cada 1 segundo = **1200 processamentos por minuto**
- **CPU pode saturar** com muitos usuários simultâneos

**Solução Recomendada:**
```typescript
// Processar em batches limitados
const BATCH_SIZE = 5; // Máximo 5 usuários simultâneos
for (let i = 0; i < activeUsers.length; i += BATCH_SIZE) {
  const batch = activeUsers.slice(i, i + BATCH_SIZE);
  await Promise.all(
    batch.map(state => {
      state.digitBuffer.push(tick.digit);
      if (state.digitBuffer.length > 100) {
        state.digitBuffer.shift();
      }
      return this.processAtlasStrategies(tick, state).catch(...);
    })
  );
  
  // Pequeno delay entre batches
  if (i + BATCH_SIZE < activeUsers.length) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
```

**Redução Esperada:** 60-75% menos carga de CPU com muitos usuários

---

## 🟡 PROBLEMAS MODERADOS

### 5. **JSON.stringify/parse em Loops** ⚠️ MODERADO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts` (múltiplas linhas)

**Problema:**
```typescript
// Linha 1982: JSON.stringify em análise
JSON.stringify(analysisData)

// Linha 2061, 2147: JSON.stringify em tratamento de erros
const errorMessage = proposalResponse.error.message || JSON.stringify(proposalResponse.error);

// Linha 4336: JSON.parse em logs
metadata = JSON.parse(log.metadata);
```

**Impacto:**
- `JSON.stringify` e `JSON.parse` são operações síncronas bloqueantes
- Quando executadas em loops ou frequentemente, podem causar picos de CPU
- Especialmente problemático com objetos grandes ou arrays

**Solução Recomendada:**
- Usar `JSON.stringify` apenas quando necessário (não em loops)
- Cachear resultados de stringify quando possível
- Usar try-catch para evitar crashes em JSON.parse

**Redução Esperada:** 10-20% menos overhead de CPU em operações JSON

---

### 6. **LogQueueService com Cron a cada 5 segundos** ⚠️ MODERADO

**Localização:** `backend/src/utils/log-queue.service.ts` (linha 266)

**Problema:**
```typescript
@Cron('*/5 * * * * *', {
  name: 'flush-log-queue',
})
async flushLogQueue(): Promise<void> {
  if (this.logQueue.length > 0 && !this.logProcessing) {
    await this.processLogQueue();
  }
}
```

**Impacto:**
- Executa **12 vezes por minuto** (a cada 5 segundos)
- Mesmo que não haja logs, verifica a fila constantemente
- **Overhead de CPU** para verificar condição

**Solução Recomendada:**
```typescript
// Aumentar para 10 segundos (já processa quando há 10+ logs)
@Cron('*/10 * * * * *', {
  name: 'flush-log-queue',
})
```

**Redução Esperada:** 50% menos execuções do cron

---

### 7. **Múltiplos Keep-Alive Intervals de WebSocket** ⚠️ MODERADO

**Localização:** Múltiplas estratégias (titan, apollo, atlas, nexus, orion)

**Problema:**
```typescript
// Cada estratégia cria seu próprio keep-alive
conn.keepAliveInterval = setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ ping: 1 }));
  }
}, 30000); // 30 segundos
```

**Impacto:**
- Se há **5 estratégias** com **10 conexões cada** = **50 intervalos** rodando
- Cada intervalo executa a cada 30-90 segundos
- **Overhead de CPU** para gerenciar múltiplos intervalos

**Solução Recomendada:**
- Usar pool centralizado de WebSocket (já implementado em `DerivWebSocketPoolService`)
- Keep-alive centralizado em vez de individual por conexão

**Redução Esperada:** 60-80% menos intervalos ativos

---

### 8. **Processamento de Arrays Grandes sem Otimização** ⚠️ MODERADO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts`

**Problema:**
```typescript
// Linha 1592: Processa array de 20 dígitos
const digits = last20.map(p => {
  return Math.floor((p.value % 1) * 10);
});

// Linha 1615: Filtra array
const highDigits = digits.filter(d => d >= 5).length;

// Linha 1660: Filtra array novamente
const lowDigits = digits.filter(d => d < 5).length;
```

**Impacto:**
- Arrays pequenos (20 elementos) não são problema isolado
- Mas quando executado para **20 agentes simultaneamente** = **60 operações de array**
- Pode acumular com outros processamentos

**Solução Recomendada:**
```typescript
// Otimizar: calcular em uma única passada
let highDigits = 0;
let lowDigits = 0;
for (const digit of digits) {
  if (digit >= 5) highDigits++;
  else lowDigits++;
}
```

**Redução Esperada:** 50% menos iterações sobre arrays

---

## 📊 RESUMO DE IMPACTO TOTAL

### Problemas Críticos (Podem causar 100% CPU):
1. ✅ **Scheduler Fast Mode a cada 10s** - 120 processamentos/min
2. ✅ **Processamento de ticks em 5 estratégias** - 3000 processamentos/min
3. ✅ **Loops processando todos usuários** - 4800 processamentos/min
4. ✅ **Atlas processando todos em paralelo** - 1200 processamentos/min

### Problemas Moderados (Contribuem para alto CPU):
5. ⚠️ **JSON.stringify/parse em loops** - Operações síncronas bloqueantes
6. ⚠️ **LogQueue cron a cada 5s** - 12 execuções/min
7. ⚠️ **Múltiplos keep-alive intervals** - 50+ intervalos ativos
8. ⚠️ **Arrays processados múltiplas vezes** - 60+ operações por ciclo

---

## 🎯 RECOMENDAÇÕES PRIORITÁRIAS

### Prioridade 1 (CRÍTICO - Implementar Imediatamente):
1. ✅ Aumentar intervalo do scheduler Fast Mode para 15-20 segundos
2. ✅ Processar apenas estratégias com usuários ativos
3. ✅ Filtrar usuários que precisam de processamento antes de processar
4. ✅ Limitar processamento paralelo do Atlas (batches de 5)

### Prioridade 2 (MODERADO - Implementar em Seguida):
5. ✅ Reduzir uso de JSON.stringify/parse em loops
6. ✅ Aumentar intervalo do LogQueue cron para 10 segundos
7. ✅ Consolidar keep-alive intervals (usar pool centralizado)
8. ✅ Otimizar processamento de arrays (uma única passada)

---

## 📈 IMPACTO ESPERADO DAS OTIMIZAÇÕES

### Antes:
- **Processamentos por minuto:** ~10.000+
- **CPU:** 100% constante
- **Schedulers ativos:** 3+ rodando frequentemente
- **Intervalos ativos:** 50+ keep-alive intervals

### Depois (com otimizações):
- **Processamentos por minuto:** ~2.000-3.000 (redução de 70-80%)
- **CPU:** Estimativa de 30-50% (redução de 50-70%)
- **Schedulers ativos:** 3 rodando com intervalos maiores
- **Intervalos ativos:** 5-10 keep-alive centralizados

---

## 🔧 AÇÕES IMEDIATAS

1. ✅ Aumentar intervalo do scheduler Fast Mode (10s → 15-20s)
2. ✅ Adicionar verificação de usuários ativos antes de processar estratégias
3. ✅ Filtrar usuários que precisam de processamento
4. ✅ Limitar batches de processamento paralelo
5. ✅ Reduzir uso de JSON.stringify/parse em loops
6. ✅ Aumentar intervalo do LogQueue cron (5s → 10s)
7. ✅ Verificar se pool centralizado de WebSocket está sendo usado

---

*Documento criado em 2025-01-XX*

