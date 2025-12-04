-- ============================================
-- ZENIX v2.0: STOP-LOSS BLINDADO
-- Adiciona campos e status para proteção de lucros
-- ============================================

USE zeenix;

-- Adicionar campo de percentual de proteção do stop blindado
-- Verificar se coluna já existe antes de adicionar
SET @column_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'zeenix' 
    AND TABLE_NAME = 'ai_user_config' 
    AND COLUMN_NAME = 'stop_blindado_percent'
);

-- Adicionar coluna somente se não existir
SET @sql = IF(@column_exists = 0,
    'ALTER TABLE ai_user_config ADD COLUMN stop_blindado_percent DECIMAL(5,2) DEFAULT 50.00 COMMENT ''Percentual de proteção do stop blindado (%)'' AFTER profit_target',
    'SELECT ''Coluna stop_blindado_percent já existe'' as Aviso'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Atualizar enum de session_status para incluir 'stopped_blindado'
ALTER TABLE ai_user_config
MODIFY COLUMN session_status ENUM('active', 'stopped_profit', 'stopped_loss', 'stopped_blindado') 
DEFAULT 'active'
COMMENT 'Status da sessão: active, stopped_profit, stopped_loss, stopped_blindado';

-- Verificar resultado
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

SELECT '✅ Campos do Stop-Loss Blindado (ZENIX v2.0) criados!' as Resultado;

-- ============================================
-- INSTRUÇÕES DE USO:
-- ============================================
-- 
-- Executar no servidor:
-- mysql -u root -p zeenix < /var/www/zeenix/backend/db/add_stop_blindado_zenix.sql
-- 
-- Ou via senha direta (se tiver no .env):
-- mysql -u root -p$(grep MYSQL_ROOT_PASSWORD /var/www/zeenix/.env | cut -d '=' -f2) zeenix < /var/www/zeenix/backend/db/add_stop_blindado_zenix.sql
-- 
-- Verificar que funcionou:
-- mysql -u root -p zeenix -e "SHOW COLUMNS FROM ai_user_config LIKE 'stop_blindado_percent';"
-- mysql -u root -p zeenix -e "SHOW COLUMNS FROM ai_user_config LIKE 'session_status';"
-- 
-- ============================================

