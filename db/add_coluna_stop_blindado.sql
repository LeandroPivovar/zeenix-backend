-- ============================================
-- Adicionar apenas a coluna stop_blindado_percent
-- (O session_status já foi atualizado com sucesso!)
-- ============================================

USE zeenix;

-- Adicionar coluna stop_blindado_percent
ALTER TABLE ai_user_config 
ADD COLUMN stop_blindado_percent DECIMAL(5,2) DEFAULT 50.00 
COMMENT 'Percentual de proteção do stop blindado (%)'
AFTER profit_target;

-- Verificar se foi criada
SHOW COLUMNS FROM ai_user_config LIKE 'stop_blindado_percent';

SELECT '✅ Coluna stop_blindado_percent adicionada!' as Resultado;







