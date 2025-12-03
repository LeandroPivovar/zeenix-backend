# ✅ Verificação dos Campos Copy Trading

## 📊 Campos que Devem ser Gravados

### 1️⃣ **Stop Loss** (USD)
- **Tipo**: DECIMAL(10, 2)
- **Valor padrão**: 250.00
- **Descrição**: Limite máximo de perda permitido
- **Exemplo**: Se configurar $250, ao perder $250, o copy para automaticamente

### 2️⃣ **Take Profit** (USD)
- **Tipo**: DECIMAL(10, 2)
- **Valor padrão**: 500.00
- **Descrição**: Meta de lucro diária
- **Exemplo**: Se configurar $500, ao lucrar $500, o copy para automaticamente

### 3️⃣ **Blind Stop Loss** (Blindagem)
- **Tipo**: BOOLEAN (0 = Inativo, 1 = Ativo)
- **Valor padrão**: 1 (Ativo)
- **Descrição**: Protege contra operações consecutivas fora do padrão
- **Exemplo**: Se ativo, o sistema monitora operações seguidas de perda

---

## 🔍 Como Verificar no Banco

### **Opção 1: Script Pronto**
```bash
cd /var/www/zeenix/backend
mysql -u root -p zeenix < db/verify_copy_trading_fields.sql
```

### **Opção 2: Consulta Manual**
```bash
mysql -u root -p zeenix -e "
SELECT 
    id, 
    trader_name,
    stop_loss as 'Stop Loss',
    take_profit as 'Take Profit',
    blind_stop_loss as 'Blind (0/1)',
    allocation_type,
    session_status
FROM copy_trading_config 
ORDER BY id DESC 
LIMIT 3;
"
```

---

## 📋 **Resultado Esperado:**

### **Após Ativar Copy Trading**

```
+----+--------------+------------+-------------+-----------+-----------------+----------------+
| id | trader_name  | Stop Loss  | Take Profit | Blind(0/1)| allocation_type | session_status |
+----+--------------+------------+-------------+-----------+-----------------+----------------+
|  1 | expert teste |     250.00 |      500.00 |         1 | proportion      | active         |
+----+--------------+------------+-------------+-----------+-----------------+----------------+
```

### **Nos Logs do Backend:**
```bash
pm2 logs zeenix --lines 30
```

**Deve aparecer:**
```
✅ [ActivateCopyTrading] Ativando copy trading para usuário a9e6dc41-...
✅ [ActivateCopyTrading] Tipo de alocação: proportion, Value: null, Percentage: 100
✅ [ActivateCopyTrading] Stop Loss: 250, Take Profit: 500, Blind Stop Loss: true
✅ [ActivateCopyTrading] Nova configuração criada para usuário a9e6dc41-...
✅ [ActivateCopyTrading] Nova sessão criada (ID: 1) para usuário a9e6dc41-...
```

---

## 🧪 **Teste Passo a Passo:**

### **1️⃣ Reiniciar Backend**
```bash
cd /var/www/zeenix/backend
pm2 restart zeenix
pm2 logs zeenix --lines 20
```

### **2️⃣ Ativar Copy Trading na Interface**
1. Acesse Copy Trading
2. Selecione um trader
3. Configure:
   - **Stop Loss**: 250 (ou outro valor)
   - **Take Profit**: 500 (ou outro valor)
   - **Blindagem**: Ativar ✅ (checkbox marcado)
4. Clique em **"Ativar Copy"**

### **3️⃣ Verificar Logs**
```bash
pm2 logs zeenix --lines 30 | grep -E "ActivateCopyTrading|Stop Loss|Take Profit"
```

### **4️⃣ Verificar no Banco**
```bash
mysql -u root -p zeenix -e "SELECT stop_loss, take_profit, blind_stop_loss FROM copy_trading_config ORDER BY id DESC LIMIT 1;"
```

**Resultado esperado:**
```
+------------+-------------+-----------------+
| stop_loss  | take_profit | blind_stop_loss |
+------------+-------------+-----------------+
|     250.00 |      500.00 |               1 |
+------------+-------------+-----------------+
```

---

## 🎯 **Checklist de Verificação:**

- [ ] ✅ Backend reiniciado
- [ ] ✅ Logs mostram os valores recebidos (Stop Loss, Take Profit, Blind Stop)
- [ ] ✅ Banco gravou os valores corretamente
- [ ] ✅ Valores aparecem na configuração salva
- [ ] ✅ Valores corretos mesmo alterando na interface

---

## 🔧 **Se os Valores Não Estiverem Sendo Salvos:**

### **Verificar Frontend**
No console do navegador (F12), ao clicar em "Ativar Copy":
```javascript
// Deve mostrar:
🚀 Ativando copy trading via API...
// E enviar no body:
{
  stopLoss: 250,
  takeProfit: 500,
  blindStopLoss: true,
  ...
}
```

### **Verificar Backend**
```bash
pm2 logs zeenix --err --lines 50
```

Se houver erro, vai aparecer aqui.

### **Verificar Tabela**
```bash
mysql -u root -p zeenix -e "DESCRIBE copy_trading_config;"
```

Verificar se as colunas existem:
- `stop_loss` DECIMAL(10,2)
- `take_profit` DECIMAL(10,2)
- `blind_stop_loss` BOOLEAN

---

## 🎉 **Pronto!**

Os campos **Stop Loss**, **Take Profit** e **Blind Stop Loss** devem estar sendo gravados corretamente agora.

Para verificar, basta:
1. Reiniciar o backend
2. Ativar copy trading
3. Verificar no banco com o script

**📄 Script de verificação:** `backend/db/verify_copy_trading_fields.sql`

