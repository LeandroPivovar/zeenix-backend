-- Script para adicionar campos de recuperação de senha na tabela users
-- Execute este script para habilitar o fluxo de recuperação de senha

USE `zeenix`;

-- Adicionar coluna reset_token (token único para reset de senha)
SET @reset_token_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'reset_token'
);

SET @sql_add_reset_token := IF(
  @reset_token_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `reset_token` VARCHAR(255) DEFAULT NULL AFTER `password`;',
  'SELECT 1;'
);
PREPARE stmt_add_reset_token FROM @sql_add_reset_token;
EXECUTE stmt_add_reset_token;
DEALLOCATE PREPARE stmt_add_reset_token;

-- Adicionar coluna reset_token_expiry (data de expiração do token)
SET @reset_token_expiry_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'reset_token_expiry'
);

SET @sql_add_reset_token_expiry := IF(
  @reset_token_expiry_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `reset_token_expiry` DATETIME DEFAULT NULL AFTER `reset_token`;',
  'SELECT 1;'
);
PREPARE stmt_add_reset_token_expiry FROM @sql_add_reset_token_expiry;
EXECUTE stmt_add_reset_token_expiry;
DEALLOCATE PREPARE stmt_add_reset_token_expiry;

-- Adicionar índice para busca rápida por reset_token
SET @reset_token_index_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_reset_token'
);

SET @sql_add_reset_token_index := IF(
  @reset_token_index_exists = 0,
  'ALTER TABLE `users` ADD INDEX `idx_reset_token` (`reset_token`);',
  'SELECT 1;'
);
PREPARE stmt_add_reset_token_index FROM @sql_add_reset_token_index;
EXECUTE stmt_add_reset_token_index;
DEALLOCATE PREPARE stmt_add_reset_token_index;

SELECT 'Campos de recuperação de senha adicionados com sucesso!' AS message;

