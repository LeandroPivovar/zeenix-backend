-- Migration: Adicionar campos para gestão completa da Academy
-- Data: 2024

-- ============================================
-- 1. ADICIONAR CAMPOS NA TABELA COURSES
-- ============================================

-- Campos de SEO e Compartilhamento
-- Nota: MySQL não suporta IF NOT EXISTS em ADD COLUMN, então execute manualmente se as colunas já existirem
ALTER TABLE `courses` 
ADD COLUMN `slug` VARCHAR(255) NULL UNIQUE AFTER `description`,
ADD COLUMN `seo_title` VARCHAR(255) NULL AFTER `slug`,
ADD COLUMN `seo_description` TEXT NULL AFTER `seo_title`,
ADD COLUMN `keywords` JSON NULL AFTER `seo_description`,
ADD COLUMN `social_image` LONGTEXT NULL AFTER `keywords`;

-- Campos de Acesso e Preço
ALTER TABLE `courses`
ADD COLUMN `access` ENUM('1', '2', '3') DEFAULT '1' COMMENT '1=Pago, 2=Gratuito, 3=Convidado' AFTER `social_image`,
ADD COLUMN `price` DECIMAL(10, 2) DEFAULT 0.00 AFTER `access`,
ADD COLUMN `currency` VARCHAR(10) DEFAULT 'R$' AFTER `price`,
ADD COLUMN `subscription` ENUM('1', '2') DEFAULT '1' COMMENT '1=Nenhum, 2=Premium' AFTER `currency`,
ADD COLUMN `discount` VARCHAR(50) NULL AFTER `subscription`;

-- Campos de Publicação e Visibilidade
ALTER TABLE `courses`
ADD COLUMN `status` ENUM('draft', 'published', 'archived') DEFAULT 'draft' AFTER `discount`,
ADD COLUMN `available_from` DATETIME NULL AFTER `status`,
ADD COLUMN `available_until` DATETIME NULL AFTER `available_from`,
ADD COLUMN `visibility` ENUM('public', 'private', 'restricted') DEFAULT 'public' AFTER `available_until`;

-- Adicionar cover_image
ALTER TABLE `courses`
ADD COLUMN `cover_image` LONGTEXT NULL AFTER `visibility`;

-- Se image_placeholder existir e cover_image não, copiar dados
UPDATE `courses` SET `cover_image` = `image_placeholder` WHERE `cover_image` IS NULL AND `image_placeholder` IS NOT NULL;

-- ============================================
-- 2. ADICIONAR CAMPOS NA TABELA MODULES
-- ============================================

ALTER TABLE `modules`
ADD COLUMN `short_description` TEXT NULL AFTER `title`,
ADD COLUMN `status` ENUM('draft', 'published', 'archived') DEFAULT 'published' AFTER `short_description`;

-- ============================================
-- 3. ADICIONAR CAMPOS NA TABELA LESSONS
-- ============================================

ALTER TABLE `lessons`
ADD COLUMN `content_type` ENUM('Video', 'Text', 'PDF', 'Link') DEFAULT 'Video' AFTER `description`,
ADD COLUMN `content_link` VARCHAR(500) NULL AFTER `content_type`,
ADD COLUMN `release_type` ENUM('Imediata', 'Agendada') DEFAULT 'Imediata' AFTER `content_link`,
ADD COLUMN `release_date` DATETIME NULL AFTER `release_type`,
ADD COLUMN `is_active` TINYINT(1) DEFAULT 1 AFTER `release_date`;

-- Renomear video_url para content_link se necessário (ou manter ambos)
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

-- Índices (execute apenas se não existirem)
-- CREATE INDEX `idx_courses_slug` ON `courses` (`slug`);
-- CREATE INDEX `idx_courses_status` ON `courses` (`status`);
-- CREATE INDEX `idx_courses_visibility` ON `courses` (`visibility`);
-- CREATE INDEX `idx_lessons_is_active` ON `lessons` (`is_active`);
-- CREATE INDEX `idx_modules_status` ON `modules` (`status`);

