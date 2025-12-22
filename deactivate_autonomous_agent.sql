-- Script para desativar o agente autônomo imediatamente
-- Execute este script no banco de dados MySQL

UPDATE autonomous_agent_config 
SET 
  is_active = FALSE, 
  session_status = 'stopped_manual', 
  updated_at = NOW() 
WHERE user_id = 'add86cc5-c531-41ec-b51b-27065d60aa67';

-- Verificar se foi desativado
SELECT 
  user_id,
  is_active,
  session_status,
  updated_at
FROM autonomous_agent_config 
WHERE user_id = 'add86cc5-c531-41ec-b51b-27065d60aa67';

