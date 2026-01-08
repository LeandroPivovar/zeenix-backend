-- Script para corrigir dados corrompidos na tabela ai_websocket_state
-- Remove registros com ticks_data inválido (como [object Object])

-- Limpar ticks_data corrompidos (que não são JSON válido)
UPDATE ai_websocket_state 
SET ticks_data = '[]' 
WHERE ticks_data IS NOT NULL 
  AND (
    ticks_data LIKE '[object%' 
    OR ticks_data NOT LIKE '[%'
    OR ticks_data NOT LIKE '%]%'
  );

-- Verificar se há mais dados corrompidos
SELECT symbol, 
       CASE 
         WHEN ticks_data LIKE '[object%' THEN 'CORROMPIDO'
         WHEN ticks_data IS NULL THEN 'NULL'
         WHEN ticks_data = '' THEN 'VAZIO'
         ELSE 'OK'
       END as status,
       LEFT(ticks_data, 50) as preview
FROM ai_websocket_state;

