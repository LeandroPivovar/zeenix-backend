-- ===================================================================
-- SCRIPT DE MIGRAÇÃO: Atualizar tabela support_items
-- ===================================================================
-- Descrição: Migra a tabela support_items de content (HTML) para subtitle e image_path
-- Execute este script apenas se a tabela já existir com a estrutura antiga
-- ===================================================================

USE `zeenix`;

-- Verificar e adicionar coluna subtitle se não existir
SET @subtitle_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'support_items'
    AND COLUMN_NAME = 'subtitle'
);

SET @sql_add_subtitle := IF(
  @subtitle_exists = 0,
  'ALTER TABLE `support_items` ADD COLUMN `subtitle` longtext DEFAULT NULL AFTER `title`;',
  'SELECT 1;'
);
PREPARE stmt_add_subtitle FROM @sql_add_subtitle;
EXECUTE stmt_add_subtitle;
DEALLOCATE PREPARE stmt_add_subtitle;

-- Verificar e adicionar coluna image_path se não existir
SET @image_path_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'support_items'
    AND COLUMN_NAME = 'image_path'
);

SET @sql_add_image_path := IF(
  @image_path_exists = 0,
  'ALTER TABLE `support_items` ADD COLUMN `image_path` varchar(500) DEFAULT NULL AFTER `subtitle`;',
  'SELECT 1;'
);
PREPARE stmt_add_image_path FROM @sql_add_image_path;
EXECUTE stmt_add_image_path;
DEALLOCATE PREPARE stmt_add_image_path;

-- Verificar e remover coluna content se existir
SET @content_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'support_items'
    AND COLUMN_NAME = 'content'
);

SET @sql_drop_content := IF(
  @content_exists > 0,
  'ALTER TABLE `support_items` DROP COLUMN `content`;',
  'SELECT 1;'
);
PREPARE stmt_drop_content FROM @sql_drop_content;
EXECUTE stmt_drop_content;
DEALLOCATE PREPARE stmt_drop_content;

