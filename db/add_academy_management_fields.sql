-- Migration: Adicionar campos para gestão completa da Academy
-- Data: 2024
-- Este script é idempotente - pode ser executado múltiplas vezes sem erro

USE `zeenix`;

-- ============================================
-- 1. ADICIONAR CAMPOS NA TABELA COURSES
-- ============================================

-- Campos de SEO e Compartilhamento
-- Verificar e adicionar coluna slug
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'slug'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `slug` VARCHAR(255) NULL UNIQUE AFTER `description`',
    'SELECT "Coluna slug já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna seo_title
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'seo_title'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `seo_title` VARCHAR(255) NULL AFTER `slug`',
    'SELECT "Coluna seo_title já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna seo_description
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'seo_description'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `seo_description` TEXT NULL AFTER `seo_title`',
    'SELECT "Coluna seo_description já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna keywords
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'keywords'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `keywords` JSON NULL AFTER `seo_description`',
    'SELECT "Coluna keywords já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna social_image
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'social_image'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `social_image` LONGTEXT NULL AFTER `keywords`',
    'SELECT "Coluna social_image já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Campos de Acesso e Preço
-- Verificar e adicionar coluna access
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'access'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `access` ENUM(''1'', ''2'', ''3'') DEFAULT ''1'' COMMENT ''1=Pago, 2=Gratuito, 3=Convidado'' AFTER `social_image`',
    'SELECT "Coluna access já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna price
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'price'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `price` DECIMAL(10, 2) DEFAULT 0.00 AFTER `access`',
    'SELECT "Coluna price já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna currency
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'currency'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `currency` VARCHAR(10) DEFAULT ''R$'' AFTER `price`',
    'SELECT "Coluna currency já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna subscription
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'subscription'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `subscription` ENUM(''1'', ''2'') DEFAULT ''1'' COMMENT ''1=Nenhum, 2=Premium'' AFTER `currency`',
    'SELECT "Coluna subscription já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna discount
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'discount'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `discount` VARCHAR(50) NULL AFTER `subscription`',
    'SELECT "Coluna discount já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Campos de Publicação e Visibilidade
-- Verificar e adicionar coluna status
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'status'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `status` ENUM(''draft'', ''published'', ''archived'') DEFAULT ''draft'' AFTER `discount`',
    'SELECT "Coluna status já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna available_from
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'available_from'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `available_from` DATETIME NULL AFTER `status`',
    'SELECT "Coluna available_from já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna available_until
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'available_until'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `available_until` DATETIME NULL AFTER `available_from`',
    'SELECT "Coluna available_until já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna visibility
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'visibility'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `visibility` ENUM(''public'', ''private'', ''restricted'') DEFAULT ''public'' AFTER `available_until`',
    'SELECT "Coluna visibility já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna cover_image
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND COLUMN_NAME = 'cover_image'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `courses` ADD COLUMN `cover_image` LONGTEXT NULL AFTER `visibility`',
    'SELECT "Coluna cover_image já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Se image_placeholder existir e cover_image não, copiar dados
UPDATE `courses` SET `cover_image` = `image_placeholder` WHERE `cover_image` IS NULL AND `image_placeholder` IS NOT NULL;

-- ============================================
-- 2. ADICIONAR CAMPOS NA TABELA MODULES
-- ============================================

-- Verificar e adicionar coluna short_description
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'modules' 
    AND COLUMN_NAME = 'short_description'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `modules` ADD COLUMN `short_description` TEXT NULL AFTER `title`',
    'SELECT "Coluna short_description já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna status
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'modules' 
    AND COLUMN_NAME = 'status'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `modules` ADD COLUMN `status` ENUM(''draft'', ''published'', ''archived'') DEFAULT ''published'' AFTER `short_description`',
    'SELECT "Coluna status já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- 3. ADICIONAR CAMPOS NA TABELA LESSONS
-- ============================================

-- Verificar e adicionar coluna content_type
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'content_type'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `lessons` ADD COLUMN `content_type` ENUM(''Video'', ''Text'', ''PDF'', ''Link'') DEFAULT ''Video'' AFTER `description`',
    'SELECT "Coluna content_type já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna content_link
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'content_link'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `lessons` ADD COLUMN `content_link` VARCHAR(500) NULL AFTER `content_type`',
    'SELECT "Coluna content_link já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna release_type
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'release_type'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `lessons` ADD COLUMN `release_type` ENUM(''Imediata'', ''Agendada'') DEFAULT ''Imediata'' AFTER `content_link`',
    'SELECT "Coluna release_type já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna release_date
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'release_date'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `lessons` ADD COLUMN `release_date` DATETIME NULL AFTER `release_type`',
    'SELECT "Coluna release_date já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e adicionar coluna is_active
SET @col_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND COLUMN_NAME = 'is_active'
);

SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE `lessons` ADD COLUMN `is_active` TINYINT(1) DEFAULT 1 AFTER `release_date`',
    'SELECT "Coluna is_active já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Se content_link estiver vazio e video_url não, copiar
UPDATE `lessons` SET `content_link` = `video_url` WHERE (`content_link` IS NULL OR `content_link` = '') AND `video_url` IS NOT NULL;

-- ============================================
-- 4. CRIAR TABELA DE MATERIAIS
-- ============================================

CREATE TABLE IF NOT EXISTS `materials` (
  `id` CHAR(36) NOT NULL,
  `lesson_id` CHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `type` ENUM('PDF', 'DOC', 'XLS', 'PPT', 'LINK', 'OTHER') NOT NULL DEFAULT 'PDF',
  `link` VARCHAR(500) NOT NULL,
  `file_path` VARCHAR(500) NULL COMMENT 'Caminho do arquivo se for upload',
  `order_index` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_materials_lesson` (`lesson_id`),
  KEY `idx_order` (`order_index`),
  CONSTRAINT `FK_materials_lesson` FOREIGN KEY (`lesson_id`) REFERENCES `lessons` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. ÍNDICES PARA PERFORMANCE
-- ============================================

-- Verificar e criar índice idx_courses_slug
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND INDEX_NAME = 'idx_courses_slug'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX `idx_courses_slug` ON `courses` (`slug`)',
    'SELECT "Índice idx_courses_slug já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e criar índice idx_courses_status
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND INDEX_NAME = 'idx_courses_status'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX `idx_courses_status` ON `courses` (`status`)',
    'SELECT "Índice idx_courses_status já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e criar índice idx_courses_visibility
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'courses' 
    AND INDEX_NAME = 'idx_courses_visibility'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX `idx_courses_visibility` ON `courses` (`visibility`)',
    'SELECT "Índice idx_courses_visibility já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e criar índice idx_lessons_is_active
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'lessons' 
    AND INDEX_NAME = 'idx_lessons_is_active'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX `idx_lessons_is_active` ON `lessons` (`is_active`)',
    'SELECT "Índice idx_lessons_is_active já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar e criar índice idx_modules_status
SET @idx_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'modules' 
    AND INDEX_NAME = 'idx_modules_status'
);

SET @sql = IF(@idx_exists = 0, 
    'CREATE INDEX `idx_modules_status` ON `modules` (`status`)',
    'SELECT "Índice idx_modules_status já existe" AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migração concluída. Verifique se todas as colunas foram adicionadas corretamente.' AS message;

