-- Script para atualizar tabela autonomous_agent_config para suportar Orion Strategy
-- Adiciona campos necessários e atualiza session_status para incluir stopped_blindado

-- 1. Adicionar campo agent_type se não existir
SET @dbname = DATABASE();
SET @tablename = 'autonomous_agent_config';
SET @columnname = 'agent_type';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (column_name = @columnname)
  ) > 0,
  'SELECT 1',
  CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' VARCHAR(20) DEFAULT ''orion'' COMMENT ''Tipo de agente: orion, sentinel, falcon'' AFTER symbol')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 2. Adicionar campo trading_mode se não existir
SET @columnname = 'trading_mode';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (column_name = @columnname)
  ) > 0,
  'SELECT 1',
  CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' VARCHAR(20) DEFAULT ''normal'' COMMENT ''Modo de trading: veloz, moderado, preciso, normal, lento'' AFTER agent_type')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 3. Adicionar campo initial_balance se não existir
SET @columnname = 'initial_balance';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (column_name = @columnname)
  ) > 0,
  'SELECT 1',
  CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' DECIMAL(10, 2) DEFAULT 0.00 COMMENT ''Saldo inicial da conta'' AFTER daily_loss_limit')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 4. Atualizar enum de session_status para incluir 'stopped_blindado'
ALTER TABLE autonomous_agent_config
MODIFY COLUMN session_status ENUM('active', 'stopped_profit', 'stopped_loss', 'stopped_blindado', 'paused') 
DEFAULT 'active'
COMMENT 'Status da sessão: active, stopped_profit, stopped_loss, stopped_blindado, paused';

-- 5. Alterar session_date de DATE para TIMESTAMP para melhor controle
ALTER TABLE autonomous_agent_config
MODIFY COLUMN session_date TIMESTAMP NULL COMMENT 'Data/hora da sessão atual';

-- 6. Adicionar índice idx_agent_type se não existir
SET @indexname = 'idx_agent_type';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (index_name = @indexname)
  ) > 0,
  'SELECT 1',
  CONCAT('CREATE INDEX ', @indexname, ' ON ', @tablename, '(agent_type)')
));
PREPARE createIndexIfNotExists FROM @preparedStatement;
EXECUTE createIndexIfNotExists;
DEALLOCATE PREPARE createIndexIfNotExists;

-- 7. Adicionar índice idx_session_status se não existir
SET @indexname = 'idx_session_status';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (index_name = @indexname)
  ) > 0,
  'SELECT 1',
  CONCAT('CREATE INDEX ', @indexname, ' ON ', @tablename, '(session_status)')
));
PREPARE createIndexIfNotExists FROM @preparedStatement;
EXECUTE createIndexIfNotExists;
DEALLOCATE PREPARE createIndexIfNotExists;

-- 8. Verificar se as alterações foram aplicadas
SELECT 
    COLUMN_NAME,
    COLUMN_TYPE,
    COLUMN_DEFAULT,
    COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'autonomous_agent_config'
    AND COLUMN_NAME IN ('agent_type', 'trading_mode', 'initial_balance', 'session_status', 'session_date')
ORDER BY ORDINAL_POSITION;

