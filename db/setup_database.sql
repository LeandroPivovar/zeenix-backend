-- ===================================================================
-- SCRIPT COMPLETO DE SETUP DO BANCO DE DADOS ZENIX
-- Execute este arquivo para criar todo o banco de dados do zero
-- ===================================================================
-- Data: 2024
-- Descrição: Script unificado que cria todas as tabelas e popula dados iniciais
-- ===================================================================

-- ===================================================================
-- 1. CRIAR BANCO DE DADOS E TABELA DE USUÁRIOS
-- ===================================================================
CREATE DATABASE IF NOT EXISTS `zeenix` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `zeenix`;

-- Tabela de usuários (base)
CREATE TABLE IF NOT EXISTS `users` (
  `id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `derivLoginId` varchar(50) DEFAULT NULL,
  `derivCurrency` varchar(10) DEFAULT NULL,
  `derivBalance` decimal(36, 18) DEFAULT NULL,
  `derivRaw` json DEFAULT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `IDX_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 2. TABELAS DE PLANOS
-- ===================================================================
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

-- Adicionar colunas de plano na tabela users (ignora erro se já existir)
-- Nota: Se as colunas já existirem, você verá um erro que pode ser ignorado
SET @plan_id_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'plan_id'
);

SET @sql_add_plan_id := IF(
  @plan_id_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `plan_id` char(36) DEFAULT NULL AFTER `password`;',
  'SELECT 1;'
);
PREPARE stmt_add_plan_id FROM @sql_add_plan_id;
EXECUTE stmt_add_plan_id;
DEALLOCATE PREPARE stmt_add_plan_id;

SET @plan_activated_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'plan_activated_at'
);

SET @sql_add_plan_activated := IF(
  @plan_activated_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `plan_activated_at` datetime(6) DEFAULT NULL AFTER `plan_id`;',
  'SELECT 1;'
);
PREPARE stmt_add_plan_activated FROM @sql_add_plan_activated;
EXECUTE stmt_add_plan_activated;
DEALLOCATE PREPARE stmt_add_plan_activated;

-- Adicionar foreign key (ignora erro se já existir)
SET @fk_plan_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'FK_user_plan'
);

SET @sql_add_plan_index := IF(
  @fk_plan_exists = 0,
  'ALTER TABLE `users` ADD KEY `FK_user_plan` (`plan_id`);',
  'SELECT 1;'
);
PREPARE stmt_add_plan_index FROM @sql_add_plan_index;
EXECUTE stmt_add_plan_index;
DEALLOCATE PREPARE stmt_add_plan_index;

SET @fk_constraint_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND CONSTRAINT_NAME = 'FK_user_plan'
);

SET @sql_add_plan_fk := IF(
  @fk_constraint_exists = 0,
  'ALTER TABLE `users` ADD CONSTRAINT `FK_user_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE SET NULL;',
  'SELECT 1;'
);
PREPARE stmt_add_plan_fk FROM @sql_add_plan_fk;
EXECUTE stmt_add_plan_fk;
DEALLOCATE PREPARE stmt_add_plan_fk;

-- Inserir planos iniciais
INSERT IGNORE INTO `plans` (`id`, `name`, `slug`, `price`, `currency`, `billing_period`, `features`, `is_popular`, `is_recommended`, `is_active`, `display_order`) VALUES
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

-- ===================================================================
-- 3. TABELAS DE CONFIGURAÇÕES E SESSÕES
-- ===================================================================
-- Tabela de configurações do usuário
CREATE TABLE IF NOT EXISTS `user_settings` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `profile_picture_url` varchar(500) DEFAULT NULL,
  `language` varchar(10) DEFAULT 'pt-BR',
  `timezone` varchar(50) DEFAULT 'America/Sao_Paulo',
  `trade_currency` varchar(10) DEFAULT 'USD',
  `email_notifications` tinyint(1) DEFAULT 1,
  `two_factor_enabled` tinyint(1) DEFAULT 0,
  `two_factor_secret` varchar(255) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_settings` (`user_id`),
  KEY `FK_settings_user` (`user_id`),
  CONSTRAINT `FK_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Garantir coluna de moeda de operação (ignorar erro se já existir)
SET @trade_currency_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_settings'
    AND COLUMN_NAME = 'trade_currency'
);

SET @sql_add_trade_currency := IF(
  @trade_currency_exists = 0,
  'ALTER TABLE `user_settings` ADD COLUMN `trade_currency` varchar(10) DEFAULT ''USD'' AFTER `timezone`;',
  'SELECT 1;'
);
PREPARE stmt_add_trade_currency FROM @sql_add_trade_currency;
EXECUTE stmt_add_trade_currency;
DEALLOCATE PREPARE stmt_add_trade_currency;

