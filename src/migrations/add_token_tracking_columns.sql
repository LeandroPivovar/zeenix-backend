-- Add token tracking columns to autonomous_agent_trades table
-- Execute this query in your MySQL database

ALTER TABLE autonomous_agent_trades 
ADD COLUMN deriv_token VARCHAR(255) DEFAULT NULL COMMENT 'Token usado para executar o trade';

ALTER TABLE autonomous_agent_trades 
ADD COLUMN deriv_account_type VARCHAR(10) DEFAULT NULL COMMENT 'Tipo de conta: demo ou real';

-- Verify columns were added
DESCRIBE autonomous_agent_trades;
