-- ============================================
-- Migração: Alterar user_id de INT para VARCHAR(36) para suportar UUID
-- Data: 2025-12-03
-- ============================================

-- Desabilitar checagem de foreign keys temporariamente
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Tentar remover foreign key da tabela copy_trading_sessions se existir
SET @exist := (SELECT COUNT(*) 
               FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'copy_trading_sessions' 
               AND constraint_name = 'copy_trading_sessions_ibfk_1');

SET @sqlstmt := IF(@exist > 0, 
                   'ALTER TABLE copy_trading_sessions DROP FOREIGN KEY copy_trading_sessions_ibfk_1', 
                   'SELECT "FK copy_trading_sessions_ibfk_1 não existe, pulando..." as info');
PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Tentar remover fk_sessions_config se existir
SET @exist := (SELECT COUNT(*) 
               FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'copy_trading_sessions' 
               AND constraint_name = 'fk_sessions_config');

SET @sqlstmt := IF(@exist > 0, 
                   'ALTER TABLE copy_trading_sessions DROP FOREIGN KEY fk_sessions_config', 
                   'SELECT "FK fk_sessions_config não existe, pulando..." as info');
PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Remover foreign key da tabela copy_trading_operations se existir
SET @exist := (SELECT COUNT(*) 
               FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'copy_trading_operations' 
               AND constraint_type = 'FOREIGN KEY');

SET @sqlstmt := IF(@exist > 0, 
                   'ALTER TABLE copy_trading_operations DROP FOREIGN KEY copy_trading_operations_ibfk_1', 
                   'SELECT "FK copy_trading_operations_ibfk_1 não existe, pulando..." as info');
PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Alterar user_id em copy_trading_config
ALTER TABLE copy_trading_config 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- 3. Alterar user_id em copy_trading_sessions
ALTER TABLE copy_trading_sessions 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- 4. Recriar foreign key na tabela copy_trading_sessions
ALTER TABLE copy_trading_sessions 
ADD CONSTRAINT fk_sessions_config 
FOREIGN KEY (config_id) REFERENCES copy_trading_config(id) ON DELETE CASCADE;

-- 5. Verificar se copy_trading_operations existe e alterar se necessário
SET @table_exists = (SELECT COUNT(*) 
                     FROM information_schema.tables 
                     WHERE table_schema = DATABASE() 
                     AND table_name = 'copy_trading_operations');

SET @sql = IF(@table_exists > 0,
    'ALTER TABLE copy_trading_operations MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT "UUID do usuário"',
    'SELECT "Tabela copy_trading_operations não existe, pulando..." as info');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 6. Recriar foreign key na tabela copy_trading_operations se existir
SET @sql = IF(@table_exists > 0,
    'ALTER TABLE copy_trading_operations ADD CONSTRAINT fk_operations_session FOREIGN KEY (session_id) REFERENCES copy_trading_sessions(id) ON DELETE CASCADE',
    'SELECT "Tabela copy_trading_operations não existe, pulando FK..." as info');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Reabilitar checagem de foreign keys
SET FOREIGN_KEY_CHECKS = 1;

-- Mensagem de sucesso
SELECT 'Migração concluída com sucesso! user_id agora suporta UUID.' as status;

-- Verificar resultado
SELECT 
    'copy_trading_config' as tabela,
    COLUMN_NAME as campo,
    COLUMN_TYPE as tipo,
    IS_NULLABLE as nulo
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() 
AND TABLE_NAME = 'copy_trading_config' 
AND COLUMN_NAME = 'user_id'

UNION ALL

SELECT 
    'copy_trading_sessions' as tabela,
    COLUMN_NAME as campo,
    COLUMN_TYPE as tipo,
    IS_NULLABLE as nulo
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() 
AND TABLE_NAME = 'copy_trading_sessions' 
AND COLUMN_NAME = 'user_id'

UNION ALL

SELECT 
    'copy_trading_operations' as tabela,
    COLUMN_NAME as campo,
    COLUMN_TYPE as tipo,
    IS_NULLABLE as nulo
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() 
AND TABLE_NAME = 'copy_trading_operations' 
AND COLUMN_NAME = 'user_id';

