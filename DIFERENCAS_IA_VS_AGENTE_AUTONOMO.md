# Diferenças: IA vs Agente Autônomo
## Análise de Arquitetura e Proposta de Refatoração

**Data:** 2026-01-05  
**Status:** 🔴 CRÍTICO - CPU 100% no Agente Autônomo  
**Prioridade:** MÁXIMA

---

## 📊 ARQUITETURA ATUAL

### 🟢 IA (AiService) - FUNCIONA BEM (CPU < 10%)

#### Fluxo de Processamento:
```
1. WebSocket recebe TICK
   ↓
2. AiService.processTick() 
   ↓
3. StrategyManager.processTick() → Distribui para TODAS as estratégias
   ↓
4. Cada estratégia processa seus usuários (Orion, Atlas, Apollo, etc.)
   ↓
5. Apenas usuários que PRECISAM são processados
```

#### Características:
- ✅ **Processamento REATIVO**: Só processa quando recebe tick
- ✅ **StrategyManager centralizado**: Uma única entrada para todas estratégias
- ✅ **Scheduler leve**: Apenas sincroniza usuários (1x/min) e fast mode (10s)
- ✅ **Processamento por necessidade**: Cada estratégia decide se processa ou não
- ✅ **Sem loops pesados**: Não itera sobre todos os usuários desnecessariamente

#### Schedulers:
```typescript
// 1. Background: Apenas sincroniza usuários do banco (1x/min)
@Cron(CronExpression.EVERY_MINUTE)
async handleBackgroundAIs() {
  await this.aiService.processBackgroundAIs(); // Sincroniza usuários
}

// 2. Fast Mode: Processa usuários fast mode (10s)
@Cron('*/10 * * * * *')
async handleFastModeAIs() {
  await this.aiService.processFastModeUsers(); // Processa fast mode
}
```

---

### 🔴 Agente Autônomo (AutonomousAgentService) - PROBLEMA (CPU 100%)

#### Fluxo de Processamento:
```
1. Scheduler executa a cada 2 minutos
   ↓
2. processActiveAgents() → Busca TODOS os agentes ativos
   ↓
3. Para CADA agente:
   - Busca configuração do banco
   - Faz análise técnica completa (EMA, RSI, Momentum)
   - Valida confirmação estatística
   - Verifica se pode operar
   ↓
4. Processa em batches de 3 agentes simultâneos
   ↓
5. Repete a cada 2 minutos, mesmo sem novos ticks
```

#### Características:
- ❌ **Processamento PROATIVO**: Processa periodicamente, mesmo sem necessidade
- ❌ **Sem StrategyManager**: Cada estratégia é processada diretamente
- ❌ **Scheduler pesado**: Processa TODOS os agentes a cada 2 minutos
- ❌ **Análise técnica completa**: Calcula EMA, RSI, Momentum para cada agente
- ❌ **Loops pesados**: Itera sobre todos os agentes mesmo quando não precisa

#### Scheduler:
```typescript
// Processa TODOS os agentes a cada 2 minutos
@Cron('*/2 * * * *')
async handleProcessAgents() {
  await this.agentService.processActiveAgents(); // ❌ Processa TODOS
}
```

---

## 🔍 PROBLEMAS IDENTIFICADOS

### 1. **Processamento Proativo vs Reativo**

**IA (Reativo):**
- Processa apenas quando recebe tick
- Se não há tick, não processa
- CPU baixa porque processa apenas quando necessário

**Agente Autônomo (Proativo):**
- Processa TODOS os agentes a cada 2 minutos
- Mesmo sem novos ticks, faz análise completa
- CPU alta porque processa constantemente

### 2. **Análise Técnica Completa a Cada Ciclo**

**IA:**
- Análise técnica é feita apenas quando há tick novo
- Cache eficiente de análise
- Processamento incremental

**Agente Autônomo:**
- Calcula EMA, RSI, Momentum para CADA agente a cada 2 minutos
- Mesmo que não tenha novo tick
- Processamento pesado e desnecessário

### 3. **Falta de StrategyManager**

**IA:**
- StrategyManager centraliza processamento
- Uma única entrada para todas estratégias
- Processamento otimizado

**Agente Autônomo:**
- Cada estratégia é processada diretamente
- Sem centralização
- Processamento duplicado

### 4. **Scheduler Agressivo**

**IA:**
- Scheduler apenas sincroniza usuários
- Processamento é reativo (baseado em ticks)

**Agente Autônomo:**
- Scheduler processa TODOS os agentes
- Processamento é proativo (baseado em tempo)

---

## ✅ SOLUÇÃO: Refatorar para Arquitetura da IA

### Proposta de Refatoração:

1. **Criar AutonomousAgentStrategyManager** (similar ao StrategyManager)
2. **Processamento baseado em TICKS** (reativo, não proativo)
3. **Scheduler apenas para sincronização** (não para processamento)
4. **Estratégias processam apenas quando necessário**

### Nova Arquitetura:

```
1. WebSocket recebe TICK
   ↓
2. AutonomousAgentService.processSharedTick()
   ↓
3. AutonomousAgentStrategyManager.processTick() → Distribui para estratégias
   ↓
4. Cada estratégia (Orion, Sentinel, Falcon) processa seus agentes
   ↓
5. Apenas agentes que PRECISAM são processados
```

### Scheduler Leve:

```typescript
// Apenas sincroniza agentes do banco (1x/min)
@Cron(CronExpression.EVERY_MINUTE)
async handleSyncAgents() {
  await this.agentService.syncActiveAgentsFromDb(); // Sincroniza apenas
}

// Processamento é REATIVO (baseado em ticks), não proativo
```

---

## 📋 PLANO DE IMPLEMENTAÇÃO

### Fase 1: Criar AutonomousAgentStrategyManager
- [ ] Criar `autonomous-agent-strategy-manager.service.ts`
- [ ] Registrar estratégias (Orion, Sentinel, Falcon)
- [ ] Implementar `processTick()` centralizado

### Fase 2: Refatorar Processamento
- [ ] Modificar `processSharedTick()` para usar StrategyManager
- [ ] Remover processamento pesado do scheduler
- [ ] Processamento baseado em ticks (reativo)

### Fase 3: Otimizar Scheduler
- [ ] Scheduler apenas sincroniza agentes
- [ ] Remover processamento de agentes do scheduler
- [ ] Processamento acontece quando recebe tick

### Fase 4: Testes
- [ ] Verificar CPU com agente ativo
- [ ] Verificar processamento correto
- [ ] Validar performance

---

## 🎯 RESULTADO ESPERADO

### Antes (Atual):
- **CPU:** 100% constante
- **Processamento:** Todos os agentes a cada 2 minutos
- **Análise técnica:** Completa para cada agente a cada ciclo
- **Arquitetura:** Proativa (baseada em tempo)

### Depois (Refatorado):
- **CPU:** < 10% (similar à IA)
- **Processamento:** Apenas quando recebe tick
- **Análise técnica:** Apenas quando necessário
- **Arquitetura:** Reativa (baseada em eventos)

---

*Documento criado em 2026-01-05*



