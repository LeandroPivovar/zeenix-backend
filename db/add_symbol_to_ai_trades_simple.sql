-- Versão simples: Adicionar campo symbol na tabela ai_trades
-- Execute este script se a versão com verificação não funcionar
-- Se a coluna já existir, você verá um erro que pode ser ignorado

ALTER TABLE ai_trades
ADD COLUMN symbol VARCHAR(50) NOT NULL DEFAULT 'R_10' COMMENT 'Símbolo do mercado operado (ex: R_10, R_50)' AFTER user_id;

-- Atualizar registros existentes com o valor padrão
UPDATE ai_trades SET symbol = 'R_10' WHERE symbol IS NULL OR symbol = '';



