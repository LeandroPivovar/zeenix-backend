-- ===================================================================
-- ADICIONAR CAMPO PHONE NA TABELA USERS
-- ===================================================================
-- Descrição: Adiciona coluna phone para armazenar número de telefone do usuário
-- Data: 2024
-- ===================================================================

USE `zeenix`;

-- Verificar se a coluna já existe antes de adicionar
SET @phone_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'phone'
);

-- Adicionar coluna phone se não existir
SET @sql_add_phone := IF(
  @phone_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `phone` varchar(20) DEFAULT NULL AFTER `email`, ADD UNIQUE KEY `IDX_users_phone` (`phone`);',
  'SELECT "Coluna phone já existe na tabela users" AS message;'
);

PREPARE stmt_add_phone FROM @sql_add_phone;
EXECUTE stmt_add_phone;
DEALLOCATE PREPARE stmt_add_phone;

-- Verificar se foi adicionada com sucesso
SELECT 
  CASE 
    WHEN @phone_exists = 0 THEN 'Coluna phone adicionada com sucesso!'
    ELSE 'Coluna phone já existe na tabela users'
  END AS result;





