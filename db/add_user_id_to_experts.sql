-- Script para adicionar coluna user_id à tabela experts
-- Esta coluna relaciona experts com users para permitir copy trading

USE `zeenix`;

-- Verificar se a coluna user_id já existe
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'user_id'
);

-- Se a coluna não existir, adicionar
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `user_id` CHAR(36) NULL COMMENT \'ID do usuário relacionado (FK para users.id)\' AFTER `trader_type`, ADD INDEX `idx_user_id` (`user_id`), ADD CONSTRAINT `FK_experts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL',
    'SELECT "Coluna user_id já existe" AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migração concluída. A coluna user_id foi adicionada à tabela experts.' AS message;







