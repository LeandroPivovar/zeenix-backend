# 🎯 SOLUÇÃO: Pool de WebSocket Compartilhado para Agente Autônomo

## 🔍 Problema Identificado

**Situação Atual:**
- ✅ **IAs (Orion, Nexus, etc.)**: Funcionam 100% - Usam pool próprio dentro de cada estratégia
- ❌ **Agente Autônomo (Orion)**: Não funciona - Delega para a IA Orion, mas usa o pool da IA
- ✅ **Agente Autônomo (Falcon, Sentinel)**: Funcionam - Usam `DerivWebSocketPoolService` (pool compartilhado)

## 💡 Descoberta Principal

**As estratégias Falcon e Sentinel do Agente Autônomo JÁ USAM um pool compartilhado!**

```typescript
// Falcon Strategy (FUNCIONA)
import { DerivWebSocketPoolService } from '../../broker/deriv-websocket-pool.service';

constructor(
  @InjectDataSource() private readonly dataSource: DataSource,
  @Inject(forwardRef(() => DerivWebSocketPoolService))
  private readonly derivPool: DerivWebSocketPoolService, // ✅ Pool compartilhado
  @Inject(forwardRef(() => LogQueueService))
  private readonly logQueueService?: LogQueueService,
) {}
```

**Enquanto a Orion Strategy da IA usa pool próprio:**

```typescript
// Orion Strategy (IA - FUNCIONA)
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
> = new Map(); // ✅ Pool próprio dentro da estratégia
```

## 🔧 Solução

### Opção 1: Usar DerivWebSocketPoolService na Orion Strategy (RECOMENDADO)

**Vantagens:**
- ✅ Pool único compartilhado entre todas as estratégias
- ✅ Gerenciamento centralizado de conexões
- ✅ Menos duplicação de código
- ✅ Mais fácil de manter e debugar
- ✅ Já testado e funcionando no Falcon e Sentinel

**Implementação:**

```typescript
// 1. Modificar src/ai/strategies/orion.strategy.ts

import { DerivWebSocketPoolService } from '../../broker/deriv-websocket-pool.service';

@Injectable()
export class OrionStrategy {
  // ❌ REMOVER pool próprio
  // private wsConnections: Map<...> = new Map();

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
    @Inject(forwardRef(() => DerivWebSocketPoolService))
    private readonly derivPool: DerivWebSocketPoolService, // ✅ Injetar pool compartilhado
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  // ✅ Substituir getOrCreateWebSocketConnection() por derivPool.sendRequest()
  private async executeOrionTradeViaWebSocket(
    token: string,
    contractParams: {
      contract_type: 'DIGITEVEN' | 'DIGITODD';
      amount: number;
      currency: string;
    },
    userId?: string,
  ): Promise<{ contractId: string; profit: number; exitSpot: any } | null> {
    try {
      // PASSO 1: Solicitar proposta usando pool compartilhado
      const proposalResponse = await this.derivPool.sendRequest(token, {
        proposal: 1,
        amount: contractParams.amount,
        basis: 'stake',
        contract_type: contractParams.contract_type,
        currency: contractParams.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        symbol: this.symbol,
      });

      // PASSO 2: Comprar contrato
      const proposalId = proposalResponse.proposal?.id;
      const proposalPrice = Number(proposalResponse.proposal?.ask_price);

      const buyResponse = await this.derivPool.sendRequest(token, {
        buy: proposalId,
        price: proposalPrice,
      });

      const contractId = buyResponse.buy?.contract_id;

      // PASSO 3: Monitorar contrato
      return new Promise((resolve) => {
        this.derivPool.subscribe(
          token,
          {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
          },
          (msg: any) => {
            const contract = msg.proposal_open_contract;
            if (contract.is_sold || contract.status === 'won' || contract.status === 'lost') {
              const profit = Number(contract.profit || 0);
              const exitSpot = contract.exit_spot || contract.current_spot;
              
              // Cancelar subscription
              this.derivPool.removeSubscription(token, contractId);
              
              resolve({ contractId, profit, exitSpot });
            }
          },
          contractId,
          90000
        );
      });
    } catch (error) {
      this.logger.error(`[ORION] ❌ Erro ao executar trade via pool:`, error);
      return null;
    }
  }
}
```

### Opção 2: Manter Pools Separados (NÃO RECOMENDADO)

**Desvantagens:**
- ❌ Duplicação de código
- ❌ Mais difícil de manter
- ❌ Mais difícil de debugar
- ❌ Mais consumo de recursos (múltiplas conexões WebSocket)

## 📊 Comparação de Arquiteturas

| Aspecto | Pool Próprio (Atual) | Pool Compartilhado (Recomendado) |
|---------|---------------------|----------------------------------|
| **Conexões WebSocket** | Uma por token por estratégia | Uma por token (global) |
| **Gerenciamento** | Cada estratégia gerencia | Centralizado no `DerivWebSocketPoolService` |
| **Manutenção** | Difícil (código duplicado) | Fácil (código centralizado) |
| **Debug** | Difícil (múltiplos pools) | Fácil (pool único) |
| **Recursos** | Alto (múltiplas conexões) | Baixo (conexões compartilhadas) |
| **Testado** | Sim (IAs) | Sim (Falcon, Sentinel) |
| **Funcionamento** | ✅ IAs funcionam | ✅ Falcon/Sentinel funcionam |

## 🚀 Implementação Passo a Passo

