-- Migration: Migrar planos hard coded para a tabela plans
-- Este script migra os planos que estão hard coded no frontend para a tabela do banco

-- Verificar se a tabela plans existe, se não, criar
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

-- Inserir planos baseados nos dados hard coded do PlansView.vue
-- Usar INSERT IGNORE para não duplicar se já existirem

-- Plano Starter (Gratuito)
INSERT IGNORE INTO `plans` (`id`, `name`, `slug`, `price`, `currency`, `billing_period`, `features`, `is_popular`, `is_recommended`, `is_active`, `display_order`) 
VALUES (
  'plan-starter',
  'Starter',
  'starter',
  0.00,
  'BRL',
  'month',
  JSON_OBJECT(
    'orion_ai', 'limitada',
    'signals_per_day', 10,
    'copy_trading', false,
    'academy', 'limitada',
    'support', 'email',
    'benefits', JSON_ARRAY(
      'IA Orion limitada',
      '10 sinais/dia',
      'Suporte por e-mail',
      'Sem Copy Trading'
    )
  ),
  0,
  0,
  1,
  1
);

-- Plano Pro (Mais Popular)
INSERT IGNORE INTO `plans` (`id`, `name`, `slug`, `price`, `currency`, `billing_period`, `features`, `is_popular`, `is_recommended`, `is_active`, `display_order`) 
VALUES (
  'plan-pro',
  'Pro',
  'pro',
  67.00,
  'BRL',
  'month',
  JSON_OBJECT(
    'orion_ai', 'completa',
    'signals_per_day', 'ilimitado',
    'copy_trading', true,
    'academy', 'completa',
    'support', 'prioritario',
    'benefits', JSON_ARRAY(
      'IA Orion completa',
      'Copy Trading ilimitado',
      'Zenix Academy completa',
      'Suporte prioritário'
    )
  ),
  1,
  0,
  1,
  2
);

-- Plano Zenix Black (Recomendado)
INSERT IGNORE INTO `plans` (`id`, `name`, `slug`, `price`, `currency`, `billing_period`, `features`, `is_popular`, `is_recommended`, `is_active`, `display_order`) 
VALUES (
  'plan-black',
  'Zenix Black',
  'black',
  147.00,
  'BRL',
  'month',
  JSON_OBJECT(
    'orion_ai', 'black_module',
    'signals_per_day', 'ilimitado',
    'copy_trading', 'premium',
    'academy', 'black_edition',
    'support', '1on1',
    'dashboards', true,
    'benefits', JSON_ARRAY(
      'IA Orion Black Module',
      'Copy Trading ilimitado',
      'Zenix Academy completa',
      'Suporte prioritário'
    )
  ),
  0,
  1,
  1,
  3
);

-- Verificar se os planos foram inseridos
SELECT 
  id,
  name,
  slug,
  price,
  is_popular as 'Mais Vendido',
  is_recommended as 'Recomendado',
  is_active as 'Ativo',
  display_order as 'Ordem'
FROM `plans`
ORDER BY display_order;
















