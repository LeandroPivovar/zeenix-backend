# Refatoração: SENTINEL receber MarketAnalysis já calculado
## Redução de CPU através de cálculo compartilhado

**Data:** 2025-01-XX  
**Status:** 📋 PROPOSTA DE IMPLEMENTAÇÃO

---

## 🎯 OBJETIVO

Refatorar o SENTINEL para receber `MarketAnalysis` já calculado (como o FALCON), reduzindo drasticamente o uso de CPU ao calcular a análise técnica **uma vez por símbolo** ao invés de **uma vez por agente**.

---

## 📊 BENEFÍCIOS ESPERADOS

### Antes (Atual)
- **20 agentes SENTINEL ativos = 20 cálculos de análise técnica**
- Cada agente calcula EMA, RSI, Momentum individualmente
- **CPU: 100%** com múltiplos agentes

### Depois (Refatorado)
- **20 agentes SENTINEL ativos = 1 cálculo de análise técnica** (compartilhado)
- Análise técnica calculada uma vez por símbolo e compartilhada
- **CPU: ~10-20%** (redução de 80-90%)

---

## 🔧 IMPLEMENTAÇÃO PROPOSTA

### 1. Criar Cache Compartilhado de MarketAnalysis

```typescript
// Adicionar ao AutonomousAgentService
private sharedMarketAnalysisCache = new Map<string, {
  marketAnalysis: MarketAnalysis;
  timestamp: number;
}>();
private readonly MARKET_ANALYSIS_CACHE_TTL = 2000; // 2 segundos
```

### 2. Método para Converter TechnicalAnalysis → MarketAnalysis

```typescript
/**
 * Converte TechnicalAnalysis para MarketAnalysis
 * Usado para compatibilidade com interface IAutonomousAgentStrategy
 */
private convertToMarketAnalysis(
  technicalAnalysis: TechnicalAnalysis,
  payout?: number
): MarketAnalysis {
  return {
    probability: technicalAnalysis.confidenceScore,
    signal: technicalAnalysis.direction === 'RISE' ? 'CALL' : 
            technicalAnalysis.direction === 'FALL' ? 'PUT' : null,
    payout: payout || 0, // Será obtido quando necessário
    confidence: technicalAnalysis.confidenceScore,
    details: {
      ema10: technicalAnalysis.ema10,
      ema25: technicalAnalysis.ema25,
      ema50: technicalAnalysis.ema50,
      rsi: technicalAnalysis.rsi,
      momentum: technicalAnalysis.momentum,
      direction: technicalAnalysis.direction,
      reasoning: technicalAnalysis.reasoning,
    },
  };
}
```

### 3. Método para Obter/Criar MarketAnalysis Compartilhado

```typescript
/**
 * Obtém MarketAnalysis compartilhado para um símbolo
 * Calcula uma vez e compartilha entre todos os agentes do mesmo símbolo
 */
private async getSharedMarketAnalysis(symbol: string): Promise<MarketAnalysis | null> {
  const cacheKey = symbol;
  const cached = this.sharedMarketAnalysisCache.get(cacheKey);
  
  // Verificar se cache é válido
  if (cached && (Date.now() - cached.timestamp) < this.MARKET_ANALYSIS_CACHE_TTL) {
    return cached.marketAnalysis;
  }

  // Buscar histórico de preços (usar primeiro agente ativo do símbolo como referência)
  const activeAgentForSymbol = Array.from(this.agentStates.values())
    .find(state => state.symbol === symbol);
  
  if (!activeAgentForSymbol) {
    return null;
  }

  const prices = await this.getPriceHistory(activeAgentForSymbol.userId, symbol);
  
  if (prices.length < 20) {
    return null; // Histórico insuficiente
  }

  // Calcular análise técnica (uma vez por símbolo)
  const recentPrices = prices.slice(-50); // Usar últimos 50 ticks
  const technicalAnalysis = this.performTechnicalAnalysis(recentPrices, 'shared');

  // Converter para MarketAnalysis
  const marketAnalysis = this.convertToMarketAnalysis(technicalAnalysis);

  // Armazenar no cache compartilhado
  this.sharedMarketAnalysisCache.set(cacheKey, {
    marketAnalysis,
    timestamp: Date.now(),
  });

  return marketAnalysis;
}
```