### 1. Adicionar DerivWebSocketPoolService ao AiModule

```typescript
// src/ai/ai.module.ts

import { BrokerModule } from '../broker/broker.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    forwardRef(() => CopyTradingModule),
    forwardRef(() => AutonomousAgentModule),
    BrokerModule, // ✅ Importar BrokerModule para ter acesso ao DerivWebSocketPoolService
  ],
  providers: [
    AiService,
    StatsIAsService,
    StrategyManagerService,
    OrionStrategy, // ✅ Orion Strategy agora usará o pool compartilhado
    NexusStrategy,
    AtlasStrategy,
    // ... outras estratégias
  ],
  exports: [
    AiService,
    StatsIAsService,
    StrategyManagerService,
    OrionStrategy,
    // ... outras estratégias
  ],
})
export class AiModule {}
```

### 2. Modificar Orion Strategy

```typescript
// src/ai/strategies/orion.strategy.ts

import { DerivWebSocketPoolService } from '../../broker/deriv-websocket-pool.service';

@Injectable()
export class OrionStrategy {
  // ❌ REMOVER
  // private wsConnections: Map<...> = new Map();

  constructor(
    private dataSource: DataSource,
    private tradeEvents: TradeEventsService,
    @Inject(forwardRef(() => DerivWebSocketPoolService))
    private readonly derivPool: DerivWebSocketPoolService, // ✅ Adicionar
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  // ❌ REMOVER métodos de gerenciamento de WebSocket próprio
  // - getOrCreateWebSocketConnection()
  // - sendRequestViaConnection()
  // - subscribeViaConnection()
  // - removeSubscriptionFromConnection()

  // ✅ USAR derivPool.sendRequest() e derivPool.subscribe()
  private async executeOrionTradeViaWebSocket(...) {
    // Ver código acima
  }
}
```

### 3. Testar

```bash
# 1. Reiniciar servidor
npm run start:dev

# 2. Ativar agente autônomo com Orion
# 3. Verificar logs
# 4. Confirmar que está usando o pool compartilhado
```

## 📝 Checklist de Implementação

- [ ] Importar `BrokerModule` no `AiModule`
- [ ] Injetar `DerivWebSocketPoolService` na `OrionStrategy`
- [ ] Remover pool próprio (`wsConnections`) da `OrionStrategy`
- [ ] Substituir `getOrCreateWebSocketConnection()` por `derivPool.sendRequest()`
- [ ] Substituir métodos de WebSocket próprios por métodos do pool
- [ ] Testar com IA Orion (deve continuar funcionando)
- [ ] Testar com Agente Autônomo Orion (deve começar a funcionar)
- [ ] Verificar logs para confirmar uso do pool compartilhado
- [ ] Atualizar outras estratégias (Nexus, Atlas, etc.) se necessário

## 🎯 Resultado Esperado

Após a implementação:

- ✅ **IAs**: Continuam funcionando 100%
- ✅ **Agente Autônomo (Orion)**: Começa a funcionar 100%
- ✅ **Agente Autônomo (Falcon, Sentinel)**: Continuam funcionando 100%
- ✅ **Pool único**: Todas as estratégias compartilham o mesmo pool
- ✅ **Menos recursos**: Menos conexões WebSocket abertas
- ✅ **Mais fácil de manter**: Código centralizado

## 🔍 Como Verificar se Está Funcionando

### 1. Logs do Pool

```bash
# Verificar se está usando o pool compartilhado
grep "DerivWebSocketPoolService" logs/backend.log

# Deve aparecer:
# [DerivWebSocketPoolService] 🔌 Criando nova conexão para token abc123...
# [DerivWebSocketPoolService] ✅ Conexão autorizada para token abc123...
# [DerivWebSocketPoolService] 📤 Enviando requisição: proposal...
# [DerivWebSocketPoolService] 📥 Resposta recebida: proposal...
```

### 2. Logs da Orion

```bash
# Verificar se a Orion está usando o pool
grep "ORION.*pool" logs/backend.log

# Deve aparecer:
# [ORION] 📤 Solicitando proposta via pool...
# [ORION] 💰 Comprando contrato via pool...
# [ORION] 👁️ Monitorando contrato via pool...
```

### 3. Verificar Conexões WebSocket

```bash
# Verificar quantas conexões WebSocket estão abertas
netstat -an | grep 443 | grep ESTABLISHED | wc -l

# Antes: Múltiplas conexões (uma por estratégia)
# Depois: Menos conexões (pool compartilhado)
```

## 📚 Referências

- `src/broker/deriv-websocket-pool.service.ts` - Implementação do pool compartilhado
- `src/autonomous-agent/strategies/falcon.strategy.ts` - Exemplo de uso do pool (FUNCIONA)
- `src/autonomous-agent/strategies/sentinel.strategy.ts` - Exemplo de uso do pool (FUNCIONA)
- `src/ai/strategies/orion.strategy.ts` - Estratégia que precisa ser modificada

## 🎉 Conclusão

A solução é **simples e já está testada**: usar o `DerivWebSocketPoolService` que já existe e já funciona no Falcon e Sentinel!

**Benefícios:**
- ✅ Resolve o problema do Agente Autônomo Orion
- ✅ Unifica a arquitetura (todas as estratégias usam o mesmo pool)
- ✅ Reduz consumo de recursos
- ✅ Facilita manutenção e debug
- ✅ Código mais limpo e organizado
