-- Script para migrar a coluna user_id de INT para VARCHAR(36)
-- Execute este script se a tabela ai_user_config já existir com user_id INT

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

