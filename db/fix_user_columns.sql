-- Script para verificar e corrigir as colunas da tabela users
-- Execute este script se houver problemas com os nomes das colunas

USE `zeenix`;

-- Verificar se as colunas existem com os nomes corretos (camelCase)
-- Se não existirem, criar ou renomear

-- Verificar e adicionar coluna derivLoginId se não existir
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'derivLoginId'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `derivLoginId` varchar(50) DEFAULT NULL AFTER `password`',
    'SELECT "Coluna derivLoginId já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna derivCurrency se não existir
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'derivCurrency'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `derivCurrency` varchar(10) DEFAULT NULL AFTER `derivLoginId`',
    'SELECT "Coluna derivCurrency já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna derivBalance se não existir
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'derivBalance'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `derivBalance` decimal(36, 18) DEFAULT NULL AFTER `derivCurrency`',
    'SELECT "Coluna derivBalance já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna derivRaw se não existir
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'derivRaw'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `derivRaw` json DEFAULT NULL AFTER `derivBalance`',
    'SELECT "Coluna derivRaw já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Se as colunas existirem com nomes em snake_case, renomeá-las
-- (Descomente as linhas abaixo se necessário)

-- ALTER TABLE `users` CHANGE COLUMN `deriv_login_id` `derivLoginId` varchar(50) DEFAULT NULL;
-- ALTER TABLE `users` CHANGE COLUMN `deriv_currency` `derivCurrency` varchar(10) DEFAULT NULL;
-- ALTER TABLE `users` CHANGE COLUMN `deriv_balance` `derivBalance` decimal(36, 18) DEFAULT NULL;
-- ALTER TABLE `users` CHANGE COLUMN `deriv_raw` `derivRaw` json DEFAULT NULL;

SELECT 'Verificação concluída. Verifique se todas as colunas existem com os nomes corretos (camelCase).' AS message;




