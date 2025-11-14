-- Adicionar coluna 'mode' à tabela ai_user_config
-- Modos: 'fast' (1 min), 'moderate' (5 min), 'slow' (10 min)

ALTER TABLE ai_user_config
ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'moderate' AFTER currency;

-- Adicionar índice para melhorar consultas
CREATE INDEX idx_ai_user_config_mode ON ai_user_config(mode);

-- Comentário para documentação
ALTER TABLE ai_user_config MODIFY COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'moderate' 
COMMENT 'Modo de operação: fast (1 min), moderate (5 min), slow (10 min)';

