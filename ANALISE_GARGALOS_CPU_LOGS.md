# Análise de Gargalos de CPU - Baseado em Logs

**Data:** 2026-01-05  
**Status:** 🔴 CRÍTICO - CPU em 100%  
**Prioridade:** ALTA

---

## 📋 RESUMO EXECUTIVO

Análise dos logs do PM2 identificou **5 gargalos críticos** que estão causando uso excessivo de CPU:

1. 🔴 **Scheduler Fast Mode executando a cada 10s** - mesmo sem usuários ativos
2. 🔴 **Processamento de ticks em TODAS as estratégias** - mesmo sem usuários
3. 🔴 **OrionStrategy verificando 4 modos em paralelo** - sempre, mesmo vazio
4. 🟡 **Logs de debug excessivos** - poluindo e consumindo CPU
5. 🟡 **Queries SQL frequentes** - executadas mesmo sem necessidade

---

## 🔴 GARGALOS CRÍTICOS IDENTIFICADOS

### 1. Scheduler Fast Mode - Executando Sempre (CRÍTICO)

**Evidência nos logs:**
```
[Nest] 452589  - 01/05/2026, 9:35:20 PM   DEBUG [AiScheduler] 🔄 [Scheduler] Executando processamento de modo fast
[Nest] 452589  - 01/05/2026, 9:35:20 PM   DEBUG [AiService] 🔍 [Fast Mode] Buscando usuários ativos...
[Nest] 452589  - 01/05/2026, 9:35:20 PM   DEBUG [AiService] [Fast Mode] Encontrados 0 usuários ativos
```

**Problema:**
- Executa **a cada 10 segundos** (6x por minuto)
- Executa **query SQL** mesmo quando não há usuários
- Processa lógica desnecessária constantemente

**Localização:** `backend/src/ai/ai.scheduler.ts:47`

**Solução:**
1. Verificar se há usuários ativos ANTES de executar
2. Aumentar intervalo para 15-20 segundos
3. Pular execução completamente se não houver usuários

---

### 2. Processamento de Ticks em Todas as Estratégias (CRÍTICO)

**Evidência nos logs:**
```
[Nest] 452589  - 01/05/2026, 9:35:14 PM   DEBUG [AiService] 🔄 Enviando tick para StrategyManager | Total ticks: 100 | Symbol: R_100
[Nest] 452589  - 01/05/2026, 9:35:14 PM   DEBUG [OrionStrategy] [ORION][Veloz] Nenhum usuário ativo (total: 0)
[Nest] 452589  - 01/05/2026, 9:35:14 PM   DEBUG [OrionStrategy] [ORION][Lenta] Nenhum usuário ativo (total: 0)
```

**Problema:**
- **Cada tick** (a cada 2 segundos) dispara processamento em:
  - OrionStrategy (4 modos: veloz, moderado, preciso, lenta)
  - ApolloStrategy
  - TitanStrategy
  - NexusStrategy
- Mesmo quando **nenhum usuário está ativo**
- **~30 processamentos por minuto** de código desnecessário

**Localização:** 
- `backend/src/ai/strategies/strategy-manager.service.ts:48`
- `backend/src/ai/strategies/orion.strategy.ts:438`

**Solução:**
1. Verificar se há usuários ativos ANTES de processar tick
2. Retornar early se não houver usuários
3. Cachear estado de "usuários ativos" para evitar verificações repetidas

---

### 3. OrionStrategy Processando 4 Modos Sempre (CRÍTICO)

**Evidência nos logs:**
```
[Nest] 452589  - 01/05/2026, 9:35:14 PM   DEBUG [OrionStrategy] [ORION][Veloz] Nenhum usuário ativo (total: 0)
[Nest] 452589  - 01/05/2026, 9:35:14 PM   DEBUG [OrionStrategy] [ORION][Lenta] Nenhum usuário ativo (total: 0)
```

**Problema:**
- `processTick()` chama **4 funções em paralelo** sempre:
  - `processVelozStrategies()`
  - `processModeradoStrategies()`
  - `processPrecisoStrategies()`
  - `processLentaStrategies()`
- Cada uma verifica `size === 0` e retorna, mas **já consumiu CPU** para criar Promise.all

**Localização:** `backend/src/ai/strategies/orion.strategy.ts:453-466`

**Solução:**
1. Verificar se há usuários ANTES de criar Promise.all
2. Processar apenas modos que têm usuários ativos
3. Retornar early se nenhum modo tiver usuários

---

### 4. Logs de Debug Excessivos (MÉDIO)

**Evidência nos logs:**
- Logs de debug a cada tick processado
- Logs mesmo quando não há usuários
- Múltiplos logs por segundo

**Problema:**
- Logs consomem CPU e I/O
- Poluem o output dificultando diagnóstico
- Executam mesmo quando não há ação necessária

**Solução:**
1. Reduzir frequência de logs de debug
2. Logar apenas quando há mudança de estado
3. Usar log level apropriado (DEBUG vs INFO)

---

### 5. Queries SQL Frequentes (MÉDIO)

**Evidência nos logs:**
- Múltiplas queries a cada execução do scheduler
- Queries mesmo quando não há usuários
- Queries repetitivas sem cache

**Problema:**
- Overhead de conexão e processamento SQL
- Bloqueio de recursos do banco
- Execução desnecessária

**Solução:**
1. Cachear resultados de queries frequentes
2. Verificar necessidade antes de executar
3. Usar batch queries quando possível

---

## 📊 IMPACTO ESTIMADO

### Antes das Otimizações:
- **Scheduler:** 6 execuções/min × 60 min = **360 execuções/hora**
- **Ticks processados:** ~30 ticks/min × 4 estratégias = **120 processamentos/min**
- **CPU:** ~100% constante

### Após Otimizações (Estimado):
- **Scheduler:** 0-2 execuções/min (apenas quando há usuários) = **0-120 execuções/hora**
- **Ticks processados:** 0 quando não há usuários = **0-30 processamentos/min**
- **CPU:** Redução estimada de **60-80%**

---

## ✅ PLANO DE AÇÃO

1. ✅ **Otimizar AiScheduler** - Verificar usuários antes de executar
2. ✅ **Otimizar StrategyManager** - Early return se não houver usuários
3. ✅ **Otimizar OrionStrategy** - Verificar usuários antes de Promise.all
4. ✅ **Reduzir logs** - Apenas quando necessário
5. ✅ **Aumentar intervalo** - De 10s para 15-20s

---

## 🔧 IMPLEMENTAÇÃO

Ver arquivos:
- `backend/src/ai/ai.scheduler.ts`
- `backend/src/ai/strategies/strategy-manager.service.ts`
- `backend/src/ai/strategies/orion.strategy.ts`

