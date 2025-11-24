-- Tabela de configuração de Copy Trading por usuário
-- Armazena se o copy está ativo e suas configurações

CREATE TABLE IF NOT EXISTS copy_trading_config (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    trader_id VARCHAR(100) NOT NULL COMMENT 'ID do trader selecionado',
    trader_name VARCHAR(255) NOT NULL COMMENT 'Nome do trader',
    
    -- Status da sessão
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    session_status VARCHAR(50) DEFAULT NULL COMMENT 'active, paused, stopped_profit, stopped_loss, deactivated',
    
    -- Tipo de alocação
    allocation_type ENUM('proportion', 'fixed') NOT NULL DEFAULT 'proportion',
    
    -- Valor/Proporção
    allocation_value DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT 'Valor fixo em USD ou percentual',
    allocation_percentage DECIMAL(5, 2) DEFAULT NULL COMMENT 'Percentual do saldo (se allocation_type = proportion)',
    
    -- Configurações
    leverage VARCHAR(10) NOT NULL DEFAULT '1:1',
    stop_loss DECIMAL(10, 2) NOT NULL DEFAULT 250.00,
    take_profit DECIMAL(10, 2) NOT NULL DEFAULT 500.00,
    blind_stop_loss BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Token Deriv
    deriv_token TEXT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    
    -- Estatísticas da sessão
    session_balance DECIMAL(10, 2) DEFAULT 0.00 COMMENT 'Saldo atual da sessão',
    total_operations INT UNSIGNED DEFAULT 0,
    total_wins INT UNSIGNED DEFAULT 0,
    total_losses INT UNSIGNED DEFAULT 0,
    
    -- Controle de execução
    activated_at TIMESTAMP NULL,
    deactivated_at TIMESTAMP NULL,
    deactivation_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Índices
    UNIQUE KEY idx_user_id (user_id),
    INDEX idx_is_active (is_active),
    INDEX idx_session_status (session_status),
    INDEX idx_trader_id (trader_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Configuração de Copy Trading por usuário - permite execução em background';

