-- Adicionar colunas para rastrear desativação automática
-- Executar este script no banco de dados MySQL

-- Verificar se as colunas já existem antes de adicionar
SET @db_name = DATABASE();

-- Adicionar coluna deactivation_reason se não existir
SET @column_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'deactivation_reason'
);

SET @sql_add_reason = IF(
    @column_exists = 0,
    'ALTER TABLE ai_user_config ADD COLUMN deactivation_reason TEXT NULL COMMENT ''Motivo da desativação automática''',
    'SELECT ''Coluna deactivation_reason já existe'' AS message'
);

PREPARE stmt FROM @sql_add_reason;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Adicionar coluna deactivated_at se não existir
SET @column_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'deactivated_at'
);

SET @sql_add_at = IF(
    @column_exists = 0,
    'ALTER TABLE ai_user_config ADD COLUMN deactivated_at TIMESTAMP NULL COMMENT ''Data/hora da desativação automática''',
    'SELECT ''Coluna deactivated_at já existe'' AS message'
);

PREPARE stmt FROM @sql_add_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar resultado
SELECT 
    'Colunas adicionadas/verificadas com sucesso!' AS status,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND COLUMN_NAME = 'deactivation_reason') AS has_reason,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND COLUMN_NAME = 'deactivated_at') AS has_at;

