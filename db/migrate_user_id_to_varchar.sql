-- Script para migrar a coluna user_id de INT para VARCHAR(36)
-- Execute este script se as tabelas já existirem com user_id INT

-- ========================================
-- TABELA: ai_user_config
-- ========================================

-- 1. Verificar se a tabela existe
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    CHARACTER_MAXIMUM_LENGTH 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'ai_user_config' 
  AND COLUMN_NAME = 'user_id';

-- 2. Se user_id for INT, execute o ALTER TABLE abaixo:
-- ATENÇÃO: Este comando irá LIMPAR todos os dados da tabela se houver incompatibilidade de tipos!
-- Faça backup antes de executar!

-- 2.1 Deletar índice UNIQUE antes de alterar
ALTER TABLE ai_user_config DROP INDEX idx_user_id;

-- 2.2 Alterar tipo da coluna
ALTER TABLE ai_user_config 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- 2.3 Recriar índice UNIQUE
ALTER TABLE ai_user_config ADD UNIQUE KEY idx_user_id (user_id);

-- 3. Verificar se a alteração foi bem-sucedida
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    CHARACTER_MAXIMUM_LENGTH 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'ai_user_config' 
  AND COLUMN_NAME = 'user_id';

-- ========================================
-- TABELA: ai_trades
-- ========================================

-- 4. Verificar se a tabela ai_trades existe e tem user_id como INT
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    CHARACTER_MAXIMUM_LENGTH 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'ai_trades' 
  AND COLUMN_NAME = 'user_id';

-- 5. Se user_id for INT, execute o ALTER TABLE abaixo:
-- ATENÇÃO: Faça backup antes de executar!

ALTER TABLE ai_trades 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- 6. Verificar se a alteração foi bem-sucedida
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    CHARACTER_MAXIMUM_LENGTH 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'ai_trades' 
  AND COLUMN_NAME = 'user_id';

-- ========================================
-- OU USE O ENDPOINT DA API (RECOMENDADO)
-- ========================================
-- POST https://iazenix.com/api/ai/init-tables
-- Este endpoint fará todas as migrações automaticamente!

