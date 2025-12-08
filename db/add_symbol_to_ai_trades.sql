-- Adicionar campo symbol na tabela ai_trades
ALTER TABLE ai_trades 
ADD COLUMN symbol VARCHAR(20) DEFAULT 'R_10' COMMENT 'Símbolo do mercado (ex: R_10, R_25, R_50, R_75, R_100)';

-- Atualizar registros existentes com o valor padrão
UPDATE ai_trades SET symbol = 'R_10' WHERE symbol IS NULL;

