-- Tabela de configuração de IA por usuário
-- Armazena se a IA está ativa e suas configurações

CREATE TABLE IF NOT EXISTS ai_user_config (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    stake_amount DECIMAL(10, 2) NOT NULL DEFAULT 10.00,
    deriv_token TEXT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    
    -- Controle de execução
    last_trade_at TIMESTAMP NULL,
    next_trade_at TIMESTAMP NULL,
    
    -- Estatísticas
    total_trades INT UNSIGNED DEFAULT 0,
    total_wins INT UNSIGNED DEFAULT 0,
    total_losses INT UNSIGNED DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Índices
    UNIQUE KEY idx_user_id (user_id),
    INDEX idx_is_active (is_active),
    INDEX idx_next_trade_at (next_trade_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Configuração de IA de trading por usuário - permite execução em background';









