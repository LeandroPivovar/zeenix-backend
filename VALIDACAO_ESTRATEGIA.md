# Validação e Adaptação da Estratégia - Agente Autônomo Sentinel

**Data:** 11 de dezembro de 2025  
**Status:** Em validação

---

## 📋 Checklist de Validação

### ✅ O que está CORRETO

1. **Valores Financeiros**: ✅ Usuário define stake, stop loss e alvo de lucro
2. **Análise Técnica**: ✅ EMA tripla, RSI, Momentum implementados
3. **Análise de Dígitos**: ✅ Validação estatística implementada
4. **Logs**: ✅ Formato correto [TIMESTAMP] [LEVEL] [MODULE] - MESSAGE
5. **Martingale M0/M1**: ✅ Parcialmente implementado (Rise/Fall e Higher/Lower)

---

## ❌ O que precisa ser CORRIGIDO/IMPLEMENTADO

### 1. Trading Mode (CRÍTICO - NÃO IMPLEMENTADO)

**Problema:** Código sempre usa 50 ticks e score mínimo 80% fixo.

**Solução:**
- Adicionar campo `trading_mode` no banco (veloz, normal, lento)
- Implementar lógica:
  - **Veloz**: 10 ticks, score mínimo 65%
  - **Normal**: 20 ticks, score mínimo 75%
  - **Lento**: 50 ticks, score mínimo 80%

**Arquivos a modificar:**
- `backend/db/create_autonomous_agent_config.sql` - Adicionar coluna
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Implementar lógica

---

### 2. Fórmulas de Martingale (CRÍTICO - INCORRETAS)

**Problema:** 
- Não consulta payout via API (usa valores fixos)
- Não calcula `payout_cliente = payout_original - 3%`
- Multiplicador Conservador errado (1.15 ao invés de 1.0)
- Fórmula não segue padrão da documentação

**Solução:**
- Consultar payout via API antes de cada operação
- Calcular `payout_cliente = payout_original - 3`
- Corrigir fórmulas:
  - **Conservador**: `entrada = perdas_totais × 100 / payout_cliente`
  - **Moderado**: `entrada = (perdas_totais × 1.25) × 100 / payout_cliente`
  - **Agressivo**: `entrada = (perdas_totais × 1.50) × 100 / payout_cliente`

**Arquivos a modificar:**
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Método `executeTrade` e `handleTradeResult`

---

### 3. Martingale Inteligente (INCOMPLETO)

**Problema:** Só tem M0 e M1, falta M2 com Touch/No Touch.

**Solução:**
- Adicionar M2: Touch/No Touch (payout ~100%)
- Atualizar enum: `'M0' | 'M1' | 'M2'`
- Implementar lógica de transição M1 → M2

**Arquivos a modificar:**
- `backend/db/create_autonomous_agent_config.sql` - Atualizar ENUM
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Adicionar M2

---

### 4. Limite M5 para Conservador (NÃO IMPLEMENTADO)

**Problema:** Modo Conservador não tem limite de 5 níveis de Martingale.

**Solução:**
- Adicionar contador `martingale_count`
- Se Conservador e `martingale_count >= 5`: Aceitar perda e resetar
- Pausa de 15-30 segundos após M5

**Arquivos a modificar:**
- `backend/db/create_autonomous_agent_config.sql` - Adicionar coluna
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Implementar lógica

---

### 5. Soros (CRÍTICO - NÃO IMPLEMENTADO)

**Problema:** Sistema de Soros não existe.

**Solução:**
- Adicionar campos: `soros_level` (0, 1, 2), `soros_stake`
- Implementar lógica:
  - Após vitória M0: Ativar Soros Nível 1
  - Após vitória Soros 1: Ativar Soros Nível 2
  - Após vitória Soros 2: Resetar para M0
  - **Se derrota em qualquer nível**: Entrar em recuperação (Martingale)
- Soros Nível 1: `stake = initial_stake + lucro_anterior`
- Soros Nível 2: `stake = soros_stake_1 + lucro_soros_1`

