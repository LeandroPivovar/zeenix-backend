# Plano de Implementação - Adaptação da Estratégia

## 📊 Status Atual vs. Documentação

### ✅ JÁ IMPLEMENTADO
1. Valores financeiros definidos pelo usuário ✅
2. Análise técnica (EMA, RSI, Momentum) ✅
3. Análise de dígitos ✅
4. Logs no formato correto ✅
5. Martingale M0/M1 básico ✅

### ❌ PRECISA IMPLEMENTAR/CORRIGIR

#### 🔴 CRÍTICO (Prioridade 1)

1. **Trading Mode** - NÃO IMPLEMENTADO
   - Atualmente: Sempre 50 ticks, score 80% fixo
   - Necessário: Veloz (10/65%), Normal (20/75%), Lento (50/80%)
   - **Status:** ✅ Interfaces atualizadas, ⏳ Lógica parcial

2. **Consulta de Payout via API** - NÃO IMPLEMENTADO
   - Atualmente: Usa valores fixos do SENTINEL_CONFIG
   - Necessário: Consultar via `proposal` antes de cada operação
   - Calcular `payout_cliente = payout_original - 3%`
   - **Status:** ⏳ Parcial (já consulta, mas não usa corretamente)

3. **Fórmulas de Martingale** - INCORRETAS
   - Atualmente: Multiplicador Conservador errado (1.15), não usa payout_cliente
   - Necessário: 
     - Conservador: `entrada = perdas_totais × 100 / payout_cliente`
     - Moderado: `entrada = (perdas_totais × 1.25) × 100 / payout_cliente`
     - Agressivo: `entrada = (perdas_totais × 1.50) × 100 / payout_cliente`
   - **Status:** ⏳ Parcial (fórmula existe mas incorreta)

#### 🟡 IMPORTANTE (Prioridade 2)

4. **Soros** - NÃO IMPLEMENTADO
   - Necessário: Sistema completo de 2 níveis com recuperação
   - **Status:** ❌ Não iniciado

5. **Martingale M2** - NÃO IMPLEMENTADO
   - Necessário: Touch/No Touch (payout ~100%)
   - **Status:** ⏳ Enum atualizado, falta lógica

6. **Limite M5 Conservador** - NÃO IMPLEMENTADO
   - Necessário: Aceitar perda após M5, pausa 15-30s
   - **Status:** ⏳ Campo adicionado, falta lógica

#### 🟢 DESEJÁVEL (Prioridade 3)

7. **Stop Loss Blindado** - NÃO IMPLEMENTADO
   - Necessário: Proteger 50% do lucro acumulado
   - **Status:** ⏳ Campo adicionado, falta lógica

---

## 🔧 Próximos Passos Imediatos

### Passo 1: Executar Script SQL
```bash
# Executar no banco de dados
mysql -u usuario -p database < backend/db/add_trading_mode_and_soros.sql
```

### Passo 2: Atualizar activateAgent
- Adicionar parâmetros `tradingMode` e `stopLossType`
- Salvar no banco de dados
- Inicializar `initialBalance` e `profitPeak`

### Passo 3: Corrigir Fórmulas de Martingale
- Consultar payout via API
- Calcular payout_cliente
- Aplicar fórmulas corretas

### Passo 4: Implementar Soros
- Lógica de ativação após vitória
- Cálculo de stake
- Recuperação após derrota

### Passo 5: Implementar M2 e Limite M5
- Adicionar M2 (Touch/No Touch)
- Implementar limite M5 para Conservador

### Passo 6: Implementar Stop Loss Blindado
- Calcular saldo_blindado
- Verificar antes de cada operação

---

## 📝 Notas Importantes

1. **Não quebrar funcionalidade existente**: As mudanças devem ser incrementais
2. **Testar cada fase**: Validar antes de prosseguir
3. **Logs são críticos**: Manter formato da documentação
4. **Payout sempre via API**: Nunca usar valores fixos

---

## ✅ Checklist de Validação Final

- [ ] Trading Mode funciona (ticks e scores corretos)
- [ ] Payout consultado via API antes de cada operação
- [ ] Fórmulas de Martingale corretas (usando payout_cliente)
- [ ] Soros funciona com recuperação
- [ ] M2 implementado (Touch/No Touch)
- [ ] Limite M5 funciona no Conservador
- [ ] Stop Loss Blindado protege 50% do lucro
- [ ] Logs seguem formato da documentação







