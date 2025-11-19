-- Adicionar coluna session_status para rastrear status da sessão em relação a lucro/perda
-- Executar este script no banco de dados MySQL

SET @db_name = DATABASE();

-- Adicionar coluna session_status se não existir
SET @column_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'session_status'
);

SET @sql_add_status = IF(
    @column_exists = 0,
    'ALTER TABLE ai_user_config ADD COLUMN session_status VARCHAR(20) NULL DEFAULT NULL COMMENT ''Status da sessão: active, stopped_profit, stopped_loss'' AFTER is_active',
    'SELECT ''Coluna session_status já existe'' AS message'
);

PREPARE stmt FROM @sql_add_status;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar resultado
SELECT 
    'Coluna session_status adicionada/verificada com sucesso!' AS status,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND COLUMN_NAME = 'session_status') AS has_session_status;