**Arquivos a modificar:**
- `backend/db/create_autonomous_agent_config.sql` - Adicionar colunas
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Implementar lógica completa

---

### 6. Stop Loss Blindado (NÃO IMPLEMENTADO)

**Problema:** Só tem Stop Loss Normal.

**Solução:**
- Adicionar campo `stop_loss_type` (normal, blindado)
- Implementar lógica Blindado:
  - `lucro_protegido = lucro_acumulado × 0.50`
  - `saldo_blindado = banca_inicial + lucro_protegido`
  - Se saldo atual ≤ saldo_blindado: PARAR todas operações

**Arquivos a modificar:**
- `backend/db/create_autonomous_agent_config.sql` - Adicionar coluna
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Implementar lógica

---

### 7. Consulta de Payout via API (CRÍTICO - NÃO IMPLEMENTADO)

**Problema:** Usa valores fixos do `SENTINEL_CONFIG`.

**Solução:**
- Consultar payout via `proposal` antes de cada operação
- Calcular `payout_percentual = (payout / ask_price - 1) × 100`
- Calcular `payout_cliente = payout_percentual - 3`
- Usar `payout_cliente` em todos os cálculos

**Arquivos a modificar:**
- `backend/src/autonomous-agent/autonomous-agent.service.ts` - Método `executeTradeOnDeriv`

---

## 🔧 Plano de Implementação

### Fase 1: Banco de Dados
1. ✅ Adicionar coluna `trading_mode` (veloz, normal, lento)
2. ✅ Adicionar coluna `stop_loss_type` (normal, blindado)
3. ✅ Adicionar colunas `soros_level`, `soros_stake`
4. ✅ Adicionar coluna `martingale_count`
5. ✅ Atualizar ENUM `martingale_level` para incluir M2

### Fase 2: Trading Mode
1. Implementar lógica de coleta de ticks (10, 20, 50)
2. Implementar scores mínimos (65%, 75%, 80%)
3. Atualizar logs para mostrar modo ativo

### Fase 3: Payout via API
1. Consultar payout antes de cada operação
2. Calcular payout_cliente
3. Usar payout_cliente em todos os cálculos

### Fase 4: Martingale Corrigido
1. Corrigir multiplicador Conservador (1.0)
2. Implementar fórmulas corretas
3. Implementar limite M5 para Conservador
4. Implementar M2 (Touch/No Touch)

### Fase 5: Soros
1. Implementar lógica completa de Soros
2. Implementar recuperação após derrota no Soros
3. Atualizar logs

### Fase 6: Stop Loss Blindado
1. Implementar lógica de proteção de lucro
2. Atualizar verificação de limites

---

## 📊 Exemplo de Fluxo Correto (Modo Normal + Moderado)

```
1. Coletar 20 ticks (Trading Mode: Normal)
2. Análise técnica → Score: 78% (≥ 75% ✅)
3. Consultar payout via API → payout_original: 95%
4. Calcular payout_cliente: 95% - 3% = 92%
5. M0: Stake $10, Contrato Rise/Fall
6. Resultado: PERDA
7. Ativar M1: Calcular stake = (10 × 1.25) × 100 / 95 = $13.16
8. Contrato Higher/Lower (payout maior)
9. Resultado: VITÓRIA
10. Resetar Martingale, Ativar Soros Nível 1
11. Soros 1: Stake = $10 + $12.50 = $22.50
12. Resultado: VITÓRIA
13. Soros 2: Stake = $22.50 + $20.70 = $43.20
14. Resultado: VITÓRIA → Resetar para M0
```

---

## ✅ Critérios de Validação Final

- [ ] Trading Mode funciona corretamente (ticks e scores)
- [ ] Payout é consultado via API antes de cada operação
- [ ] Fórmulas de Martingale estão corretas
- [ ] Soros funciona com recuperação
- [ ] Stop Loss Blindado protege 50% do lucro
- [ ] Logs seguem formato da documentação
- [ ] Modo Conservador limita em M5
- [ ] Martingale Inteligente tem M0, M1, M2

---

**Próximo passo:** Começar implementação pela Fase 1 (Banco de Dados)


