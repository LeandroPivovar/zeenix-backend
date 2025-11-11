-- Script para renomear as colunas da tabela users de camelCase para snake_case
-- Execute este script para corrigir o problema de nomenclatura

USE `zeenix`;

-- Verificar se as colunas existem em camelCase antes de renomear
-- Se existirem, renomeá-las para snake_case

-- Renomear derivLoginId para deriv_login_id
ALTER TABLE `users` 
CHANGE COLUMN `derivLoginId` `deriv_login_id` varchar(50) DEFAULT NULL;

-- Renomear derivCurrency para deriv_currency
ALTER TABLE `users` 
CHANGE COLUMN `derivCurrency` `deriv_currency` varchar(10) DEFAULT NULL;

-- Renomear derivBalance para deriv_balance
ALTER TABLE `users` 
CHANGE COLUMN `derivBalance` `deriv_balance` decimal(36, 18) DEFAULT NULL;

-- Renomear derivRaw para deriv_raw
ALTER TABLE `users` 
CHANGE COLUMN `derivRaw` `deriv_raw` json DEFAULT NULL;

-- Renomear createdAt para created_at
ALTER TABLE `users` 
CHANGE COLUMN `createdAt` `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);

-- Renomear updatedAt para updated_at
ALTER TABLE `users` 
CHANGE COLUMN `updatedAt` `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6);

-- Verificar se as colunas foram renomeadas corretamente
SELECT COLUMN_NAME 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'zeenix' 
AND TABLE_NAME = 'users' 
AND (COLUMN_NAME LIKE 'deriv%' OR COLUMN_NAME LIKE '%_at');

SELECT 'Colunas renomeadas com sucesso para snake_case!' AS message;




