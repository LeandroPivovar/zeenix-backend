-- Migration: Corrigir colunas nullable na tabela lessons
-- Data: 2025
-- Este script é idempotente - pode ser executado múltiplas vezes sem erro

USE `zeenix`;

-- Verificar e corrigir coluna description (deve permitir NULL)
SET @col_info = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'description'
    AND IS_NULLABLE = 'NO'
);

SET @sql = IF(@col_info > 0, 
    'ALTER TABLE `lessons` MODIFY COLUMN `description` TEXT NULL',
    'SELECT "Coluna description já permite NULL ou não existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e corrigir coluna module_id (deve permitir NULL conforme entidade)
-- Primeiro, verificar se a foreign key existe e precisa ser ajustada
SET @fk_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'module_id'
    AND CONSTRAINT_NAME = 'FK_lessons_module'
);

-- Se a FK existir, pode precisar ser recriada para permitir NULL
-- Mas primeiro vamos apenas alterar a coluna
SET @col_info = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'module_id'
    AND IS_NULLABLE = 'NO'
);

SET @sql = IF(@col_info > 0, 
    'ALTER TABLE `lessons` MODIFY COLUMN `module_id` CHAR(36) NULL',
    'SELECT "Coluna module_id já permite NULL ou não existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migração concluída. As colunas description e module_id agora permitem NULL.' AS message;

