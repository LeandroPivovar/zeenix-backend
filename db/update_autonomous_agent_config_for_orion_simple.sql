-- Script SIMPLIFICADO para atualizar tabela autonomous_agent_config
-- Execute cada comando separadamente se algum der erro

-- 1. Adicionar campo agent_type (execute apenas se não existir)
-- Verifique primeiro: SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'autonomous_agent_config' AND COLUMN_NAME = 'agent_type';
ALTER TABLE autonomous_agent_config 
ADD COLUMN agent_type VARCHAR(20) DEFAULT 'orion' COMMENT 'Tipo de agente: orion, sentinel, falcon' AFTER symbol;

-- 2. Adicionar campo trading_mode (execute apenas se não existir)
ALTER TABLE autonomous_agent_config 
ADD COLUMN trading_mode VARCHAR(20) DEFAULT 'normal' COMMENT 'Modo de trading: veloz, moderado, preciso, normal, lento' AFTER agent_type;

-- 3. Adicionar campo initial_balance (execute apenas se não existir)
ALTER TABLE autonomous_agent_config 
ADD COLUMN initial_balance DECIMAL(10, 2) DEFAULT 0.00 COMMENT 'Saldo inicial da conta' AFTER daily_loss_limit;

-- 4. Atualizar enum de session_status para incluir 'stopped_blindado'
ALTER TABLE autonomous_agent_config
MODIFY COLUMN session_status ENUM('active', 'stopped_profit', 'stopped_loss', 'stopped_blindado', 'paused') 
DEFAULT 'active'
COMMENT 'Status da sessão: active, stopped_profit, stopped_loss, stopped_blindado, paused';

-- 5. Alterar session_date de DATE para TIMESTAMP (se ainda não for TIMESTAMP)
ALTER TABLE autonomous_agent_config
MODIFY COLUMN session_date TIMESTAMP NULL COMMENT 'Data/hora da sessão atual';

-- 6. Adicionar índice idx_agent_type (execute apenas se não existir)
CREATE INDEX idx_agent_type ON autonomous_agent_config(agent_type);

-- 7. Adicionar índice idx_session_status (execute apenas se não existir)
CREATE INDEX idx_session_status ON autonomous_agent_config(session_status);

-- 8. Verificar se as alterações foram aplicadas
SELECT 
    COLUMN_NAME,
    COLUMN_TYPE,
    COLUMN_DEFAULT,
    COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'autonomous_agent_config'
    AND COLUMN_NAME IN ('agent_type', 'trading_mode', 'initial_balance', 'session_status', 'session_date')
ORDER BY ORDINAL_POSITION;


