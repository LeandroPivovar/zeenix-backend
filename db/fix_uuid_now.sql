-- ============================================
-- CORREÇÃO RÁPIDA: Alterar user_id para UUID
-- Execute este arquivo AGORA para corrigir
-- ============================================

USE zeenix;

-- Desabilitar foreign keys
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Alterar copy_trading_config
ALTER TABLE copy_trading_config 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- 2. Alterar copy_trading_sessions
ALTER TABLE copy_trading_sessions 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- 3. Alterar copy_trading_operations (se existir)
ALTER TABLE copy_trading_operations 
MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário';

-- Reabilitar foreign keys
SET FOREIGN_KEY_CHECKS = 1;

-- Verificar resultado
SELECT '✅ MIGRAÇÃO CONCLUÍDA!' as status;

SELECT 
    TABLE_NAME as tabela,
    COLUMN_NAME as campo,
    COLUMN_TYPE as tipo
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'zeenix' 
AND TABLE_NAME IN ('copy_trading_config', 'copy_trading_sessions', 'copy_trading_operations')
AND COLUMN_NAME = 'user_id';











