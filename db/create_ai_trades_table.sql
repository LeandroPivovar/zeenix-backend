-- Tabela para armazenar operações da IA (MySQL)
CREATE TABLE IF NOT EXISTS ai_trades (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    
    -- Dados da análise
    analysis_data JSON NOT NULL COMMENT 'Últimos 20 preços enviados ao Gemini',
    gemini_signal VARCHAR(10) NOT NULL COMMENT 'CALL ou PUT',
    gemini_duration INT NOT NULL COMMENT 'Duração em segundos',
    gemini_reasoning TEXT COMMENT 'Explicação do Gemini',
    
    -- Dados da operação
    entry_price DECIMAL(10, 4) NOT NULL,
    stake_amount DECIMAL(10, 2) NOT NULL,
    contract_type VARCHAR(20) NOT NULL,
    contract_id VARCHAR(100),
    
    -- Status e resultados
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING, ACTIVE, WON, LOST, ERROR',
    exit_price DECIMAL(10, 4),
    profit_loss DECIMAL(10, 2),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    closed_at TIMESTAMP NULL,
    
    -- Metadados
    error_message TEXT,
    
    INDEX idx_ai_trades_user_id (user_id),
    INDEX idx_ai_trades_status (status),
    INDEX idx_ai_trades_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Armazena operações realizadas pela IA de trading';

-- Para adicionar a foreign key depois (se necessário), primeiro verifique o tipo da coluna users.id:
-- SHOW COLUMNS FROM users WHERE Field = 'id';
-- Se for BIGINT UNSIGNED, execute:
-- ALTER TABLE ai_trades MODIFY user_id BIGINT UNSIGNED NOT NULL;
-- ALTER TABLE ai_trades ADD CONSTRAINT fk_ai_trades_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
