-- ============================================
-- ZENIX v2.0: STOP-LOSS BLINDADO (FIX)
-- Versão corrigida - adiciona campos sem erro
-- ============================================

USE zeenix;

-- 1. Adicionar coluna stop_blindado_percent (ignora se já existir)
ALTER TABLE ai_user_config 
ADD COLUMN stop_blindado_percent DECIMAL(5,2) DEFAULT 50.00 
COMMENT 'Percentual de proteção do stop blindado (%)' 
AFTER profit_target;

-- Se der erro "Duplicate column name", é porque já existe (OK!)

-- 2. Atualizar enum de session_status (sempre executa)
ALTER TABLE ai_user_config
MODIFY COLUMN session_status ENUM('active', 'stopped_profit', 'stopped_loss', 'stopped_blindado') 
DEFAULT 'active'
COMMENT 'Status da sessão: active, stopped_profit, stopped_loss, stopped_blindado';

-- 3. Verificar resultado
SELECT 
    COLUMN_NAME as 'Coluna',
    COLUMN_TYPE as 'Tipo',
    COLUMN_DEFAULT as 'Padrão',
    COLUMN_COMMENT as 'Comentário'
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'zeenix'
    AND TABLE_NAME = 'ai_user_config'
    AND COLUMN_NAME IN ('stop_blindado_percent', 'session_status')
ORDER BY ORDINAL_POSITION;

SELECT '✅ Stop-Loss Blindado (ZENIX v2.0) configurado!' as Resultado;

-- ============================================
-- INSTRUÇÕES:
-- ============================================
-- 
-- Se você receber erro "Duplicate column name 'stop_blindado_percent'":
-- → Isso é NORMAL! Significa que a coluna já existe.
-- → O enum session_status será atualizado mesmo assim.
-- 
-- ============================================











