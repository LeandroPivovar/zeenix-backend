-- Adiciona campos de role e status para gerenciamento de administradores
-- Execute este script no banco de dados
-- Este script é idempotente - pode ser executado múltiplas vezes sem erro

USE `zeenix`;

-- Verificar e adicionar coluna de role (função do usuário)
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'role'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `role` VARCHAR(50) DEFAULT ''user'' AFTER `password`',
    'SELECT "Coluna role já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna de status
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'is_active'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `is_active` BOOLEAN DEFAULT true AFTER `role`',
    'SELECT "Coluna is_active já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna de último login
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND COLUMN_NAME = 'last_login_at'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `users` ADD COLUMN `last_login_at` DATETIME NULL AFTER `is_active`',
    'SELECT "Coluna last_login_at já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e criar índice para busca por role
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND INDEX_NAME = 'idx_users_role'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX idx_users_role ON users(role)',
    'SELECT "Índice idx_users_role já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e criar índice para busca por status
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'users' 
    AND INDEX_NAME = 'idx_users_is_active'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX idx_users_is_active ON users(is_active)',
    'SELECT "Índice idx_users_is_active já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Atualizar usuários existentes (todos começam como 'user')
UPDATE users SET role = 'user' WHERE role IS NULL;
UPDATE users SET is_active = true WHERE is_active IS NULL;

SELECT 'Migração concluída. Verifique se todas as colunas (role, is_active, last_login_at) foram adicionadas corretamente.' AS message;

