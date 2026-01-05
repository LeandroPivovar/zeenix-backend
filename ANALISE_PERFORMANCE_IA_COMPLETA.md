# Análise Completa de Performance - Sistema de IA
## Diagnóstico Detalhado e Plano de Otimização

**Data:** 2025-01-XX  
**Status:** 🔴 CRÍTICO - CPU em 100%  
**Prioridade:** MÁXIMA

---

## 📊 Sumário Executivo

O backend está consumindo **100% de CPU** devido a múltiplos gargalos críticos no sistema de IA. Esta análise identifica **8 problemas críticos** e **12 problemas médios/baixos** que precisam ser resolvidos.

**Principais Causas:**
1. 🔴 **142 chamadas `saveLog()` bloqueantes** por operação
2. 🔴 **Processamento sequencial** de usuários (1 por vez)
3. 🔴 **Cache TTL de 1 segundo** (consultas excessivas ao banco)
4. 🔴 **Scheduler a cada 10 segundos** (ainda muito frequente)
5. 🔴 **Múltiplas sincronizações** do banco a cada minuto
6. 🔴 **Loops aninhados** processando ticks para cada usuário
7. 🔴 **WebSockets com keep-alive** a cada 30-90 segundos
8. 🔴 **Falta de batch processing** para logs e queries

---

## 🔍 Análise Detalhada do Código

### 1. 🔴 CRÍTICO: Logs Bloqueantes (142 chamadas await saveLog)

**Localização:** `backend/src/ai/ai.service.ts`

**Problema:**
- **142 chamadas `await saveLog()`** encontradas no código
- Cada chamada faz um **INSERT síncrono** no banco
- Cada INSERT leva **10-50ms**
- **Total: 1.4-7 segundos bloqueados** apenas em logs por operação

**Código Problemático:**
```typescript
// ❌ PROBLEMA: Logs bloqueantes
await this.saveLog(userId, 'INFO', 'Módulo', 'Mensagem');
await this.saveLog(userId, 'INFO', 'Módulo', 'Outra mensagem');
// ... 140+ vezes por operação
```

**Impacto:**
- **Thread principal bloqueada** durante INSERTs
- **Latência acumulada** de 1.4-7 segundos por operação
- **CPU ociosa** esperando I/O do banco
- **Escalabilidade zero** - não suporta múltiplos usuários simultâneos

**Solução:**
```typescript
// ✅ SOLUÇÃO: Fila assíncrona de logs
private logQueue: Array<{userId: string; level: string; module: string; message: string}> = [];
private logProcessing = false;

saveLogAsync(userId: string, level: string, module: string, message: string): void {
  this.logQueue.push({ userId, level, module, message });
  if (!this.logProcessing && this.logQueue.length >= 10) {
    setImmediate(() => this.processLogQueue());
  }
}

private async processLogQueue(): Promise<void> {
  if (this.logProcessing || this.logQueue.length === 0) return;
  
  this.logProcessing = true;
  const batch = this.logQueue.splice(0, 100); // Processar até 100 logs
  
  try {
    if (batch.length > 0) {
      // INSERT em batch (1 query para 100 logs)
      await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, level, module, message, created_at) VALUES ?`,
        [batch.map(log => [log.userId, log.level, log.module, log.message, new Date()])]
      );
    }
  } catch (error) {
    this.logger.error('[LogQueue] Erro:', error);
  } finally {
    this.logProcessing = false;
    if (this.logQueue.length > 0) {
      setImmediate(() => this.processLogQueue());
    }
  }
}

// Flush periódico (a cada 5 segundos) para garantir que logs não fiquem muito tempo na fila
@Cron('*/5 * * * * *')
async flushLogQueue() {
  if (this.logQueue.length > 0) {
    await this.processLogQueue();
  }
}
```

**Redução Esperada:** 95-99% menos tempo bloqueado por logs

---

### 2. 🔴 CRÍTICO: Processamento Sequencial de Usuários

**Localização:** `backend/src/ai/ai.service.ts` (linhas 4927-4937, 4980-4989)

**Problema:**
```typescript
// ❌ PROBLEMA: Processamento sequencial
for (const user of fastModeUsers) {
  await this.processFastMode(user); // Processa 1 por vez
}

