-- ============================================
-- TABELA DE LOGS DA IA - ZENIX v2.0
-- ============================================
-- Armazena logs detalhados de cada operação da IA para exibição em tempo real

CREATE TABLE IF NOT EXISTS `ai_logs` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id` CHAR(36) NOT NULL,
  `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `type` ENUM('info', 'tick', 'analise', 'sinal', 'operacao', 'resultado', 'alerta', 'erro') NOT NULL,
  `icon` VARCHAR(10) NOT NULL,
  `message` TEXT NOT NULL,
  `details` JSON DEFAULT NULL,
  `session_id` CHAR(36) DEFAULT NULL COMMENT 'ID da sessão para agrupar logs',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX `idx_user_timestamp` (`user_id`, `timestamp` DESC),
  INDEX `idx_session` (`session_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adicionar índice para busca rápida dos últimos logs
ALTER TABLE `ai_logs` ADD INDEX `idx_user_created` (`user_id`, `created_at` DESC);

-- NOTA: Trigger removido para evitar erro "Can't update table in trigger"
-- Limpeza de logs antigos será feita por método separado (clearOldLogs)

