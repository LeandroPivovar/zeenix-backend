-- Adicionar coluna session_balance para rastrear o saldo atual da sessão (lucro/perda acumulado)
-- Executar este script no banco de dados MySQL

SET @db_name = DATABASE();

-- Adicionar coluna session_balance se não existir
SET @column_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'session_balance'
);

SET @sql_add_balance = IF(
    @column_exists = 0,
    'ALTER TABLE ai_user_config ADD COLUMN session_balance DECIMAL(10, 2) NULL DEFAULT 0.00 COMMENT ''Saldo atual da sessão (lucro/perda acumulado)'' AFTER session_status',
    'SELECT ''Coluna session_balance já existe'' AS message'
);

PREPARE stmt FROM @sql_add_balance;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar resultado
SELECT 
    'Coluna session_balance adicionada/verificada com sucesso!' AS status,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND COLUMN_NAME = 'session_balance') AS has_session_balance;

