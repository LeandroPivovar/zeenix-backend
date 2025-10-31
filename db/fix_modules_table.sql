-- Script para verificar e corrigir a tabela modules
-- Execute este script para garantir que a tabela modules tenha a estrutura correta

-- Primeiro, vamos verificar a estrutura atual da tabela
SHOW CREATE TABLE `modules`;

-- Se a tabela não tiver a estrutura correta, execute o comando abaixo para recriá-la:
-- ATENÇÃO: Isso vai deletar todos os dados da tabela modules e suas dependências

DROP TABLE IF EXISTS `user_lesson_progress`;
DROP TABLE IF EXISTS `lessons`;
DROP TABLE IF EXISTS `modules`;

-- Recriar tabela de módulos com a estrutura correta
CREATE TABLE `modules` (
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

-- Recriar tabela de aulas
CREATE TABLE `lessons` (
  `id` char(36) NOT NULL,
  `course_id` char(36) NOT NULL,
  `module_id` char(36) DEFAULT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `duration` varchar(20) NOT NULL,
  `video_url` varchar(500) DEFAULT NULL,
  `order_index` int NOT NULL DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `FK_lessons_course` (`course_id`),
  KEY `FK_lessons_module` (`module_id`),
  CONSTRAINT `FK_lessons_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_lessons_module` FOREIGN KEY (`module_id`) REFERENCES `modules` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recriar tabela de progresso do usuário
CREATE TABLE `user_lesson_progress` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `lesson_id` char(36) NOT NULL,
  `completed` tinyint(1) NOT NULL DEFAULT 0,
  `completed_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UK_user_lesson` (`user_id`, `lesson_id`),
  KEY `FK_progress_user` (`user_id`),
  KEY `FK_progress_lesson` (`lesson_id`),
  CONSTRAINT `FK_progress_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_progress_lesson` FOREIGN KEY (`lesson_id`) REFERENCES `lessons` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reinserir módulos
INSERT INTO `modules` (`id`, `course_id`, `title`, `order_index`) VALUES
('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Introdução', 1),
('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'Primeiros Passos', 2),
('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'Estratégias Avançadas', 3),
('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000002', 'Introdução à IA Zenix', 1),
('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000002', 'Configuração e Ativação', 2);

-- Reinserir aulas
INSERT INTO `lessons` (`id`, `course_id`, `module_id`, `title`, `description`, `duration`, `order_index`) VALUES
('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'Boas-vindas ao Zenix', 'Introdução ao Zenix Black e sua plataforma.', '4:35', 1),
('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'O que é Copy Trading', 'O que é Copy Trading e como funciona na prática', '8:20', 2),
('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'Criando sua conta Deriv', 'Passo a passo para criar e configurar sua conta na Deriv.', '7:40', 3),
('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000012', 'Configurando sua primeira operação', 'Como configurar e executar sua primeira operação de Copy Trading.', '10:15', 1),
('00000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000013', 'Análise de traders', 'Como identificar e escolher os melhores traders para copiar.', '12:00', 1),
('00000000-0000-0000-0000-000000000026', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000014', 'Entendendo a IA Zenix', 'Conceitos básicos sobre inteligência artificial no trading.', '15:00', 1),
('00000000-0000-0000-0000-000000000027', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000014', 'Benefícios da Automação', 'Por que automatizar suas operações.', '10:30', 2),
('00000000-0000-0000-0000-000000000028', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000015', 'Ativando sua IA', 'Como ativar e configurar sua IA Zenix.', '12:20', 1);

