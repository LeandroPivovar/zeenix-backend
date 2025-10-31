-- Script para criar tabelas de Configurações e Logs de Atividade

-- Tabela de configurações do usuário
CREATE TABLE IF NOT EXISTS `user_settings` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `profile_picture_url` varchar(500) DEFAULT NULL,
  `language` varchar(10) DEFAULT 'pt-BR',
  `timezone` varchar(50) DEFAULT 'America/Sao_Paulo',
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

