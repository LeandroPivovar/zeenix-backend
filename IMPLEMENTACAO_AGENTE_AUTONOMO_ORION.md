# Implementação do Agente Autônomo com IA Orion

**Data:** 2026-01-05  
**Status:** ✅ IMPLEMENTADO  
**Estratégia:** Orion (100% integrada com IA)

---

## 📊 RESUMO DA IMPLEMENTAÇÃO

O agente autônomo foi completamente refatorado para usar **100% a IA Orion**, seguindo a mesma arquitetura da IA principal:

- ✅ **Conexão WebSocket compartilhada** (similar ao AiService)
- ✅ **Processamento REATIVO** baseado em ticks
- ✅ **StrategyManager centralizado** para o agente autônomo
- ✅ **Integração completa com Orion Strategy** da IA
- ✅ **Lógica de parar no dia** após stop loss/win/blindado
- ✅ **Reset automático** no próximo dia

---

## 🔄 ARQUITETURA IMPLEMENTADA

### Fluxo de Processamento:

```
1. WebSocket recebe TICK (AutonomousAgentService)
   ↓
2. AutonomousAgentService.processTick()
   ↓
3. AutonomousAgentStrategyManager.processTick() → Distribui para estratégias
   ↓
4. OrionAutonomousStrategy.processTick() → Delega para OrionStrategy (IA)
   ↓
5. OrionStrategy.processTick() → Processa usuários e executa operações
   ↓
6. OrionAutonomousStrategy.onContractFinish() → Monitora resultados e aplica regras do agente autônomo
   ↓
7. Se stop loss/win/blindado atingido → Para no dia (session_status = 'stopped_*')
   ↓
8. No próximo dia → Scheduler reseta sessão e reativa agente
```

---

## 📁 ARQUIVOS CRIADOS/MODIFICADOS

### 1. ✅ `backend/src/autonomous-agent/autonomous-agent.service.ts` (NOVO)

**Função:** Serviço principal que recebe ticks do WebSocket

**Características:**
- Conexão WebSocket compartilhada (uma única conexão para todos os agentes)
- Processamento reativo baseado em ticks
- Sincronização de agentes ativos do banco
- Verificação e reset de sessões diárias

**Métodos principais:**
- `initialize()` - Inicializa conexão WebSocket
- `processTick()` - Processa ticks recebidos
- `activateAgent()` - Ativa um agente autônomo
- `deactivateAgent()` - Desativa um agente autônomo
- `checkAndResetDailySessions()` - Verifica e reseta sessões no novo dia

---

### 2. ✅ `backend/src/autonomous-agent/strategies/orion.strategy.ts` (REFATORADO)

**Função:** Wrapper que delega 100% para a OrionStrategy da IA

**Características:**
- Não processa ticks diretamente (delega para OrionStrategy)
- Monitora resultados de operações via `onContractFinish()`
- Aplica regras específicas do agente autônomo:
  - Stop Loss diário (`daily_loss_limit`)
  - Stop Win diário (`daily_profit_target`)
  - Stop Blindado (gerenciado pela Orion Strategy)
- Atualiza `session_status` no banco quando para no dia

**Lógica de Parar no Dia:**
```typescript
// Após cada operação, verifica:
if (newLoss >= config.dailyLossLimit) {
  sessionStatus = 'stopped_loss'; // Para no dia
  // Desativa na Orion Strategy (mas mantém is_active = TRUE no banco)
}

if (newProfit >= config.dailyProfitTarget) {
  sessionStatus = 'stopped_profit'; // Para no dia
  // Desativa na Orion Strategy (mas mantém is_active = TRUE no banco)
}
```

---

### 3. ✅ `backend/src/autonomous-agent/autonomous-agent.scheduler.ts` (NOVO)

**Função:** Scheduler para verificar e resetar sessões diárias

**Tarefas:**
- `handleCheckAndResetDailySessions()` - A cada hora, verifica se mudou o dia e reseta sessões
- `handleSyncActiveAgents()` - A cada 5 minutos, sincroniza agentes ativos do banco

**Lógica de Reset:**
```typescript
// Busca agentes que pararam no dia anterior
const agentsToReset = await this.dataSource.query(
  `SELECT user_id, session_status, session_date
   FROM autonomous_agent_config 
   WHERE is_active = TRUE 
     AND agent_type = 'orion'
     AND session_status IN ('stopped_profit', 'stopped_loss', 'stopped_blindado')
     AND (session_date IS NULL OR DATE(session_date) < ?)`,
  [todayStr],
);

// Para cada agente, reseta sessão e reativa
await this.dataSource.query(
  `UPDATE autonomous_agent_config 
   SET session_status = 'active',
       session_date = NOW(),
       daily_profit = 0,
       daily_loss = 0
   WHERE user_id = ? AND is_active = TRUE`,
  [agent.user_id],
);
```

---

### 4. ✅ `backend/src/autonomous-agent/autonomous-agent.module.ts` (ATUALIZADO)

**Mudanças:**
- Importa `AiModule` para usar `OrionStrategy`
- Registra `AutonomousAgentStrategyManagerService`
- Registra estratégias: `OrionAutonomousStrategy`, `SentinelStrategy`, `FalconStrategy`

---

### 5. ✅ `backend/db/update_autonomous_agent_config_for_orion.sql` (NOVO)

**Função:** Script SQL para atualizar tabela `autonomous_agent_config`

