-- Script para adicionar a coluna trade_currency à tabela user_settings
-- Execute este script se a migração não foi executada automaticamente
-- 
-- Uso:
--   mysql -u seu_usuario -p nome_do_banco < add_trade_currency_to_user_settings.sql
-- 
-- Ou execute diretamente no MySQL Workbench/phpMyAdmin

-- Verificar se a coluna já existe
SELECT COUNT(*) INTO @col_exists
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME = 'user_settings'
AND COLUMN_NAME = 'trade_currency';

-- Adicionar a coluna apenas se não existir
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE `user_settings` ADD COLUMN `trade_currency` varchar(10) DEFAULT ''USD'' AFTER `timezone`;',
    'SELECT ''Coluna trade_currency já existe na tabela user_settings'' AS message;'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Atualizar valores NULL para 'USD' (caso existam registros sem valor)
UPDATE `user_settings` 
SET `trade_currency` = 'USD' 
WHERE `trade_currency` IS NULL;

-- Verificar se a coluna foi adicionada corretamente
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    COLUMN_DEFAULT, 
    IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME = 'user_settings'
AND COLUMN_NAME = 'trade_currency';

