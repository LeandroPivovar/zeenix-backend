-- Script completo e idempotente para criar a tabela experts com todos os campos
-- Data: 2025
-- Este script é idempotente - pode ser executado múltiplas vezes sem erro

USE `zeenix`;

-- Verificar se a tabela experts existe
SET @table_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.TABLES 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts'
);

-- Se a tabela não existir, criar usando DELIMITER para escapar as aspas
DELIMITER $$

DROP PROCEDURE IF EXISTS CreateExpertsTableIfNotExists$$

CREATE PROCEDURE CreateExpertsTableIfNotExists()
BEGIN
    DECLARE table_count INT DEFAULT 0;
    
    SELECT COUNT(*) INTO table_count
    FROM INFORMATION_SCHEMA.TABLES 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts';
    
    IF table_count = 0 THEN
        CREATE TABLE `experts` (
            `id` CHAR(36) PRIMARY KEY,
            `name` VARCHAR(255) NOT NULL,
            `email` VARCHAR(255) UNIQUE NOT NULL,
            `specialty` VARCHAR(100) NOT NULL COMMENT 'Especialidade: Forex, Crypto, Stocks, etc',
            `bio` TEXT NULL COMMENT 'Biografia/Descrição do expert',
            `avatar_url` VARCHAR(500) NULL COMMENT 'URL da foto do expert',
            `experience_years` INT DEFAULT 0 COMMENT 'Anos de experiência',
            `rating` DECIMAL(3,2) DEFAULT 0.00 COMMENT 'Avaliação média (0-5)',
            `total_reviews` INT DEFAULT 0 COMMENT 'Total de avaliações recebidas',
            `total_followers` INT DEFAULT 0 COMMENT 'Total de seguidores',
            `total_signals` INT DEFAULT 0 COMMENT 'Total de sinais enviados',
            `win_rate` DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Taxa de acerto (%)',
            `is_verified` BOOLEAN DEFAULT false COMMENT 'Expert verificado pela plataforma',
            `is_active` BOOLEAN DEFAULT true COMMENT 'Expert ativo no sistema',
            `social_links` JSON NULL COMMENT 'Links de redes sociais',
            `login_original` VARCHAR(50) NULL COMMENT 'LoginID Original (conta de teste da Deriv)',
            `login_alvo` VARCHAR(50) NULL COMMENT 'LoginID Alvo (conta real conectada à Deriv)',
            `saldo_alvo` DECIMAL(15,2) DEFAULT 0.00 COMMENT 'Saldo Alvo em USD',
            `connection_status` VARCHAR(50) DEFAULT 'Desconectado' COMMENT 'Status da conexão: Ativo, Sincronizando, Desconectado',
            `trader_type` VARCHAR(50) NULL COMMENT 'Tipo de trader',
            `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            INDEX `idx_specialty` (`specialty`),
            INDEX `idx_is_verified` (`is_verified`),
            INDEX `idx_is_active` (`is_active`),
            INDEX `idx_rating` (`rating`),
            INDEX `idx_created_at` (`created_at`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;
END$$

DELIMITER ;

CALL CreateExpertsTableIfNotExists();

DROP PROCEDURE IF EXISTS CreateExpertsTableIfNotExists;

-- Verificar e adicionar campos que podem não existir se a tabela foi criada antes

-- login_original
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'login_original'
);
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `login_original` VARCHAR(50) NULL COMMENT \'LoginID Original (conta de teste da Deriv)\' AFTER `social_links`',
    'SELECT "Coluna login_original já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- login_alvo
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'login_alvo'
);
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `login_alvo` VARCHAR(50) NULL COMMENT \'LoginID Alvo (conta real conectada à Deriv)\' AFTER `login_original`',
    'SELECT "Coluna login_alvo já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- saldo_alvo
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'saldo_alvo'
);
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `saldo_alvo` DECIMAL(15,2) DEFAULT 0.00 COMMENT \'Saldo Alvo em USD\' AFTER `login_alvo`',
    'SELECT "Coluna saldo_alvo já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- connection_status
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'connection_status'
);
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `connection_status` VARCHAR(50) DEFAULT \'Desconectado\' COMMENT \'Status da conexão: Ativo, Sincronizando, Desconectado\' AFTER `saldo_alvo`',
    'SELECT "Coluna connection_status já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- trader_type
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'trader_type'
);
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `trader_type` VARCHAR(50) NULL COMMENT \'Tipo de trader\' AFTER `connection_status`',
    'SELECT "Coluna trader_type já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- user_id (relaciona expert com usuário)
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'experts' 
    AND COLUMN_NAME = 'user_id'
);
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `experts` ADD COLUMN `user_id` CHAR(36) NULL COMMENT \'ID do usuário relacionado (FK para users.id)\' AFTER `trader_type`, ADD INDEX `idx_user_id` (`user_id`), ADD CONSTRAINT `FK_experts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL',
    'SELECT "Coluna user_id já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migração concluída. A tabela experts foi criada/atualizada com sucesso.' AS message;