### 4. Refatorar processAgent para Usar MarketAnalysis

```typescript
/**
 * ✅ REFATORADO: Processa agente usando MarketAnalysis compartilhado
 */
private async processAgent(state: AutonomousAgentState): Promise<void> {
  try {
    // Obter configuração do Trading Mode
    const tradingConfig = SENTINEL_CONFIG.tradingModes[state.tradingMode];
    const ticksRequired = tradingConfig.ticksRequired;
    const minConfidenceScore = tradingConfig.minConfidenceScore;

    // ✅ NOVO: Obter MarketAnalysis compartilhado (calculado uma vez por símbolo)
    const marketAnalysis = await this.getSharedMarketAnalysis(state.symbol);
    
    if (!marketAnalysis) {
      this.logger.debug(`[ProcessAgent][${state.userId}] MarketAnalysis não disponível. Aguardando...`);
      const interval = Math.min(30, this.getRandomInterval());
      this.updateNextTradeAt(state.userId, interval);
      return;
    }

    // Verificar se há histórico suficiente (para validação estatística)
    const prices = await this.getPriceHistory(state.userId, state.symbol);
    if (prices.length < ticksRequired) {
      this.logger.debug(`[ProcessAgent][${state.userId}] Histórico insuficiente (${prices.length}/${ticksRequired}). Aguardando mais ticks...`);
      const interval = Math.min(30, this.getRandomInterval());
      this.updateNextTradeAt(state.userId, interval);
      return;
    }

    // Verificar score de confiança (usando mínimo do Trading Mode)
    if (marketAnalysis.confidence < minConfidenceScore) {
      this.saveLog(
        state.userId,
        'DEBUG',
        'DECISION',
        `Sinal invalidado. motivo="Pontuação de confiança muito baixa", confiança=${marketAnalysis.confidence.toFixed(1)}%, mínimo_requerido=${minConfidenceScore}%`,
        { confidence: marketAnalysis.confidence, minRequired: minConfidenceScore, tradingMode: state.tradingMode },
      );
      const interval = this.getRandomInterval();
      this.updateNextTradeAt(state.userId, interval);
      return;
    }

    // Converter MarketAnalysis de volta para TechnicalAnalysis (para compatibilidade)
    const technicalAnalysis: TechnicalAnalysis = {
      ema10: marketAnalysis.details?.ema10 || 0,
      ema25: marketAnalysis.details?.ema25 || 0,
      ema50: marketAnalysis.details?.ema50 || 0,
      rsi: marketAnalysis.details?.rsi || 50,
      momentum: marketAnalysis.details?.momentum || 0,
      confidenceScore: marketAnalysis.confidence,
      direction: marketAnalysis.signal === 'CALL' ? 'RISE' : 
                 marketAnalysis.signal === 'PUT' ? 'FALL' : null,
      reasoning: marketAnalysis.details?.reasoning || '',
    };

    // Verificar confirmação estatística (dígitos)
    if (!(await this.validateStatisticalConfirmation(prices, technicalAnalysis.direction, state.userId))) {
      this.saveLog(
        state.userId,
        'DEBUG',
        'DECISION',
        `Sinal invalidado. motivo="Confirmação estatística falhou"`,
      );
      const interval = this.getRandomInterval();
      await this.updateNextTradeAt(state.userId, interval);
      return;
    }

    // Log de sinal encontrado
    this.saveLog(
      state.userId,
      'INFO',
      'ANALYZER',
      `Sinal encontrado. direção=${technicalAnalysis.direction}, confiança=${marketAnalysis.confidence.toFixed(1)}%`,
      {
        direction: technicalAnalysis.direction,
        confidence: marketAnalysis.confidence,
        ema10: technicalAnalysis.ema10,
        ema25: technicalAnalysis.ema25,
        ema50: technicalAnalysis.ema50,
        rsi: technicalAnalysis.rsi,
        momentum: technicalAnalysis.momentum,
      },
    );

    this.logger.log(`[ProcessAgent][${state.userId}] ✅ Sinal válido encontrado! Executando trade...`);

    // Executar operação
    await this.executeTrade(state, technicalAnalysis);
  } catch (error) {
    this.logger.error(`[ProcessAgent][${state.userId}] Erro:`, error);
    this.saveLog(
      state.userId,
      'ERROR',
      'CORE',
      `Erro ao processar agente. erro=${error.message}`,
      { error: error.message, stack: error.stack },
    );
  }
}
```

