-- Adicionar campos de Alvo de Lucro e Limite de Perda na tabela ai_user_config
-- Também adicionar campo mode para controlar o modo de operação

-- Verificar e adicionar coluna profit_target
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'profit_target'
);

SET @sql_add_profit_target := IF(
  @col_exists = 0,
  'ALTER TABLE ai_user_config ADD COLUMN profit_target DECIMAL(10, 2) DEFAULT NULL COMMENT ''Meta diária de lucro em USD'';',
  'SELECT 1;'
);

PREPARE stmt_add_profit_target FROM @sql_add_profit_target;
EXECUTE stmt_add_profit_target;
DEALLOCATE PREPARE stmt_add_profit_target;

-- Verificar e adicionar coluna loss_limit
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'loss_limit'
);

SET @sql_add_loss_limit := IF(
  @col_exists = 0,
  'ALTER TABLE ai_user_config ADD COLUMN loss_limit DECIMAL(10, 2) DEFAULT NULL COMMENT ''Stop loss diário em USD'';',
  'SELECT 1;'
);

PREPARE stmt_add_loss_limit FROM @sql_add_loss_limit;
EXECUTE stmt_add_loss_limit;
DEALLOCATE PREPARE stmt_add_loss_limit;

-- Verificar e adicionar coluna mode
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME = 'mode'
);

SET @sql_add_mode := IF(
  @col_exists = 0,
  'ALTER TABLE ai_user_config ADD COLUMN mode VARCHAR(20) DEFAULT ''veloz'' COMMENT ''Modo de negociação: veloz, moderate, slow'';',
  'SELECT 1;'
);

PREPARE stmt_add_mode FROM @sql_add_mode;
EXECUTE stmt_add_mode;
DEALLOCATE PREPARE stmt_add_mode;

-- Criar índice para facilitar consultas por mode (se não existir)
SET @idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ai_user_config'
    AND INDEX_NAME = 'idx_mode'
);

SET @sql_add_idx := IF(
  @idx_exists = 0,
  'CREATE INDEX idx_mode ON ai_user_config(mode);',
  'SELECT 1;'
);

PREPARE stmt_add_idx FROM @sql_add_idx;
EXECUTE stmt_add_idx;
DEALLOCATE PREPARE stmt_add_idx;

