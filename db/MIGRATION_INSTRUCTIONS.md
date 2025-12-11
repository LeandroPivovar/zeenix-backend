# 🔄 Instruções de Migração - Copy Trading UUID

## ⚠️ Problema
O sistema está usando **UUIDs** (strings) para identificar usuários, mas as tabelas de Copy Trading foram criadas com `user_id INT UNSIGNED`, causando erro:
```
Truncated incorrect DOUBLE value: 'a9e6dc41-8a6b-4077-a581-c66e64c926db'
```

## ✅ Solução
Executar a migração para alterar o tipo de dado de `user_id` para `VARCHAR(36)` nas tabelas:
- `copy_trading_config`
- `copy_trading_sessions`
- `copy_trading_operations`

## 📋 Como Executar a Migração

### Opção 1: Via MySQL CLI (Recomendado)
```bash
# Conectar ao MySQL
mysql -u root -p

# Selecionar o banco de dados
USE zeenix;

# Executar o script de migração
source /var/www/zeenix/backend/db/migrate_copy_trading_uuid.sql;

# Verificar se foi aplicado
DESCRIBE copy_trading_config;
DESCRIBE copy_trading_sessions;
```

### Opção 2: Via Arquivo SQL Direto
```bash
# Executar direto do terminal
mysql -u root -p zeenix < /var/www/zeenix/backend/db/migrate_copy_trading_uuid.sql
```

### Opção 3: Via phpMyAdmin ou Ferramenta GUI
1. Acesse o phpMyAdmin
2. Selecione o banco `zeenix`
3. Vá em "SQL" no menu
4. Cole o conteúdo de `migrate_copy_trading_uuid.sql`
5. Execute

## 🔍 Verificação Pós-Migração

Após executar a migração, verificar se os campos foram alterados:

```sql
-- Verificar estrutura das tabelas
SHOW COLUMNS FROM copy_trading_config WHERE Field = 'user_id';
SHOW COLUMNS FROM copy_trading_sessions WHERE Field = 'user_id';
SHOW COLUMNS FROM copy_trading_operations WHERE Field = 'user_id';

-- Resultado esperado: Type = 'varchar(36)'
```

## 🔄 Reiniciar o Backend

Após a migração, reiniciar o backend:
```bash
cd /var/www/zeenix/backend
pm2 restart zeenix
pm2 logs zeenix --lines 50
```

## 📝 Notas Importantes

1. **Backup**: Recomenda-se fazer backup antes de executar a migração:
   ```bash
   mysqldump -u root -p zeenix copy_trading_config copy_trading_sessions copy_trading_operations > backup_copy_trading_$(date +%Y%m%d_%H%M%S).sql
   ```

2. **Tabelas vazias**: Se as tabelas estiverem vazias, a migração é segura e rápida.

3. **Dados existentes**: Se houver dados com `user_id` numérico, a migração irá convertê-los para string automaticamente.

4. **Foreign Keys**: A migração remove e recria as foreign keys automaticamente.

## ✨ Após a Migração

Após executar a migração com sucesso, o sistema de Copy Trading deve funcionar corretamente:
- ✅ Ativar Copy Trading
- ✅ Criar sessões
- ✅ Pausar Copy Trading
- ✅ Retomar Copy Trading
- ✅ Registrar operações

## 🆘 Troubleshooting

### Se a migração falhar:
1. Verificar se há constraints ou indexes que impedem a alteração
2. Remover manualmente as foreign keys antes de executar
3. Executar linha por linha do script de migração

### Se o erro persistir:
1. Verificar logs do backend: `pm2 logs zeenix`
2. Verificar estrutura das tabelas: `DESCRIBE copy_trading_config;`
3. Verificar se o campo realmente mudou para `varchar(36)`











