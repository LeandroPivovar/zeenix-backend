-- Script para criar tabela de Planos e atualizar tabela de usuários

-- Tabela de planos de assinatura
CREATE TABLE IF NOT EXISTS `plans` (
  `id` char(36) NOT NULL,
  `name` varchar(100) NOT NULL,
  `slug` varchar(50) NOT NULL UNIQUE,
  `price` decimal(10, 2) NOT NULL DEFAULT 0.00,
  `currency` varchar(10) DEFAULT 'BRL',
  `billing_period` varchar(20) DEFAULT 'month',
  `features` json DEFAULT NULL,
  `is_popular` tinyint(1) DEFAULT 0,
  `is_recommended` tinyint(1) DEFAULT 0,
  `is_active` tinyint(1) DEFAULT 1,
  `display_order` int DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adicionar coluna de plano na tabela users
ALTER TABLE `users` 
ADD COLUMN `plan_id` char(36) DEFAULT NULL AFTER `password`,
ADD COLUMN `plan_activated_at` datetime(6) DEFAULT NULL AFTER `plan_id`,
ADD KEY `FK_user_plan` (`plan_id`),
ADD CONSTRAINT `FK_user_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE SET NULL;

-- Inserir planos iniciais
INSERT INTO `plans` (`id`, `name`, `slug`, `price`, `currency`, `billing_period`, `features`, `is_popular`, `is_recommended`, `is_active`, `display_order`) VALUES
('plan-starter', 'Plano Starter', 'starter', 0.00, 'BRL', 'month', 
JSON_OBJECT(
  'orion_ai', 'limitada',
  'signals_per_day', 10,
  'copy_trading', false,
  'academy', 'limitada',
  'support', 'email'
), 0, 0, 1, 1),

('plan-pro', 'Plano Pro', 'pro', 67.00, 'BRL', 'month',
JSON_OBJECT(
  'orion_ai', 'completa',
  'signals_per_day', 'ilimitado',
  'copy_trading', true,
  'academy', 'completa',
  'support', 'prioritario'
), 1, 0, 1, 2),

('plan-black', 'Zenix Black', 'black', 147.00, 'BRL', 'month',
JSON_OBJECT(
  'orion_ai', 'black_module',
  'signals_per_day', 'ilimitado',
  'copy_trading', 'premium',
  'academy', 'black_edition',
  'support', '1on1',
  'dashboards', true
), 0, 1, 1, 3);

