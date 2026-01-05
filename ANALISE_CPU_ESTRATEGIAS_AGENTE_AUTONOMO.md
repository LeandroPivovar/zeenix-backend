# Análise de CPU - Estratégias do Agente Autônomo
## Problemas Potenciais que Podem Causar 100% de CPU

**Data:** 2025-01-XX  
**Status:** 🔴 ANÁLISE CRÍTICA

---

## 📋 ESTRATÉGIAS ANALISADAS

### 🛡️ SENTINEL Strategy
- **Usa:** `AutonomousAgentService.processAgent()` 
- **Cálculos pesados:** ✅ SIM - Executa análise técnica completa (EMA, RSI, Momentum)
- **Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts`
- **Configuração:** `SENTINEL_CONFIG` (linha 79)

### 🦅 FALCON Strategy  
- **Usa:** `FalconStrategy.processAgent()` (própria implementação)
- **Cálculos pesados:** ❌ NÃO - Recebe `MarketAnalysis` já calculado
- **Localização:** `backend/src/autonomous-agent/strategies/falcon.strategy.ts`
- **Dependência:** Recebe análise de mercado pronta, não faz cálculos técnicos internos

**⚠️ CONCLUSÃO:** Os cálculos pesados identificados são usados **APENAS pela estratégia SENTINEL**.

---

## 🔴 PROBLEMAS IDENTIFICADOS

### 1. **Processamento Sequencial de Análise Técnica** ⚠️ CRÍTICO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts`

**Problema:**
- Cada agente executa análise técnica completa (EMAs, RSI, Momentum) a cada processamento
- Mesmo com cache, o cálculo inicial é pesado
- Processamento sequencial em batches de 3 agentes simultâneos

**Código Problemático:**
```typescript
// Linha 995: performTechnicalAnalysis é chamado para cada agente
const analysis = this.performTechnicalAnalysis(recentPrices, state.userId);

// Linha 1085-1205: Cálculos pesados de indicadores técnicos
const ema10 = this.calculateEMA(recent, 10, userId, useIncremental);
const ema25 = this.calculateEMA(recent, 25, userId, useIncremental);
const ema50 = this.calculateEMA(recent, 50, userId, useIncremental);
const rsi = this.calculateRSI(recent, 14, userId, useIncremental);
const momentum = this.calculateMomentum(recent, 10, userId, useIncremental);
```

**Impacto:**
- Com 20 agentes ativos, cada ciclo processa análise técnica completa
- Cálculos de EMA, RSI e Momentum são computacionalmente intensivos
- **CPU pode chegar a 100%** com múltiplos agentes processando simultaneamente

**Solução Recomendada:**
- Reduzir frequência de análise técnica (usar cache mais agressivo)
- Processar apenas agentes que realmente precisam (com sinais válidos)
- Limitar número de agentes processados por ciclo (já implementado: MAX_AGENTS_PER_CYCLE = 20)

---

### 2. **Validação Estatística com Loops** ⚠️ MODERADO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts` (linhas 1460-1599)

**Problema:**
- `validateStatisticalConfirmation` processa arrays de dígitos
- Loops `for` reversos para verificar sequências consecutivas
- Executado para cada agente a cada processamento

**Código Problemático:**
```typescript
// Linha 1518-1524: Loop reverso para verificar sequência
for (let i = digits.length - 1; i >= 0; i--) {
  if (digits[i] < 5) {
    consecutiveLow++;
  } else {
    break;
  }
}

// Linha 1563-1569: Loop similar para FALL
for (let i = digits.length - 1; i >= 0; i--) {
  if (digits[i] >= 5) {
    consecutiveHigh++;
  } else {
    break;
  }
}
```

**Impacto:**
- Loops executados para cada validação estatística
- Com múltiplos agentes, pode acumular processamento
- **Contribui para alto uso de CPU** quando combinado com análise técnica

**Solução Recomendada:**
- Otimização já implementada com buffer de dígitos
- Considerar cache de validação estatística por período curto

---

### 3. **Queries ao Banco de Dados Frequentes** ⚠️ MODERADO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts`

**Problema:**
- `getPriceHistory` pode fazer query ao banco se cache insuficiente
- `getBatchConfigs` faz queries para múltiplos usuários
- `saveLog` pode fazer queries frequentes (79 ocorrências no código)

**Código Problemático:**
```typescript
// Linha 3120-3150: getPriceHistory pode fazer query
const recentTrades = await this.dataSource.query(
  `SELECT entry_price, created_at 
   FROM autonomous_agent_trades 
   WHERE user_id = ? AND entry_price > 0 
   ORDER BY created_at DESC 
   LIMIT 50`,
  [userId],
);

// Linha 800-818: getBatchConfigs faz query para múltiplos usuários
const configs = await this.dataSource.query(
  `SELECT ... FROM autonomous_agent_config 
   WHERE user_id IN (${placeholders}) AND is_active = TRUE`,
  userIdsToFetch,
);
```

**Impacto:**
- Queries ao banco bloqueiam event loop do Node.js
- Com múltiplos agentes, queries simultâneas podem sobrecarregar
- **Pode causar lentidão e alto uso de CPU** se banco estiver lento

**Solução Recomendada:**
- Cache mais agressivo de configurações (já implementado com TTL)
- Batch queries otimizadas (já implementado)
- Considerar usar fila assíncrona para logs

---

### 4. **Processamento de Ticks em Loop** ⚠️ BAIXO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts` (linhas 3363-3386)

