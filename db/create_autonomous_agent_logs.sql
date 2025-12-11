CREATE TABLE IF NOT EXISTS autonomous_agent_logs (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário (char(36) da tabela users)',
    timestamp DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    log_level VARCHAR(10) NOT NULL DEFAULT 'INFO' COMMENT 'INFO, WARN, ERROR, DEBUG',
    module VARCHAR(50) NOT NULL COMMENT 'CORE, API, ANALYZER, DECISION, TRADER, RISK, HUMANIZER',
    message TEXT NOT NULL,
    metadata JSON NULL COMMENT 'Dados adicionais em formato JSON',
    INDEX idx_autonomous_agent_logs_user_id (user_id),
    INDEX idx_autonomous_agent_logs_timestamp (timestamp),
    INDEX idx_autonomous_agent_logs_module (module),
    INDEX idx_autonomous_agent_logs_level (log_level),
    INDEX idx_autonomous_agent_logs_user_timestamp (user_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Logs detalhados do Agente Autônomo IA SENTINEL';

