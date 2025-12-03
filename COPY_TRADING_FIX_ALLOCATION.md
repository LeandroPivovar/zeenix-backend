# ✅ Correção: allocation_value cannot be null

## 🔴 Problema
```
❌ Column 'allocation_value' cannot be null
```

Quando o tipo de alocação era **"proportion"** (proporção %), o frontend enviava:
- `allocation_value`: **null**
- `allocation_percentage`: 100

Mas a coluna `allocation_value` no banco **não aceita NULL**.

## ✅ Solução Implementada

### Backend: `copy-trading.service.ts`

Adicionada lógica para tratar os dois tipos de alocação:

```typescript
// Determinar allocation_value baseado no tipo de alocação
let allocationValue = 0.00;
let allocationPercentage = null;

if (configData.allocationType === 'proportion') {
  // Se for proporção, usar o percentual e setar value como 0
  allocationPercentage = configData.allocationPercentage || 100;
  allocationValue = 0.00;
} else {
  // Se for fixed, usar o valor fixo
  allocationValue = configData.allocationValue || 0.00;
  allocationPercentage = null;
}
```

### Como Funciona Agora:

#### 1️⃣ **Proporção (%)** - `allocation_type: 'proportion'`
- `allocation_value`: **0.00** (não usado, apenas placeholder)
- `allocation_percentage`: **100** (ou o valor configurado)
- **Comportamento**: Replica a mesma % de risco do trader mestre
- **Exemplo**: Se o mestre entrar com 2% do saldo, você entra com 2% do seu

#### 2️⃣ **Valor Fixo ($)** - `allocation_type: 'fixed'`
- `allocation_value`: **5.00** (ou o valor configurado)
- `allocation_percentage`: **null** (não usado)
- **Comportamento**: Replica o mesmo valor fixo do trader mestre
- **Exemplo**: Se o mestre entrar com $5, você entra com $5

## 🚀 Como Testar

### 1️⃣ Reiniciar o Backend
```bash
cd /var/www/zeenix/backend
pm2 restart zeenix
pm2 logs zeenix --lines 30
```

### 2️⃣ Testar no Frontend

#### Teste 1: Alocação por Proporção
1. Acesse Copy Trading
2. Selecione um trader
3. Escolha **"Proporção (%)"**
4. Configure stop loss e take profit
5. Clique em **"Ativar Copy"**

**Resultado esperado nos logs:**
```
✅ [ActivateCopyTrading] Tipo de alocação: proportion, Value: null, Percentage: 100
✅ [ActivateCopyTrading] Nova configuração criada para usuário ...
✅ [ActivateCopyTrading] Nova sessão criada (ID: X) para usuário ...
```

#### Teste 2: Alocação por Valor Fixo
1. Acesse Copy Trading
2. Selecione um trader
3. Escolha **"Valor Fixo ($)"**
4. Digite um valor (ex: 5.00)
5. Configure stop loss e take profit
6. Clique em **"Ativar Copy"**

**Resultado esperado nos logs:**
```
✅ [ActivateCopyTrading] Tipo de alocação: fixed, Value: 5, Percentage: null
✅ [ActivateCopyTrading] Nova configuração criada para usuário ...
✅ [ActivateCopyTrading] Nova sessão criada (ID: X) para usuário ...
```

### 3️⃣ Verificar no Banco

```bash
mysql -u root -p zeenix -e "SELECT id, user_id, allocation_type, allocation_value, allocation_percentage, trader_name, session_status FROM copy_trading_config ORDER BY id DESC LIMIT 3;"
```

**Resultado esperado:**
```
+----+--------------------------------------+-----------------+------------------+-----------------------+--------------+----------------+
| id | user_id                              | allocation_type | allocation_value | allocation_percentage | trader_name  | session_status |
+----+--------------------------------------+-----------------+------------------+-----------------------+--------------+----------------+
|  1 | a9e6dc41-8a6b-4077-a581-c66e64c926db | proportion      |             0.00 |                100.00 | expert teste | active         |
+----+--------------------------------------+-----------------+------------------+-----------------------+--------------+----------------+
```

```bash
mysql -u root -p zeenix -e "SELECT id, user_id, trader_name, status, started_at FROM copy_trading_sessions ORDER BY started_at DESC LIMIT 3;"
```

**Resultado esperado:**
```
+----+--------------------------------------+--------------+--------+---------------------+
| id | user_id                              | trader_name  | status | started_at          |
+----+--------------------------------------+--------------+--------+---------------------+
|  1 | a9e6dc41-8a6b-4077-a581-c66e64c926db | expert teste | active | 2025-12-03 17:00:00 |
+----+--------------------------------------+--------------+--------+---------------------+
```

## 🎯 Checklist de Sucesso

- [x] ✅ Código corrigido no backend
- [ ] ✅ Backend reiniciado
- [ ] ✅ Teste com "Proporção (%)" - Sessão criada
- [ ] ✅ Teste com "Valor Fixo ($)" - Sessão criada
- [ ] ✅ Verificado no banco - Dados salvos corretamente
- [ ] ✅ Teste "Pausar Copy" - Status mudou para 'paused'
- [ ] ✅ Teste "Retomar Copy" - Status voltou para 'active'

## 📊 Estrutura Final dos Dados

### copy_trading_config
```sql
user_id (VARCHAR 36) | trader_id | allocation_type | allocation_value | allocation_percentage
```

### copy_trading_sessions
```sql
id | user_id (VARCHAR 36) | config_id | trader_id | trader_name | status | started_at
```

## 🎉 Pronto!

Agora o Copy Trading deve funcionar completamente:
- ✅ Criar sessões
- ✅ Salvar configurações
- ✅ Suportar ambos os tipos de alocação
- ✅ Pausar e retomar

