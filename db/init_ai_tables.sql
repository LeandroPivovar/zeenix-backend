-- Script para inicializar tabelas da IA
-- Execute este script no banco de dados MySQL

-- Tabela de configuração de IA por usuário
CREATE TABLE IF NOT EXISTS ai_user_config (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    stake_amount DECIMAL(10, 2) NOT NULL DEFAULT 10.00,
    deriv_token TEXT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    mode VARCHAR(20) NOT NULL DEFAULT 'veloz' COMMENT 'Modo de operação: veloz, fast, moderate, slow',
    profit_target DECIMAL(10, 2) NULL COMMENT 'Meta de lucro diária',
    loss_limit DECIMAL(10, 2) NULL COMMENT 'Limite de perda diária',
    
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
    INDEX idx_next_trade_at (next_trade_at),
    INDEX idx_mode (mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Configuração de IA de trading por usuário - permite execução em background';

-- Adicionar colunas profit_target e loss_limit se não existirem
-- Para MySQL 5.7+, use este script (as colunas já estão na criação da tabela acima)
-- Se a tabela já existe sem essas colunas, execute os comandos abaixo:

-- Verificar e adicionar profit_target (descomente se necessário)
-- ALTER TABLE ai_user_config ADD COLUMN profit_target DECIMAL(10, 2) NULL COMMENT 'Meta de lucro diária' AFTER mode;

-- Verificar e adicionar loss_limit (descomente se necessário)
-- ALTER TABLE ai_user_config ADD COLUMN loss_limit DECIMAL(10, 2) NULL COMMENT 'Limite de perda diária' AFTER profit_target;

-- OU use o endpoint da API para criar automaticamente:
-- POST https://iazenix.com/api/ai/init-tables