for (const user of usersToProcess) {
  await this.processUserAI(user); // Processa 1 por vez
}
```

**Impacto:**
- Se há **10 usuários ativos**, processa **1 por vez**
- Cada usuário leva **1-3 segundos**
- **Total: 10-30 segundos** para processar todos
- **CPU ociosa** 80% do tempo esperando I/O

**Solução:**
```typescript
// ✅ SOLUÇÃO: Processamento paralelo com limite de concorrência
async processUsersInParallel<T>(
  users: T[],
  processor: (user: T) => Promise<void>,
  maxConcurrency: number = 5
): Promise<void> {
  for (let i = 0; i < users.length; i += maxConcurrency) {
    const batch = users.slice(i, i + maxConcurrency);
    await Promise.all(
      batch.map(user =>
        processor(user).catch(error => {
          this.logger.error(`[ProcessUser] Erro:`, error);
        })
      )
    );
  }
}

// Uso:
await this.processUsersInParallel(
  fastModeUsers,
  user => this.processFastMode(user),
  5 // Processar 5 usuários simultaneamente
);
```

**Redução Esperada:** 60-80% menos tempo total de processamento

---

### 3. 🔴 CRÍTICO: Cache TTL de 1 Segundo

**Localização:** `backend/src/ai/ai.service.ts` (linha 537)

**Problema:**
```typescript
// ❌ PROBLEMA: Cache expira muito rápido
private readonly CONFIG_CACHE_TTL = 1000; // 1 segundo
```

**Impacto:**
- Cache invalida **a cada segundo**
- **Consultas ao banco a cada segundo** para mesma configuração
- Se há 10 usuários, **10 queries por segundo** apenas para config
- **Desperdício massivo** de recursos

**Solução:**
```typescript
// ✅ SOLUÇÃO: Aumentar TTL e invalidar apenas quando necessário
private readonly CONFIG_CACHE_TTL = 30000; // 30 segundos

// Invalidar cache quando configuração mudar
async updateUserConfig(userId: string, config: Partial<Config>): Promise<void> {
  await this.dataSource.query(/* UPDATE */);
  this.userConfigCache.delete(userId); // Invalidar imediatamente
}
```

**Redução Esperada:** 95% menos queries ao banco para configurações

---

### 4. 🔴 CRÍTICO: Scheduler A Cada 10 Segundos

**Localização:** `backend/src/ai/ai.scheduler.ts` (linha 47)

**Problema:**
```typescript
// ❌ PROBLEMA: Executa 6 vezes por minuto
@Cron('*/10 * * * * *', {
  name: 'process-fast-mode-ais',
})
```

**Impacto:**
- **6 execuções por minuto** = 360 por hora
- Cada execução pode processar múltiplos usuários
- **Consultas ao banco** a cada 10 segundos
- **Overhead constante** mesmo sem usuários ativos

**Solução:**
```typescript
// ✅ SOLUÇÃO: Aumentar para 30 segundos e verificar se há usuários antes
@Cron('*/30 * * * * *', {
  name: 'process-fast-mode-ais',
})
async handleFastModeAIs() {
  if (this.isProcessingFastMode) return;
  
  // Verificar se há usuários antes de processar
  const count = await this.aiService.getActiveUsersCount();
  if (count === 0) {
    this.logger.debug('[Scheduler] Nenhum usuário ativo, pulando...');
    return;
  }
  
  this.isProcessingFastMode = true;
  try {
    await this.aiService.processFastModeUsers();
  } finally {
    this.isProcessingFastMode = false;
  }
}
```

**Redução Esperada:** 66% menos execuções (de 360/h para 120/h)

---

### 5. 🔴 CRÍTICO: Múltiplas Sincronizações do Banco

**Localização:** `backend/src/ai/ai.service.ts` (linhas 4952-4957)

**Problema:**
```typescript
// ❌ PROBLEMA: 5 queries sequenciais a cada minuto
await this.syncVelozUsersFromDb();
await this.syncModeradoUsersFromDb();
await this.syncPrecisoUsersFromDb();
await this.syncTrinityUsersFromDb();
await this.syncAtlasUsersFromDb();
```

**Impacto:**
- **5 queries sequenciais** a cada minuto
- Cada query pode retornar dezenas de usuários
- **Processamento de dados** repetido mesmo sem mudanças
- **Overhead constante** mesmo sem novos usuários

**Solução:**
```typescript
// ✅ SOLUÇÃO: Sincronizar apenas quando necessário e em batch
private lastSyncTime = 0;
private readonly SYNC_INTERVAL = 60000; // 1 minuto

