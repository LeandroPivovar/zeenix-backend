-- Tabela de configuração do Agente Autônomo "IA SENTINEL" por usuário
-- Permite que o usuário tenha 1 IA e 1 agente autônomo rodando simultaneamente

CREATE TABLE IF NOT EXISTS autonomous_agent_config (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário (char(36) da tabela users)',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Configurações do usuário
    initial_stake DECIMAL(10, 2) NOT NULL DEFAULT 10.00 COMMENT 'Valor de entrada inicial (M0)',
    daily_profit_target DECIMAL(10, 2) NOT NULL DEFAULT 200.00 COMMENT 'Meta de lucro diário (Stop Win)',
    daily_loss_limit DECIMAL(10, 2) NOT NULL DEFAULT 240.00 COMMENT 'Limite de perda diário (Stop Loss)',
    
    -- Configurações técnicas
    deriv_token TEXT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    symbol VARCHAR(20) NOT NULL DEFAULT 'R_100' COMMENT 'Índice de Volatilidade 100 (todos os agentes autônomos usam R_100)',
    
    -- Controle de execução
    last_trade_at TIMESTAMP NULL,
    next_trade_at TIMESTAMP NULL,
    last_pause_at TIMESTAMP NULL COMMENT 'Última pausa aleatória',
    operations_since_pause INT UNSIGNED DEFAULT 0 COMMENT 'Contador de operações desde última pausa',
    
    -- Estado do Martingale Inteligente
    martingale_level ENUM('M0', 'M1') NOT NULL DEFAULT 'M0' COMMENT 'M0: Rise/Fall, M1: Higher/Lower',
    last_loss_amount DECIMAL(10, 2) DEFAULT 0 COMMENT 'Valor da última perda para recuperação',
    
    -- Estatísticas
    total_trades INT UNSIGNED DEFAULT 0,
    total_wins INT UNSIGNED DEFAULT 0,
    total_losses INT UNSIGNED DEFAULT 0,
    daily_profit DECIMAL(10, 2) DEFAULT 0 COMMENT 'Lucro acumulado no dia',
    daily_loss DECIMAL(10, 2) DEFAULT 0 COMMENT 'Perda acumulada no dia',
    
    -- Controle de sessão diária
    session_date DATE NULL COMMENT 'Data da sessão atual',
    session_status ENUM('active', 'stopped_profit', 'stopped_loss', 'paused') DEFAULT 'active',
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Índices
    UNIQUE KEY idx_user_id (user_id),
    INDEX idx_is_active (is_active),
    INDEX idx_next_trade_at (next_trade_at),
    INDEX idx_session_date (session_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Configuração do Agente Autônomo IA SENTINEL por usuário';

