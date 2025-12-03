-- Tabela de operações replicadas do Copy Trading
-- Armazena todas as operações que foram copiadas do trader

CREATE TABLE IF NOT EXISTS copy_trading_operations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_id INT UNSIGNED NOT NULL COMMENT 'Referência à sessão de copy',
    user_id INT UNSIGNED NOT NULL COMMENT 'Usuário que executou a operação',
    
    -- Informações da operação original do trader
    trader_operation_id VARCHAR(255) NULL COMMENT 'ID da operação do trader (se disponível)',
    
    -- Detalhes da operação
    operation_type VARCHAR(50) NOT NULL COMMENT 'CALL, PUT, MATCHES, etc',
    symbol VARCHAR(100) NULL COMMENT 'Par de moedas ou ativo',
    duration INT NULL COMMENT 'Duração da operação em segundos',
    stake_amount DECIMAL(10, 2) NOT NULL COMMENT 'Valor investido na operação',
    
    -- Resultado
    result ENUM('win', 'loss', 'pending') NOT NULL DEFAULT 'pending',
    profit DECIMAL(10, 2) DEFAULT 0.00 COMMENT 'Lucro/perda da operação',
    payout DECIMAL(10, 2) NULL COMMENT 'Payout recebido (se win)',
    
    -- Configurações aplicadas
    leverage VARCHAR(10) NULL COMMENT 'Alavancagem usada',
    allocation_type ENUM('proportion', 'fixed') NULL COMMENT 'Tipo de alocação usada',
    allocation_value DECIMAL(10, 2) NULL COMMENT 'Valor/percentual usado',
    
    -- Timestamps
    executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Quando a operação foi executada',
    closed_at TIMESTAMP NULL COMMENT 'Quando a operação foi encerrada',
    
    -- Índices
    INDEX idx_session_id (session_id),
    INDEX idx_user_id (user_id),
    INDEX idx_executed_at (executed_at),
    INDEX idx_result (result),
    
    -- Foreign keys
    FOREIGN KEY (session_id) REFERENCES copy_trading_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Operações replicadas do Copy Trading';



