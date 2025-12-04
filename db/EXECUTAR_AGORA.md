# 🚨 EXECUTE ESTES COMANDOS AGORA

## 📍 Você está em: `/var/www/zeenix/backend`

### 1️⃣ Executar a migração SQL (copie e cole):

```bash
mysql -u root -p zeenix < db/fix_uuid_now.sql
```

Digite a senha do MySQL quando solicitar.

### 2️⃣ Reiniciar o backend:

```bash
pm2 restart zeenix
```

### 3️⃣ Verificar se funcionou:

```bash
pm2 logs zeenix --lines 20
```

## ✅ O que você deve ver:

Se funcionou, ao testar ativar/pausar copy trading, NÃO deve mais aparecer o erro:
```
❌ Truncated incorrect DOUBLE value: 'a9e6dc41-8a6b-4077-a581-c66e64c926db'
```

E deve aparecer:
```
✅ [CopyTradingService] Nova sessão criada (ID: X) para usuário a9e6dc41-...
```

## 🔍 Verificar no banco (opcional):

```bash
mysql -u root -p zeenix -e "DESCRIBE copy_trading_config;"
```

Procure pela linha:
```
user_id | varchar(36) | NO | UNI | NULL |
```

---

## ⚠️ Se der erro "Table doesn't exist":

Execute primeiro:
```bash
mysql -u root -p zeenix < db/create_copy_trading_config.sql
mysql -u root -p zeenix < db/create_copy_trading_sessions.sql
mysql -u root -p zeenix < db/create_copy_trading_operations.sql
```

Depois execute novamente o passo 1.


