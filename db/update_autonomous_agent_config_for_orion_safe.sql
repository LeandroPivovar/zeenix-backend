-- Script SEGURO para atualizar tabela autonomous_agent_config para suportar Orion Strategy
-- Pode ser executado múltiplas vezes sem erros (ignora se campos/índices já existirem)

-- 1. Adicionar campo agent_type (ignora erro se já existir)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'autonomous_agent_config' 
     AND COLUMN_NAME = 'agent_type') > 0,
  'SELECT 1',
  'ALTER TABLE autonomous_agent_config ADD COLUMN agent_type VARCHAR(20) DEFAULT ''orion'' COMMENT ''Tipo de agente: orion, sentinel, falcon'' AFTER symbol'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Adicionar campo trading_mode (ignora erro se já existir)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'autonomous_agent_config' 
     AND COLUMN_NAME = 'trading_mode') > 0,
  'SELECT 1',
  'ALTER TABLE autonomous_agent_config ADD COLUMN trading_mode VARCHAR(20) DEFAULT ''normal'' COMMENT ''Modo de trading: veloz, moderado, preciso, normal, lento'' AFTER agent_type'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Adicionar campo initial_balance (ignora erro se já existir)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'autonomous_agent_config' 
     AND COLUMN_NAME = 'initial_balance') > 0,
  'SELECT 1',
  'ALTER TABLE autonomous_agent_config ADD COLUMN initial_balance DECIMAL(10, 2) DEFAULT 0.00 COMMENT ''Saldo inicial da conta'' AFTER daily_loss_limit'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Atualizar enum de session_status para incluir 'stopped_blindado'
ALTER TABLE autonomous_agent_config
MODIFY COLUMN session_status ENUM('active', 'stopped_profit', 'stopped_loss', 'stopped_blindado', 'paused') 
DEFAULT 'active'
COMMENT 'Status da sessão: active, stopped_profit, stopped_loss, stopped_blindado, paused';

-- 5. Alterar session_date de DATE para TIMESTAMP (se ainda não for TIMESTAMP)
SET @sql = (SELECT IF(
  (SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'autonomous_agent_config' 
     AND COLUMN_NAME = 'session_date') = 'timestamp',
  'SELECT 1',
  'ALTER TABLE autonomous_agent_config MODIFY COLUMN session_date TIMESTAMP NULL COMMENT ''Data/hora da sessão atual'''
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 6. Adicionar índice idx_agent_type (ignora erro se já existir)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'autonomous_agent_config' 
     AND INDEX_NAME = 'idx_agent_type') > 0,
  'SELECT 1',
  'CREATE INDEX idx_agent_type ON autonomous_agent_config(agent_type)'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 7. Adicionar índice idx_session_status (ignora erro se já existir)
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'autonomous_agent_config' 
     AND INDEX_NAME = 'idx_session_status') > 0,
  'SELECT 1',
  'CREATE INDEX idx_session_status ON autonomous_agent_config(session_status)'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

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