**Problema:**
- `processSharedTick` itera sobre todos os agentes ativos para cada tick
- Atualiza histórico de preços e buffer de dígitos para cada agente

**Código Problemático:**
```typescript
// Linha 3377-3385: Loop sobre todos os agentes para cada tick
for (const [userId, state] of this.agentStates.entries()) {
  if (state.symbol === this.sharedSymbol) {
    this.updatePriceHistory(userId, priceTick);
    this.updateDigitBuffer(userId, priceTick);
    this.analysisCache.delete(userId); // Invalida cache
  }
}
```

**Impacto:**
- Se houver muitos ticks por segundo, loop executa frequentemente
- Com 20+ agentes, pode acumular processamento
- **Pode contribuir para alto uso de CPU** em períodos de alta atividade

**Solução Recomendada:**
- Otimização já implementada (apenas agentes com símbolo correto)
- Considerar processamento em batch de ticks

---

### 5. **Cálculo de Pontuação de Direção Complexo** ⚠️ BAIXO

**Localização:** `backend/src/autonomous-agent/autonomous-agent.service.ts` (linhas 1321-1408)

**Problema:**
- `calculateDirectionScore` faz múltiplos cálculos matemáticos
- Executado duas vezes por análise (RISE e FALL)
- Cálculos com divisões e multiplicações

**Código Problemático:**
```typescript
// Linha 1336-1356: Cálculos complexos de pontuação EMA
const ema10vs25 = ema10 > ema25 ? Math.min(20, ((ema10 - ema25) / ema25) * 1000) : 0;
const ema25vs50 = ema25 > ema50 ? Math.min(20, ((ema25 - ema50) / ema50) * 1000) : 0;
// ... mais cálculos similares
```

**Impacto:**
- Cálculos executados para cada análise técnica
- Com múltiplos agentes, pode acumular
- **Contribui para uso de CPU**, mas não é o principal problema

**Solução Recomendada:**
- Otimização já implementada (cache de análise técnica)
- Considerar simplificar cálculos se necessário

---

## 📊 RESUMO DE IMPACTO

### Problemas Críticos (Podem causar 100% CPU):
1. ✅ **Processamento Sequencial de Análise Técnica** - Principal causa
2. ⚠️ **Validação Estatística com Loops** - Contribui significativamente

### Problemas Moderados (Podem causar lentidão):
3. ⚠️ **Queries ao Banco de Dados Frequentes** - Pode bloquear event loop
4. ⚠️ **Processamento de Ticks em Loop** - Pode acumular com muitos ticks

### Problemas Baixos (Contribuem pouco):
5. ⚠️ **Cálculo de Pontuação de Direção** - Já otimizado com cache

---

## ✅ OTIMIZAÇÕES JÁ IMPLEMENTADAS

1. **Cache de Análise Técnica** - Linha 1086-1092
2. **Cálculo Incremental de Indicadores** - Linhas 1098-1123
3. **Buffer de Dígitos** - Linhas 1445-1458
4. **Batch Queries** - Linhas 779-832
5. **Limite de Agentes por Ciclo** - Linha 725 (MAX_AGENTS_PER_CYCLE = 20)
6. **Processamento em Batches** - Linha 726 (BATCH_SIZE = 3)
7. **Delay entre Batches** - Linha 771 (100ms)

---

## 🎯 RECOMENDAÇÕES ADICIONAIS

### 1. Reduzir Frequência de Análise Técnica
```typescript
// Adicionar throttle para análise técnica
private lastAnalysisTime = new Map<string, number>();
private readonly ANALYSIS_THROTTLE_MS = 5000; // 5 segundos

if (Date.now() - (this.lastAnalysisTime.get(userId) || 0) < this.ANALYSIS_THROTTLE_MS) {
  // Reutilizar análise anterior do cache
  return cached.analysis;
}
```

### 2. Limitar Processamento por Agente
```typescript
// Processar apenas agentes que não processaram recentemente
const MIN_TIME_BETWEEN_PROCESSING = 10000; // 10 segundos
if (state.lastProcessedAt && Date.now() - state.lastProcessedAt < MIN_TIME_BETWEEN_PROCESSING) {
  return; // Pular este agente
}
```

### 3. Reduzir Logs em Produção
```typescript
// Desabilitar logs DEBUG em produção
private readonly ENABLE_DEBUG_LOGS = process.env.NODE_ENV === 'development';
```

### 4. Usar Worker Threads para Cálculos Pesados
```typescript
// Mover cálculos de EMA/RSI para worker thread se necessário
// Apenas se CPU ainda estiver alto após outras otimizações
```

---

## 📈 MONITORAMENTO RECOMENDADO

1. **Monitorar uso de CPU por processo**
2. **Rastrear tempo de execução de `performTechnicalAnalysis`**
3. **Monitorar número de queries ao banco por segundo**
4. **Rastrear número de agentes processados por ciclo**
5. **Monitorar frequência de ticks recebidos**

---

## 🔧 AÇÕES IMEDIATAS

1. ✅ Verificar se `ENABLE_DEBUG_LOGS` está desabilitado em produção
2. ✅ Reduzir `MAX_AGENTS_PER_CYCLE` se CPU ainda estiver alto (de 20 para 10)
3. ✅ Aumentar `BATCH_SIZE` delay (de 100ms para 200ms)
4. ✅ Adicionar throttle para análise técnica (5 segundos mínimo entre análises)
5. ✅ Monitorar logs para identificar agentes que processam muito frequentemente

---

*Documento criado em 2025-01-XX*