### 5. Invalidar Cache quando Novo Tick Chegar

```typescript
/**
 * ✅ REFATORADO: Processa tick compartilhado e invalida cache de MarketAnalysis
 */
private processSharedTick(tick: any): void {
  if (!tick || tick.quote === undefined) {
    return;
  }

  const priceTick: PriceTick = {
    value: parseFloat(tick.quote),
    epoch: tick.epoch || Math.floor(Date.now() / 1000),
    timestamp: tick.epoch
      ? new Date(tick.epoch * 1000).toISOString()
      : new Date().toISOString(),
  };

  // ✅ NOVO: Invalidar cache de MarketAnalysis quando novo tick chegar
  this.sharedMarketAnalysisCache.delete(this.sharedSymbol);

  // Distribuir tick para todos os agentes ativos com o símbolo correto
  for (const [userId, state] of this.agentStates.entries()) {
    if (state.symbol === this.sharedSymbol) {
      this.updatePriceHistory(userId, priceTick);
      this.updateDigitBuffer(userId, priceTick);
      this.analysisCache.delete(userId); // Manter invalidação individual também
    }
  }
}
```

---

## 📝 ALTERAÇÕES NECESSÁRIAS

### Arquivos a Modificar:

1. **`backend/src/autonomous-agent/autonomous-agent.service.ts`**
   - Adicionar `sharedMarketAnalysisCache`
   - Adicionar método `convertToMarketAnalysis()`
   - Adicionar método `getSharedMarketAnalysis()`
   - Refatorar `processAgent()` para usar MarketAnalysis compartilhado
   - Modificar `processSharedTick()` para invalidar cache compartilhado

### Compatibilidade:

- ✅ Mantém compatibilidade com código existente
- ✅ `executeTrade()` continua recebendo `TechnicalAnalysis`
- ✅ Validação estatística continua funcionando
- ✅ Logs e métricas permanecem iguais

---

## 🚀 IMPACTO ESPERADO

### Redução de CPU:
- **Antes:** 20 agentes = 20 cálculos de análise técnica
- **Depois:** 20 agentes = 1 cálculo de análise técnica
- **Redução:** ~95% no processamento de análise técnica

### Escalabilidade:
- ✅ Suporta 100+ agentes com baixo uso de CPU
- ✅ Cache compartilhado reduz carga significativamente
- ✅ Invalidação automática quando novo tick chega

---

## ⚠️ CONSIDERAÇÕES

1. **Cache TTL:** 2 segundos é suficiente para manter análise atualizada
2. **Histórico:** Usa histórico do primeiro agente ativo do símbolo como referência
3. **Validação Estatística:** Continua usando histórico individual por usuário (necessário para buffer de dígitos)
4. **Payout:** Será obtido quando necessário (durante `executeTrade`)

---

## ✅ TESTES RECOMENDADOS

1. Testar com 1 agente SENTINEL ativo
2. Testar com 10 agentes SENTINEL ativos
3. Testar com 20+ agentes SENTINEL ativos
4. Verificar uso de CPU antes e depois
5. Verificar que trades continuam funcionando corretamente
6. Verificar que validação estatística continua funcionando

---

*Documento criado em 2025-01-XX*




