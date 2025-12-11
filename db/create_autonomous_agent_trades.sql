-- Tabela para armazenar operações do Agente Autônomo "IA SENTINEL"
-- Similar à ai_trades, mas específica para o agente autônomo

CREATE TABLE IF NOT EXISTS autonomous_agent_trades (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário (char(36) da tabela users)',
    
    -- Dados da análise técnica
    analysis_data JSON NOT NULL COMMENT 'Dados da análise: EMAs, RSI, Momentum, etc',
    confidence_score DECIMAL(5, 2) NOT NULL COMMENT 'Score de confiança (0-100)',
    analysis_reasoning TEXT COMMENT 'Explicação da análise e decisão',
    
    -- Dados da operação
    contract_type VARCHAR(20) NOT NULL COMMENT 'RISE, FALL, HIGHER, LOWER',
    contract_duration INT NOT NULL COMMENT 'Duração em ticks (5-10)',
    entry_price DECIMAL(10, 4) NOT NULL,
    stake_amount DECIMAL(10, 2) NOT NULL,
    contract_id VARCHAR(100),
    
    -- Martingale
    martingale_level ENUM('M0', 'M1') NOT NULL DEFAULT 'M0',
    payout DECIMAL(5, 2) COMMENT 'Payout do contrato (%)',
    
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
    symbol VARCHAR(20) NOT NULL DEFAULT 'R_75',
    
    INDEX idx_autonomous_agent_trades_user_id (user_id),
    INDEX idx_autonomous_agent_trades_status (status),
    INDEX idx_autonomous_agent_trades_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Armazena operações realizadas pelo Agente Autônomo IA SENTINEL';

