# 🔧 Correção: Planos com is_active (0/1)

## 🔴 Problema Identificado

O banco de dados usa `is_active` como **0 ou 1** (TINYINT), mas o código estava buscando com `true` (boolean), resultando em array vazio.

## ✅ Correções Aplicadas

### **1️⃣ Backend (`plans.service.ts`)**

**ANTES** ❌
```typescript
where: { isActive: true }  // ❌ Não funciona com TINYINT
```

**DEPOIS** ✅
```typescript
where: { isActive: 1 as any }  // ✅ Funciona com TINYINT (0 ou 1)
```

### **2️⃣ Logs Adicionados**
```typescript
this.logger.log('[GetAllPlans] Buscando planos ativos...');
this.logger.log(`[GetAllPlans] Encontrados ${plans.length} planos`);
```

---

## 🚀 Como Corrigir no Servidor

### **1️⃣ Verificar Planos no Banco**
```bash
mysql -u root -p zeenix < /var/www/zeenix/backend/db/check_plans.sql
```

**Resultado esperado:**
```
+----------+--------------+----------+------------------------+
| id       | name         | slug     | Ativo (0=Não, 1=Sim)   |
+----------+--------------+----------+------------------------+
| plan-... | Plano Starter| starter  | 0 ou 1                 |
+----------+--------------+----------+------------------------+
```

### **2️⃣ Ativar Todos os Planos (se is_active = 0)**
```bash
mysql -u root -p zeenix < /var/www/zeenix/backend/db/activate_all_plans.sql
```

**OU manualmente:**
```bash
mysql -u root -p zeenix -e "UPDATE plans SET is_active = 1;"
```

### **3️⃣ Reiniciar o Backend**
```bash
cd /var/www/zeenix/backend
pm2 restart zeenix
```

### **4️⃣ Verificar Logs**
```bash
pm2 logs zeenix --lines 30 | grep GetAllPlans
```

**Deve mostrar:**
```
✅ [GetAllPlans] Buscando planos ativos...
✅ [GetAllPlans] Encontrados 3 planos
```

### **5️⃣ Testar API**
```bash
curl https://taxafacil.site/api/plans | jq
```

**Deve retornar os 3 planos:**
```json
[
  {
    "id": "plan-starter",
    "name": "Plano Starter",
    "slug": "starter",
    "price": 0,
    ...
  },
  {
    "id": "plan-pro",
    "name": "Plano Pro",
    "slug": "pro",
    "price": 67,
    ...
  },
  {
    "id": "plan-black",
    "name": "Zenix Black",
    "slug": "black",
    "price": 147,
    ...
  }
]
```

### **6️⃣ Testar Frontend**
Acesse: `/plans`

**Console deve mostrar:**
```
✅ [PlansView] Planos carregados: Array(3)
```

---

## 📋 **Tabela `plans` - Estrutura Correta**

```sql
CREATE TABLE plans (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100),
  slug VARCHAR(50) UNIQUE,
  price DECIMAL(10,2),
  currency VARCHAR(10) DEFAULT 'BRL',
  billing_period VARCHAR(20) DEFAULT 'month',
  features JSON,
  is_popular TINYINT(1) DEFAULT 0,      -- 0 ou 1
  is_recommended TINYINT(1) DEFAULT 0,   -- 0 ou 1
  is_active TINYINT(1) DEFAULT 1,        -- 0 ou 1 ✅
  display_order INT DEFAULT 0,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

---

## 🔍 **Troubleshooting**

### **Problema: Array vazio mesmo após ativar**

**Verificar:**
```bash
mysql -u root -p zeenix -e "
SELECT 
    name, 
    is_active, 
    CASE 
        WHEN is_active = 1 THEN 'Ativo' 
        ELSE 'Inativo' 
    END as Status 
FROM plans;
"
```

**Se `is_active` = 0:** Execute o script `activate_all_plans.sql`

### **Problema: Logs não aparecem**

**Verificar se backend foi reiniciado:**
```bash
pm2 restart zeenix
pm2 logs zeenix --lines 50
```

### **Problema: API retorna erro**

**Verificar conexão com banco:**
```bash
pm2 logs zeenix --err --lines 30
```

---

## 🎯 **Checklist de Verificação**

- [ ] ✅ Verificar `is_active` no banco (deve ser 0 ou 1)
- [ ] ✅ Ativar planos se necessário (`UPDATE plans SET is_active = 1`)
- [ ] ✅ Reiniciar backend (`pm2 restart zeenix`)
- [ ] ✅ Verificar logs (`[GetAllPlans] Encontrados X planos`)
- [ ] ✅ Testar API (`curl /api/plans`)
- [ ] ✅ Testar frontend (`/plans`)
- [ ] ✅ Ver 3 planos na tela

---

## 📊 **Dados Esperados no Banco**

```sql
INSERT INTO plans VALUES
('plan-starter', 'Plano Starter', 'starter', 0.00, 'BRL', 'month', 
 JSON_OBJECT(...), 0, 0, 1, 1, NOW(), NOW()),
('plan-pro', 'Plano Pro', 'pro', 67.00, 'BRL', 'month', 
 JSON_OBJECT(...), 1, 0, 1, 2, NOW(), NOW()),
('plan-black', 'Zenix Black', 'black', 147.00, 'BRL', 'month', 
 JSON_OBJECT(...), 0, 1, 1, 3, NOW(), NOW());
```

**Campos importantes:**
- `is_popular = 1` → Mostra badge "MAIS POPULAR"
- `is_recommended = 1` → Mostra badge "RECOMENDADO"
- `is_active = 1` → Plano aparece na lista
- `display_order` → Ordem de exibição (menor = primeiro)

---

## 🎉 **Pronto!**

Após seguir estes passos, os planos devem aparecer corretamente na tela! 🚀✨

