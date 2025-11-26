-- Tabela de sessões de Copy Trading
-- Cada vez que o usuário inicia o copy, uma nova sessão é criada
-- Quando pausa, a sessão é encerrada

CREATE TABLE IF NOT EXISTS copy_trading_sessions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    config_id INT UNSIGNED NOT NULL COMMENT 'Referência à copy_trading_config',
    trader_id VARCHAR(100) NOT NULL COMMENT 'ID do trader copiado',
    trader_name VARCHAR(255) NOT NULL COMMENT 'Nome do trader',
    
    -- Status da sessão
    status ENUM('active', 'paused', 'ended') NOT NULL DEFAULT 'active' COMMENT 'active, paused, ended',
    
    -- Estatísticas da sessão
    initial_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT 'Saldo inicial da sessão',
    current_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT 'Saldo atual da sessão',
    total_profit DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT 'Lucro/perda total da sessão',
    total_operations INT UNSIGNED DEFAULT 0 COMMENT 'Total de operações na sessão',
    total_wins INT UNSIGNED DEFAULT 0,
    total_losses INT UNSIGNED DEFAULT 0,
    
    -- Timestamps
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Quando a sessão foi iniciada',
    paused_at TIMESTAMP NULL COMMENT 'Quando a sessão foi pausada',
    ended_at TIMESTAMP NULL COMMENT 'Quando a sessão foi encerrada',
    last_operation_at TIMESTAMP NULL COMMENT 'Última operação executada',
    
    -- Índices
    INDEX idx_user_id (user_id),
    INDEX idx_config_id (config_id),
    INDEX idx_status (status),
    INDEX idx_started_at (started_at),
    
    -- Foreign keys
    FOREIGN KEY (config_id) REFERENCES copy_trading_config(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Sessões de Copy Trading - cada ativação cria uma nova sessão';

