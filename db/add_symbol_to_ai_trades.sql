-- Adicionar campo symbol na tabela ai_trades
-- Este script verifica se a coluna existe antes de adicionar
-- Compatível com MySQL 5.7+ e MariaDB

-- Verificar se a coluna já existe
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ai_trades'
    AND COLUMN_NAME = 'symbol'
);

-- Adicionar coluna apenas se não existir
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE ai_trades ADD COLUMN symbol VARCHAR(50) NOT NULL DEFAULT ''R_10'' COMMENT ''Símbolo do mercado operado (ex: R_10, R_50)'' AFTER user_id;',
  'SELECT ''Coluna symbol já existe na tabela ai_trades'' AS message;'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Atualizar registros existentes com o valor padrão (caso a coluna já existisse sem valor)
UPDATE ai_trades SET symbol = 'R_10' WHERE symbol IS NULL OR symbol = '';
