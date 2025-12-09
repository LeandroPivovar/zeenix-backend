# 🚀 Correção Rápida - Copy Trading UUID

## 🔴 Erro Atual
```
Truncated incorrect DOUBLE value: 'a9e6dc41-8a6b-4077-a581-c66e64c926db'
```

## ✅ Solução em 3 Passos

### 1️⃣ Executar Migração no Banco

**Opção A - Script Automatizado (Recomendado):**
```bash
cd /var/www/zeenix/backend/db
chmod +x run_migration.sh
./run_migration.sh
```

**Opção B - Manualmente via MySQL:**
```bash
mysql -u root -p zeenix < /var/www/zeenix/backend/db/migrate_copy_trading_uuid.sql
```

### 2️⃣ Reiniciar o Backend
```bash
cd /var/www/zeenix/backend
pm2 restart zeenix
```

### 3️⃣ Verificar Logs
```bash
pm2 logs zeenix --lines 30
```

## 🎯 O que a migração faz?

Altera o tipo do campo `user_id` de **INT** para **VARCHAR(36)** nas tabelas:
- ✅ `copy_trading_config`
- ✅ `copy_trading_sessions`
- ✅ `copy_trading_operations`

Isso permite que o sistema use **UUIDs** (strings) ao invés de números inteiros.

## 🔍 Verificar se funcionou

Após a migração, execute no MySQL:
```sql
USE zeenix;
DESCRIBE copy_trading_config;
```

**Resultado esperado:**
```
user_id | varchar(36) | NO | UNI | NULL |
```

## 💡 Testar Copy Trading

1. Acesse a interface de Copy Trading
2. Configure um trader
3. Clique em **"Ativar Copy"**
4. O sistema deve criar a sessão sem erros
5. Teste **"Pausar Copy"** e **"Retomar Copy"**

## 📞 Se o erro persistir

1. Verificar se a migração foi aplicada:
   ```sql
   SHOW COLUMNS FROM copy_trading_config WHERE Field = 'user_id';
   ```

2. Verificar logs do backend:
   ```bash
   pm2 logs zeenix --err --lines 50
   ```

3. Verificar se há dados antigos incompatíveis:
   ```sql
   SELECT user_id FROM copy_trading_config LIMIT 5;
   ```

## ⚠️ Backup (Opcional mas Recomendado)

Antes de executar a migração:
```bash
mysqldump -u root -p zeenix copy_trading_config copy_trading_sessions copy_trading_operations > backup_$(date +%Y%m%d_%H%M%S).sql
```

## 🎉 Pronto!

Após seguir estes passos, o Copy Trading deve funcionar corretamente com suporte a UUID.







