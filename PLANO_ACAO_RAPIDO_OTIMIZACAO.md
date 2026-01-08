# Plano de Ação Rápido - Otimização de Performance
## Ações Imediatas para Reduzir CPU de 100% para 30-50%

**Status:** 🔴 URGENTE  
**Tempo Total:** 8-12 horas  
**Impacto Esperado:** 50-70% redução no uso de CPU

---

## 🎯 Ações Prioritárias (Fazer HOJE)

### ✅ AÇÃO 1: Implementar Fila de Logs Assíncrona (2-3h)
**Impacto:** 95-99% menos tempo bloqueado

**Passos:**
1. Criar arquivo `backend/src/utils/log-queue.service.ts`
2. Implementar fila com buffer em memória
3. Migrar `saveLog()` para `saveLogAsync()` no `ai.service.ts`
4. Adicionar flush periódico (a cada 5 segundos)

**Código Base:**
```typescript
// backend/src/utils/log-queue.service.ts
@Injectable()
export class LogQueueService {
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
    const batch = this.logQueue.splice(0, 100);
    
    try {
      if (batch.length > 0) {
        await this.dataSource.query(
          `INSERT INTO ai_logs (user_id, level, module, message, created_at) VALUES ?`,
          [batch.map(log => [log.userId, log.level, log.module, log.message, new Date()])]
        );
      }
    } finally {
      this.logProcessing = false;
      if (this.logQueue.length > 0) {
        setImmediate(() => this.processLogQueue());
      }
    }
  }
}
```

---

### ✅ AÇÃO 2: Processamento Paralelo de Usuários (2-3h)
**Impacto:** 60-80% menos tempo total

**Passos:**
1. Refatorar `processFastModeUsers()` em `ai.service.ts`
2. Refatorar `processBackgroundAIs()` em `ai.service.ts`
3. Implementar função helper `processUsersInParallel()`

**Código:**
```typescript
// Adicionar em ai.service.ts
private async processUsersInParallel<T>(
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

// Refatorar processFastModeUsers():
async processFastModeUsers(): Promise<void> {
  const fastModeUsers = await this.dataSource.query(/* ... */);
  if (fastModeUsers.length > 0) {
    await this.processUsersInParallel(
      fastModeUsers,
      user => this.processFastMode(user),
      5
    );
  }
}
```

---

### ✅ AÇÃO 3: Aumentar Cache TTL (30min)
**Impacto:** 95% menos queries

**Passo:**
1. Alterar linha 537 em `ai.service.ts`:
```typescript
// De:
private readonly CONFIG_CACHE_TTL = 1000; // 1 segundo

// Para:
private readonly CONFIG_CACHE_TTL = 30000; // 30 segundos
```

---

### ✅ AÇÃO 4: Aumentar Intervalo do Scheduler (30min)
**Impacto:** 66% menos execuções

**Passo:**
1. Alterar linha 47 em `ai.scheduler.ts`:
```typescript
// De:
@Cron('*/10 * * * * *', {

// Para:
@Cron('*/30 * * * * *', {
```

2. Adicionar verificação de usuários ativos:
```typescript
async handleFastModeAIs() {
  if (this.isProcessingFastMode) return;
  
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

---

### ✅ AÇÃO 5: Otimizar Sincronização de Usuários (1-2h)
**Impacto:** 80% menos queries

**Passo:**
1. Refatorar método `processBackgroundAIs()` em `ai.service.ts`:
```typescript
// Em vez de 5 queries sequenciais:
await this.syncVelozUsersFromDb();
await this.syncModeradoUsersFromDb();
// ...

// Fazer 1 query e agrupar:
async syncAllUsersFromDb(): Promise<void> {
  const allUsers = await this.dataSource.query(`
    SELECT user_id, mode, stake_amount, deriv_token, currency
    FROM ai_user_config
    WHERE is_active = TRUE
  `);
  
  const usersByMode = new Map();
  for (const user of allUsers) {
    const mode = user.mode.toLowerCase();
    if (!usersByMode.has(mode)) usersByMode.set(mode, []);
    usersByMode.get(mode).push(user);
  }
  
  // Atualizar Maps em paralelo
  await Promise.all([
    this.updateVelozUsers(usersByMode.get('veloz') || []),
    this.updateModeradoUsers(usersByMode.get('moderado') || []),
    // ...
  ]);
}
```

---

## 📊 Resultado Esperado

### Antes
- CPU: **100%** (constante)
- Queries/min: **100+**
- Tempo bloqueado: **1.4-7s** por operação
- Execuções/hora: **360**

### Depois (após Ações 1-5)
- CPU: **30-50%** (↓ 50-70%)
- Queries/min: **5-10** (↓ 90-95%)
- Tempo bloqueado: **0ms** (↓ 100%)
- Execuções/hora: **120** (↓ 67%)

---

## ⚠️ Ordem de Implementação

1. **AÇÃO 3** (30min) - Mais rápido, impacto imediato
2. **AÇÃO 4** (30min) - Rápido, reduz execuções
3. **AÇÃO 1** (2-3h) - Maior impacto, resolve bloqueio
4. **AÇÃO 2** (2-3h) - Paraleliza processamento
5. **AÇÃO 5** (1-2h) - Otimiza sincronização

**Total:** 6-9 horas

---

## 🔍 Como Verificar Melhoria

### Antes de Começar:
```bash
# Monitorar CPU
top -p $(pgrep -f "node.*main.js")

# Contar queries por minuto
mysql> SHOW PROCESSLIST;
```

### Depois de Cada Ação:
1. Reiniciar servidor
2. Monitorar CPU por 5 minutos
3. Verificar logs para erros
4. Comparar com baseline

---

## 📝 Checklist

- [ ] AÇÃO 3: Aumentar cache TTL
- [ ] AÇÃO 4: Aumentar intervalo scheduler
- [ ] AÇÃO 1: Implementar fila de logs
- [ ] AÇÃO 2: Processamento paralelo
- [ ] AÇÃO 5: Otimizar sincronização
- [ ] Testar cada mudança isoladamente
- [ ] Monitorar CPU após cada mudança
- [ ] Documentar resultados

---

*Criado em 2025-01-XX*  
*Prioridade: MÁXIMA*






