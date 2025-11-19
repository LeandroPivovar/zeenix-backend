-- Script para permitir múltiplas sessões por usuário
-- Remove a constraint UNIQUE do user_id e adiciona colunas de controle de sessão

-- 1. Remover constraint UNIQUE do user_id (permitir múltiplas sessões)
ALTER TABLE ai_user_config 
DROP INDEX idx_user_id;

-- 2. Criar índice normal (não-unique) para user_id (para performance)
ALTER TABLE ai_user_config 
ADD INDEX idx_user_id (user_id);

-- 3. Adicionar índice composto para buscar sessão ativa rapidamente
ALTER TABLE ai_user_config 
ADD INDEX idx_user_active (user_id, is_active, created_at);

-- 4. Adicionar colunas de controle de desativação (se não existirem)
SET @db_name = DATABASE();

-- Verificar e adicionar deactivation_reason
SET @has_reason = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'deactivation_reason'
);

SET @sql_add_reason = IF(
    @has_reason = 0,
    'ALTER TABLE ai_user_config ADD COLUMN deactivation_reason TEXT NULL COMMENT ''Motivo da desativação (manual ou automática)'' AFTER updated_at',
    'SELECT ''Coluna deactivation_reason já existe'' AS message'
);

PREPARE stmt FROM @sql_add_reason;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar deactivated_at
SET @has_at = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'deactivated_at'
);

SET @sql_add_at = IF(
    @has_at = 0,
    'ALTER TABLE ai_user_config ADD COLUMN deactivated_at TIMESTAMP NULL COMMENT ''Data/hora da desativação'' AFTER deactivation_reason',
    'SELECT ''Coluna deactivated_at já existe'' AS message'
);

PREPARE stmt FROM @sql_add_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 5. Verificar resultado
SELECT 
    'Configuração de múltiplas sessões concluída!' AS status,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND INDEX_NAME = 'idx_user_id'
     AND NON_UNIQUE = 1) AS has_non_unique_index,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND COLUMN_NAME = 'deactivation_reason') AS has_reason_column,
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @db_name 
     AND TABLE_NAME = 'ai_user_config' 
     AND COLUMN_NAME = 'deactivated_at') AS has_at_column;

-- 6. Mostrar estrutura da tabela
SHOW CREATE TABLE ai_user_config;