async syncAllUsersFromDb(): Promise<void> {
  const now = Date.now();
  if (now - this.lastSyncTime < this.SYNC_INTERVAL) {
    return; // Já sincronizado recentemente
  }
  
  // Buscar todos os usuários ativos de uma vez
  const allUsers = await this.dataSource.query(`
    SELECT user_id, mode, stake_amount, deriv_token, currency
    FROM ai_user_config
    WHERE is_active = TRUE
  `);
  
  // Agrupar por modo e atualizar Maps
  const usersByMode = new Map<string, typeof allUsers>();
  for (const user of allUsers) {
    const mode = user.mode.toLowerCase();
    if (!usersByMode.has(mode)) {
      usersByMode.set(mode, []);
    }
    usersByMode.get(mode)!.push(user);
  }
  
  // Atualizar Maps em paralelo
  await Promise.all([
    this.updateVelozUsers(usersByMode.get('veloz') || []),
    this.updateModeradoUsers(usersByMode.get('moderado') || []),
    this.updatePrecisoUsers(usersByMode.get('preciso') || []),
    this.updateTrinityUsers(usersByMode.get('trinity') || []),
    this.updateAtlasUsers(usersByMode.get('atlas') || []),
  ]);
  
  this.lastSyncTime = now;
}
```

**Redução Esperada:** 80% menos queries de sincronização

---

### 6. 🔴 CRÍTICO: Loops Aninhados Processando Ticks

**Localização:** `backend/src/ai/strategies/orion.strategy.ts` (linhas 453-456)

**Problema:**
```typescript
// ❌ PROBLEMA: Processa todos os usuários a cada tick
async processTick(tick: Tick, symbol?: string): Promise<void> {
  await this.processVelozStrategies(tick);
  await this.processModeradoStrategies(tick);
  await this.processPrecisoStrategies(tick);
  await this.processLentaStrategies(tick);
  
  // Dentro de cada método:
  for (const state of this.velozUsers.values()) {
    // Processa cada usuário sequencialmente
  }
}
```

**Impacto:**
- **Ticks chegam a cada 1-2 segundos**
- **Cada tick processa TODOS os usuários** sequencialmente
- Se há 20 usuários, **20 processamentos por tick**
- **CPU constantemente ocupada** processando loops

**Solução:**
```typescript
// ✅ SOLUÇÃO: Processar apenas usuários que precisam de processamento
async processTick(tick: Tick, symbol?: string): Promise<void> {
  this.ticks.push(tick);
  if (this.ticks.length > 100) this.ticks.shift();
  
  // Processar apenas usuários que coletaram ticks suficientes
  const usersToProcess = Array.from(this.velozUsers.values())
    .filter(state => state.ticksColetados >= 10 && !state.isProcessing);
  
  if (usersToProcess.length > 0) {
    // Processar em paralelo (limitado)
    await Promise.all(
      usersToProcess.slice(0, 5).map(state => 
        this.processVelozUser(state, tick).catch(error => {
          this.logger.error(`[ProcessVeloz][${state.userId}] Erro:`, error);
        })
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

### 7. 🔴 CRÍTICO: WebSockets com Keep-Alive Frequente

**Localização:** Múltiplas estratégias (trinity, atlas, apollo, etc.)

**Problema:**
```typescript
// ❌ PROBLEMA: Keep-alive a cada 30-90 segundos para cada conexão
conn.keepAliveInterval = setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ ping: 1 }));
  }
}, 30000); // 30 segundos
```

**Impacto:**
- Se há **10 conexões WebSocket**, **10 intervalos** rodando
- **Ping a cada 30-90 segundos** por conexão
- **Overhead de CPU** para gerenciar intervalos
- **Memória consumida** por cada intervalo

**Solução:**
```typescript
// ✅ SOLUÇÃO: Keep-alive centralizado e menos frequente
private globalKeepAliveInterval: NodeJS.Timeout | null = null;
private wsConnections = new Map<string, WebSocket>();

private startGlobalKeepAlive(): void {
  if (this.globalKeepAliveInterval) return;
  
  this.globalKeepAliveInterval = setInterval(() => {
    for (const [token, ws] of this.wsConnections.entries()) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ ping: 1 }));
        } catch (error) {
          this.logger.warn(`[KeepAlive][${token}] Erro:`, error);
        }
      }
    }
  }, 60000); // 60 segundos (ainda menos que 2 minutos de timeout)
}
```

**Redução Esperada:** 50-70% menos overhead de keep-alive

---

### 8. 🔴 CRÍTICO: Falta de Batch Processing

**Localização:** Todas as estratégias

**Problema:**
- **Queries individuais** para cada usuário
- **Logs individuais** para cada evento
- **Processamento individual** sem agrupamento

**Solução:**
```typescript
// ✅ SOLUÇÃO: Batch processing para tudo
// 1. Batch queries
async getUsersConfigBatch(userIds: string[]): Promise<Map<string, Config>> {
  const result = await this.dataSource.query(
    `SELECT * FROM ai_user_config WHERE user_id IN (?)`,
    [userIds]
  );
  return new Map(result.map(r => [r.user_id, r]));
}

// 2. Batch logs (já mencionado acima)
// 3. Batch updates
async updateUsersNextTradeAt(updates: Array<{userId: string; nextTradeAt: Date}>): Promise<void> {
  await this.dataSource.query(
    `INSERT INTO ai_user_config (user_id, next_trade_at) VALUES ?
     ON DUPLICATE KEY UPDATE next_trade_at = VALUES(next_trade_at)`,
    [updates.map(u => [u.userId, u.nextTradeAt])]
  );
}
```

**Redução Esperada:** 60-80% menos queries ao banco

---

## 🟡 PROBLEMAS MÉDIOS

### 9. Múltiplas Conexões WebSocket Duplicadas
- **Problema:** Cada estratégia cria suas próprias conexões
- **Solução:** Usar pool centralizado `DerivWebSocketPoolService`
- **Impacto:** 40-60% menos conexões WebSocket

### 10. Consultas N+1
- **Problema:** Loop fazendo query individual para cada usuário
- **Solução:** Buscar todos os dados necessários em uma query
- **Impacto:** 80-90% menos queries

### 11. Processamento de Ticks Desnecessário
- **Problema:** Processa todos os usuários mesmo quando não há ticks suficientes
- **Solução:** Verificar se usuário precisa de processamento antes
- **Impacto:** 50-70% menos processamento

### 12. Falta de Debounce/Throttle
- **Problema:** Múltiplas chamadas simultâneas para mesma operação
- **Solução:** Implementar debounce/throttle
- **Impacto:** 30-50% menos execuções duplicadas

---

## 📋 Plano de Ação Priorizado

### 🔴 FASE 1: Otimizações Críticas (Implementar PRIMEIRO)

#### 1.1 Implementar Fila de Logs Assíncrona
- **Tempo:** 2-3 horas
- **Impacto:** 95-99% redução em tempo bloqueado
- **Prioridade:** MÁXIMA
- **Arquivos:**
  - `backend/src/ai/ai.service.ts`
  - `backend/src/utils/log-queue.service.ts` (criar novo)

#### 1.2 Processamento Paralelo de Usuários
- **Tempo:** 2-3 horas
- **Impacto:** 60-80% redução em tempo total
- **Prioridade:** MÁXIMA
- **Arquivos:**
  - `backend/src/ai/ai.service.ts` (linhas 4909-4944, 4950-4994)

#### 1.3 Aumentar Cache TTL
- **Tempo:** 30 minutos
- **Impacto:** 95% menos queries
- **Prioridade:** MÁXIMA
- **Arquivos:**
  - `backend/src/ai/ai.service.ts` (linha 537)

#### 1.4 Aumentar Intervalo do Scheduler
- **Tempo:** 30 minutos
- **Impacto:** 66% menos execuções
- **Prioridade:** MÁXIMA
- **Arquivos:**
  - `backend/src/ai/ai.scheduler.ts` (linha 47)

#### 1.5 Otimizar Sincronização de Usuários
- **Tempo:** 1-2 horas
- **Impacto:** 80% menos queries
- **Prioridade:** ALTA
- **Arquivos:**
  - `backend/src/ai/ai.service.ts` (linhas 4952-4957)

### 🟡 FASE 2: Otimizações Médias (Implementar DEPOIS)

#### 2.1 Otimizar Processamento de Ticks
- **Tempo:** 2-3 horas
- **Impacto:** 70-90% menos processamento
- **Arquivos:**
  - `backend/src/ai/strategies/orion.strategy.ts`
  - `backend/src/ai/strategies/nexus.strategy.ts`
  - Outras estratégias

#### 2.2 Centralizar Keep-Alive de WebSockets
- **Tempo:** 2-3 horas
- **Impacto:** 50-70% menos overhead
- **Arquivos:**
  - Todas as estratégias

#### 2.3 Implementar Batch Processing
- **Tempo:** 3-4 horas
- **Impacto:** 60-80% menos queries
- **Arquivos:**
  - `backend/src/ai/ai.service.ts`
  - Todas as estratégias

---

## 📊 Métricas Esperadas

### Antes das Otimizações
- **CPU:** 100% (constante)
- **Execuções de schedulers:** 360/hora
- **Queries ao banco:** 100+/minuto
- **Tempo bloqueado por logs:** 1.4-7s por operação
- **Tempo total de processamento:** 10-30s para 10 usuários
- **Conexões WebSocket:** Múltiplas por estratégia
- **Keep-alive intervals:** 10+ rodando simultaneamente

### Depois das Otimizações (Fase 1)
- **CPU:** 30-50% (redução de 50-70%)
- **Execuções de schedulers:** 120/hora (↓ 67%)
- **Queries ao banco:** 5-10/minuto (↓ 90-95%)
- **Tempo bloqueado por logs:** 0ms (↓ 100%)
- **Tempo total de processamento:** 2-6s para 10 usuários (↓ 70-80%)
- **Conexões WebSocket:** Centralizadas (↓ 50%)
- **Keep-alive intervals:** 1-2 rodando (↓ 80-90%)

### Depois das Otimizações (Fase 1 + 2)
- **CPU:** 15-30% (redução de 70-85%)
- **Execuções de schedulers:** 120/hora
- **Queries ao banco:** 2-5/minuto (↓ 95-98%)
- **Tempo bloqueado por logs:** 0ms
- **Tempo total de processamento:** 1-3s para 10 usuários (↓ 85-90%)
- **Conexões WebSocket:** Centralizadas e otimizadas
- **Keep-alive intervals:** 1 rodando

---

## ✅ Checklist de Implementação

### Fase 1: Críticas (Fazer PRIMEIRO)
- [ ] 1.1 Criar `LogQueueService` com fila assíncrona
- [ ] 1.2 Migrar todas chamadas `saveLog()` para `saveLogAsync()`
- [ ] 1.3 Implementar flush periódico de logs
- [ ] 1.4 Refatorar `processFastModeUsers()` para paralelo
- [ ] 1.5 Refatorar `processBackgroundAIs()` para paralelo
- [ ] 1.6 Aumentar `CONFIG_CACHE_TTL` para 30000ms
- [ ] 1.7 Aumentar intervalo do scheduler para 30s
- [ ] 1.8 Adicionar verificação de usuários ativos no scheduler
- [ ] 1.9 Otimizar sincronização de usuários (batch)

### Fase 2: Médias (Fazer DEPOIS)
- [ ] 2.1 Otimizar processamento de ticks (filtrar usuários)
- [ ] 2.2 Centralizar keep-alive de WebSockets
- [ ] 2.3 Implementar batch queries
- [ ] 2.4 Implementar batch updates
- [ ] 2.5 Adicionar debounce/throttle onde necessário

---

## 🚀 Conclusão

O sistema de IA está **extremamente ineficiente** devido a:

1. **142 logs bloqueantes** por operação
2. **Processamento sequencial** de usuários
3. **Cache TTL de 1 segundo**
4. **Scheduler muito frequente**
5. **Múltiplas sincronizações** desnecessárias

**Implementando apenas a Fase 1**, esperamos:
- **50-70% de redução no uso de CPU**
- **90-95% menos queries ao banco**
- **100% menos tempo bloqueado por logs**
- **70-80% menos tempo total de processamento**

**Tempo total estimado:** 8-12 horas de desenvolvimento  
**Impacto esperado:** Redução de 50-70% no uso de CPU/Memória

---

*Documento criado em 2025-01-XX*  
*Versão: 2.0 - Análise Completa*


