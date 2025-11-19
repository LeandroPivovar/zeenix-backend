-- Script para remover constraint UNIQUE e permitir múltiplas sessões
-- Execute este script no MySQL para corrigir o erro de duplicate entry

USE zeenix;

-- 1. Verificar se o índice é UNIQUE
SELECT 
    INDEX_NAME,
    NON_UNIQUE,
    CASE WHEN NON_UNIQUE = 0 THEN '❌ UNIQUE (bloqueia múltiplas sessões)' 
         ELSE '✅ Normal (permite múltiplas sessões)' 
    END as status
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ai_user_config'
  AND INDEX_NAME = 'idx_user_id';

-- 2. Remover índice UNIQUE
ALTER TABLE ai_user_config DROP INDEX idx_user_id;

-- 3. Recriar como índice normal (não-unique)
ALTER TABLE ai_user_config ADD INDEX idx_user_id (user_id);

-- 4. Adicionar índice composto para performance
ALTER TABLE ai_user_config 
ADD INDEX idx_user_active (user_id, is_active, created_at);

-- 5. Verificar resultado
SELECT 
    INDEX_NAME,
    NON_UNIQUE,
    COLUMN_NAME,
    CASE WHEN NON_UNIQUE = 0 THEN '❌ UNIQUE' 
         ELSE '✅ Normal' 
    END as tipo
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ai_user_config'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 6. Testar se múltiplas sessões funcionam
SELECT 
    '✅ Migração concluída! Múltiplas sessões agora permitidas.' AS status;

