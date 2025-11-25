-- ===================================================================
-- SCRIPT PARA CRIAR TABELA DE ITENS DE SUPORTE
-- ===================================================================
-- Descrição: Tabela para armazenar itens de suporte com título e conteúdo rico (HTML)
-- ===================================================================

USE `zeenix`;

-- Criar tabela de itens de suporte
CREATE TABLE IF NOT EXISTS `support_items` (
  `id` char(36) NOT NULL,
  `title` varchar(500) NOT NULL,
  `content` longtext NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_title` (`title`(255)),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