**Mudanças:**
- Adiciona campo `agent_type` (orion, sentinel, falcon)
- Adiciona campo `trading_mode` (veloz, moderado, preciso, normal, lento)
- Adiciona campo `initial_balance` (saldo inicial da conta)
- Atualiza `session_status` para incluir `'stopped_blindado'`
- Altera `session_date` de DATE para TIMESTAMP

---

## 🎯 FUNCIONALIDADES IMPLEMENTADAS

### ✅ 1. Integração 100% com IA Orion

- A Orion Strategy processa tudo (sinais, operações, stop loss/win/blindado)
- O agente autônomo apenas monitora resultados e aplica regras específicas

### ✅ 2. Parar no Dia Após Stop Loss/Win/Blindado

**Comportamento:**
- Quando `daily_loss >= daily_loss_limit` → `session_status = 'stopped_loss'`
- Quando `daily_profit >= daily_profit_target` → `session_status = 'stopped_profit'`
- Quando stop blindado é atingido → `session_status = 'stopped_blindado'`
- Agente é desativado na Orion Strategy (mas `is_active = TRUE` no banco)
- **Continua no próximo dia** automaticamente via scheduler

### ✅ 3. Reset Automático no Próximo Dia

**Comportamento:**
- Scheduler verifica a cada hora se mudou o dia
- Se um agente parou no dia anterior, reseta:
  - `session_status = 'active'`
  - `daily_profit = 0`
  - `daily_loss = 0`
  - `session_date = NOW()`
- Reativa agente na Orion Strategy

### ✅ 4. Conexão WebSocket Compartilhada

- Uma única conexão WebSocket para todos os agentes
- Processamento eficiente e escalável
- Similar à arquitetura da IA principal

---

## 🔧 CONFIGURAÇÃO

### Ativar Agente Autônomo:

```typescript
POST /autonomous-agent/activate
{
  "initialStake": 10.00,        // Valor de entrada por operação
  "dailyProfitTarget": 200.00,   // Meta de lucro diário (Stop Win)
  "dailyLossLimit": 240.00,     // Limite de perda diário (Stop Loss)
  "derivToken": "...",           // Token da Deriv
  "currency": "USD",             // Moeda
  "symbol": "R_100",             // Símbolo (R_100 para Orion)
  "strategy": "orion",           // Estratégia (orion)
  "tradingMode": "normal",       // Modo: veloz, moderado, preciso, normal, lento
  "initialBalance": 1000.00      // Saldo inicial da conta
}
```

### Desativar Agente Autônomo:

```typescript
POST /autonomous-agent/deactivate
{
  "userId": "..."
}
```

---

## 📊 BANCO DE DADOS

### Tabela: `autonomous_agent_config`

**Campos importantes:**
- `agent_type` - Tipo de agente (orion, sentinel, falcon)
- `trading_mode` - Modo de trading (veloz, moderado, preciso, normal, lento)
- `initial_balance` - Saldo inicial da conta
- `daily_profit` - Lucro acumulado no dia
- `daily_loss` - Perda acumulada no dia
- `session_status` - Status da sessão (active, stopped_profit, stopped_loss, stopped_blindado, paused)
- `session_date` - Data/hora da sessão atual

**Lógica de Sessão:**
- Quando para no dia: `session_status` muda para `stopped_*`, mas `is_active = TRUE`
- No próximo dia: Scheduler reseta `session_status = 'active'` e `daily_profit/daily_loss = 0`

---

## ⚠️ OBSERVAÇÕES IMPORTANTES

### 1. Trades Salvos em `ai_trades`

A Orion Strategy salva trades em `ai_trades` (não em `autonomous_agent_trades`). Isso é intencional, pois a Orion Strategy não diferencia entre IA e agente autônomo.

**Solução futura (opcional):**
- Modificar Orion Strategy para aceitar um parâmetro indicando se é agente autônomo
- Salvar trades do agente autônomo em `autonomous_agent_trades`

### 2. Stop Blindado Gerenciado pela Orion Strategy

O stop blindado é gerenciado completamente pela Orion Strategy. O agente autônomo apenas monitora quando é atingido e atualiza `session_status = 'stopped_blindado'`.

### 3. Sincronização de Agentes

O scheduler sincroniza agentes ativos do banco a cada 5 minutos. Isso garante que agentes ativados manualmente no banco sejam carregados na memória.

---

## 🚀 PRÓXIMOS PASSOS (OPCIONAL)

1. **Salvar trades em `autonomous_agent_trades`**
   - Modificar Orion Strategy para aceitar contexto (IA vs Agente Autônomo)
   - Salvar trades do agente autônomo em tabela separada

2. **Interface Frontend**
   - Criar/atualizar interface para gerenciar agente autônomo
   - Exibir status da sessão (active, stopped_profit, stopped_loss, stopped_blindado)
   - Mostrar lucro/perda diária

3. **Logs Específicos**
   - Já implementado via `LogQueueService` salvando em `autonomous_agent_logs`

---

## ✅ TESTES RECOMENDADOS

1. **Ativar agente autônomo** e verificar se conecta ao WebSocket
2. **Verificar se ticks são processados** corretamente
3. **Simular stop loss/win** e verificar se para no dia
4. **Aguardar mudança de dia** e verificar se sessão é resetada automaticamente
5. **Verificar logs** em `autonomous_agent_logs`

---

**Implementação concluída em:** 2026-01-05  
**Versão:** 1.0.0


