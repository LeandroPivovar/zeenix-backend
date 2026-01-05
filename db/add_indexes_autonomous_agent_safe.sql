-- ✅ OTIMIZAÇÃO #6: Indexação de Queries Frequentes (Versão Segura)
-- Adiciona índices compostos para melhorar performance das queries mais frequentes
-- Esta versão verifica se os índices existem antes de criar (compatível com MySQL)

-- Índice composto para queries de configuração ativa por usuário
-- Usado em: SELECT ... FROM autonomous_agent_config WHERE user_id = ? AND is_active = TRUE
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'autonomous_agent_config' 
    AND INDEX_NAME = 'idx_autonomous_agent_config_user_active'
);
SET @sql = IF(@index_exists = 0,
  'CREATE INDEX idx_autonomous_agent_config_user_active ON autonomous_agent_config(user_id, is_active)',
  'SELECT ''Índice idx_autonomous_agent_config_user_active já existe'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Índice composto para queries de trades por usuário ordenados por data
-- Nota: MySQL não suporta DESC em índices compostos em versões antigas
-- O índice sem DESC ainda melhora performance significativamente
-- Usado em: SELECT ... FROM autonomous_agent_trades WHERE user_id = ? ORDER BY created_at DESC
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'autonomous_agent_trades' 
    AND INDEX_NAME = 'idx_autonomous_agent_trades_user_created'
);
SET @sql = IF(@index_exists = 0,
  'CREATE INDEX idx_autonomous_agent_trades_user_created ON autonomous_agent_trades(user_id, created_at)',
  'SELECT ''Índice idx_autonomous_agent_trades_user_created já existe'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Índice para queries de atualização por user_id
-- Usado em: UPDATE autonomous_agent_config SET ... WHERE user_id = ?
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'autonomous_agent_config' 
    AND INDEX_NAME = 'idx_autonomous_agent_config_user_id'
);
SET @sql = IF(@index_exists = 0,
  'CREATE INDEX idx_autonomous_agent_config_user_id ON autonomous_agent_config(user_id)',
  'SELECT ''Índice idx_autonomous_agent_config_user_id já existe'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Índice para queries de trades por user_id
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'autonomous_agent_trades' 
    AND INDEX_NAME = 'idx_autonomous_agent_trades_user_id'
);
SET @sql = IF(@index_exists = 0,
  'CREATE INDEX idx_autonomous_agent_trades_user_id ON autonomous_agent_trades(user_id)',
  'SELECT ''Índice idx_autonomous_agent_trades_user_id já existe'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Índice para queries de trades por status e data (usado em estatísticas)
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'autonomous_agent_trades' 
    AND INDEX_NAME = 'idx_autonomous_agent_trades_status_created'
);
SET @sql = IF(@index_exists = 0,
  'CREATE INDEX idx_autonomous_agent_trades_status_created ON autonomous_agent_trades(status, created_at)',
  'SELECT ''Índice idx_autonomous_agent_trades_status_created já existe'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Índice para queries de trades por user_id e status
SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'autonomous_agent_trades' 
    AND INDEX_NAME = 'idx_autonomous_agent_trades_user_status'
);
SET @sql = IF(@index_exists = 0,
  'CREATE INDEX idx_autonomous_agent_trades_user_status ON autonomous_agent_trades(user_id, status)',
  'SELECT ''Índice idx_autonomous_agent_trades_user_status já existe'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