-- Tabela de logs de atividade do usuário
CREATE TABLE IF NOT EXISTS `user_activity_logs` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `action` varchar(100) NOT NULL,
  `description` varchar(500) NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_logs_user` (`user_id`),
  KEY `idx_user_created` (`user_id`, `created_at`),
  CONSTRAINT `FK_logs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabela de sessões ativas do usuário
CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `token` varchar(500) NOT NULL,
  `device` varchar(255) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `last_activity` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_sessions_user` (`user_id`),
  KEY `idx_token` (`token`(255)),
  KEY `idx_user_last_activity` (`user_id`, `last_activity`),
  CONSTRAINT `FK_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- 4. TABELAS DE CURSOS E ACADEMIA
-- ===================================================================
-- Criar tabela de cursos
CREATE TABLE IF NOT EXISTS `courses` (
  `id` char(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text NOT NULL,
  `image_placeholder` varchar(100) DEFAULT NULL,
  `total_lessons` int NOT NULL DEFAULT 0,
  `total_duration` varchar(20) NOT NULL DEFAULT '0 min',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Criar tabela de módulos
CREATE TABLE IF NOT EXISTS `modules` (
  `id` char(36) NOT NULL,
  `course_id` char(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `order_index` int NOT NULL DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_modules_course` (`course_id`),
  CONSTRAINT `FK_modules_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Criar tabela de aulas
CREATE TABLE IF NOT EXISTS `lessons` (
  `id` char(36) NOT NULL,
  `course_id` char(36) NOT NULL,
  `module_id` char(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text NOT NULL,
  `duration` varchar(20) NOT NULL,
  `video_url` varchar(500) DEFAULT NULL,
  `order_index` int NOT NULL DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_lessons_course` (`course_id`),
  KEY `FK_lessons_module` (`module_id`),
  CONSTRAINT `FK_lessons_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_lessons_module` FOREIGN KEY (`module_id`) REFERENCES `modules` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Criar tabela de progresso do usuário nas aulas
CREATE TABLE IF NOT EXISTS `user_lesson_progress` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `lesson_id` char(36) NOT NULL,
  `completed` tinyint(1) DEFAULT 0,
  `completed_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_lesson` (`user_id`, `lesson_id`),
  KEY `FK_progress_user` (`user_id`),
  KEY `FK_progress_lesson` (`lesson_id`),
  CONSTRAINT `FK_progress_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_progress_lesson` FOREIGN KEY (`lesson_id`) REFERENCES `lessons` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inserir cursos iniciais
INSERT IGNORE INTO `courses` (`id`, `title`, `description`, `image_placeholder`, `total_lessons`, `total_duration`) VALUES
('c1', 'Fundamentos do Copy Trading', 'Aprenda os princípios do Copy Trading e configure sua conta.', 'Copy Trading', 12, '3h40min'),
('c2', 'IA Zenix e Automação de Operações', 'Automatize suas operações com nossa inteligência artificial.', 'IA Zenix', 10, '2h50min'),
('c3', 'Estratégias Avançadas de Mercado', 'Aprofunde sua análise técnica e fundamentalista.', 'Estrategias', 8, '2h15min'),
('c4', 'Psicologia do Trader', 'Desenvolva a mentalidade para operar com consistência.', 'Psicologia', 6, '1h30min');

-- Inserir módulos e aulas (exemplo do primeiro curso)
INSERT IGNORE INTO `modules` (`id`, `course_id`, `title`, `order_index`) VALUES
('m1-c1', 'c1', 'Introdução ao Copy Trading', 1),
('m2-c1', 'c1', 'Configuração e Primeiros Passos', 2),
('m3-c1', 'c1', 'Gerenciamento de Riscos', 3);

INSERT IGNORE INTO `lessons` (`id`, `course_id`, `module_id`, `title`, `description`, `duration`, `video_url`, `order_index`) VALUES
('l1-m1-c1', 'c1', 'm1-c1', 'O que é Copy Trading?', 'Entenda o conceito e como funciona o Copy Trading na prática.', '15min', 'https://example.com/video1', 1),
('l2-m1-c1', 'c1', 'm1-c1', 'Vantagens e Desvantagens', 'Conheça os prós e contras dessa estratégia de trading.', '12min', 'https://example.com/video2', 2),
('l3-m2-c1', 'c1', 'm2-c1', 'Como Escolher um Trader', 'Aprenda os critérios para selecionar os melhores traders para copiar.', '20min', 'https://example.com/video3', 3),
('l4-m2-c1', 'c1', 'm2-c1', 'Configurando sua Conta', 'Passo a passo para configurar sua conta na plataforma Zenix.', '18min', 'https://example.com/video4', 4);

-- ===================================================================
-- 5. TABELAS DE SUPORTE (FAQs E STATUS DO SISTEMA)
-- ===================================================================
-- Criar tabela de FAQs
CREATE TABLE IF NOT EXISTS `faqs` (
  `id` char(36) NOT NULL,
  `question` varchar(500) NOT NULL,
  `answer` text NOT NULL,
  `category` varchar(100) DEFAULT NULL,
  `order_index` int NOT NULL DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_category` (`category`),
  KEY `idx_order` (`order_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Criar tabela de System Status
CREATE TABLE IF NOT EXISTS `system_status` (
  `id` char(36) NOT NULL,
  `service_name` varchar(255) NOT NULL,
  `status` enum('operational', 'degraded', 'outage', 'maintenance') NOT NULL DEFAULT 'operational',
  `message` text DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_service_name` (`service_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inserir FAQs iniciais
INSERT IGNORE INTO `faqs` (`id`, `question`, `answer`, `category`, `order_index`) VALUES
('00000000-0000-0000-0000-000000000101', 'Como conecto minha conta da corretora?', 'Para conectar sua conta, vá para o Dashboard, clique em "Conectar Corretora" e insira suas credenciais da Deriv. O processo é seguro e leva menos de um minuto.', 'conexao', 1),
('00000000-0000-0000-0000-000000000102', 'Posso testar as IAs de investimento sem usar dinheiro real?', 'Sim, oferecemos uma conta demo onde você pode testar todas as funcionalidades das IAs de investimento sem usar dinheiro real. Acesse as configurações e selecione "Modo Demo".', 'ias', 2),
('00000000-0000-0000-0000-000000000103', 'O que é Copy Trading?', 'Copy Trading é uma funcionalidade que permite copiar automaticamente as operações de traders experientes. Você escolhe um trader e nossa plataforma replica suas operações em sua conta.', 'copy-trading', 3),
('00000000-0000-0000-0000-000000000104', 'Onde posso ver meu histórico de operações?', 'Você pode ver seu histórico completo de operações na seção "Relatórios" do Dashboard. Lá você encontrará todas as transações, resultados e estatísticas detalhadas.', 'operacoes', 4),
('00000000-0000-0000-0000-000000000105', 'Como funciona a IA Zenix?', 'A IA Zenix analisa o mercado em tempo real e executa operações automaticamente baseada em algoritmos avançados. Você pode configurar seus parâmetros de risco e a IA cuidará do resto.', 'ias', 5),
('00000000-0000-0000-0000-000000000106', 'Quais são os custos da plataforma?', 'A Zenix Black oferece planos flexíveis. Consulte a seção de Planos em Configurações para ver todas as opções disponíveis e seus respectivos custos.', 'planos', 6),
('00000000-0000-0000-0000-000000000107', 'Como retiro meus lucros?', 'Você pode retirar seus lucros diretamente através da sua conta Deriv conectada. As retiradas são processadas conforme as políticas da corretora.', 'retiradas', 7),
('00000000-0000-0000-0000-000000000108', 'A plataforma é segura?', 'Sim, utilizamos criptografia de ponta a ponta e não armazenamos senhas. Todas as conexões são feitas via API oficial da Deriv, garantindo máxima segurança.', 'seguranca', 8);

-- Inserir status inicial do sistema
INSERT IGNORE INTO `system_status` (`id`, `service_name`, `status`, `message`) VALUES
('00000000-0000-0000-0000-000000000201', 'Sistema Principal', 'operational', 'Todos os sistemas operacionais.'),
('00000000-0000-0000-0000-000000000202', 'API Deriv', 'operational', 'Conexão com Deriv estável.'),
('00000000-0000-0000-0000-000000000203', 'IA Zenix', 'operational', 'Serviços de IA funcionando normalmente.'),
('00000000-0000-0000-0000-000000000204', 'Copy Trading', 'operational', 'Serviço de Copy Trading ativo.');

-- ===================================================================
-- 6. TABELAS DE TRADES/OPERAÇÕES
-- ===================================================================
-- Tabela de trades (operações manuais e automáticas)
CREATE TABLE IF NOT EXISTS `trades` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `contract_type` varchar(50) NOT NULL,
  `time_type` varchar(20) NOT NULL,
  `duration` varchar(20) NOT NULL,
  `multiplier` decimal(10, 2) NOT NULL DEFAULT 1.00,
  `entry_value` decimal(10, 2) NOT NULL,
  `trade_type` enum('BUY', 'SELL') NOT NULL,
  `status` enum('pending', 'won', 'lost') NOT NULL DEFAULT 'pending',
  `profit` decimal(10, 2) DEFAULT NULL,
  `deriv_transaction_id` varchar(255) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_trades_user` (`user_id`),
  KEY `idx_user_created` (`user_id`, `created_at`),
  CONSTRAINT `FK_trades_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================================================================
-- SETUP COMPLETO!
-- ===================================================================
-- Todas as tabelas foram criadas e populadas com dados iniciais.
-- O banco de dados está pronto para uso.
-- ===================================================================

