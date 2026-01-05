-- ✅ OTIMIZAÇÃO #6: Indexação de Queries Frequentes
-- Adiciona índices compostos para melhorar performance das queries mais frequentes
-- MySQL não suporta IF NOT EXISTS em CREATE INDEX
-- Execute este script e ignore erros se os índices já existirem

-- Índice composto para queries de configuração ativa por usuário
-- Usado em: SELECT ... FROM autonomous_agent_config WHERE user_id = ? AND is_active = TRUE
CREATE INDEX idx_autonomous_agent_config_user_active 
ON autonomous_agent_config(user_id, is_active);

-- Índice composto para queries de trades por usuário ordenados por data
-- Nota: MySQL não suporta DESC em índices compostos em versões antigas
-- O índice sem DESC ainda melhora performance significativamente
-- Usado em: SELECT ... FROM autonomous_agent_trades WHERE user_id = ? ORDER BY created_at DESC
CREATE INDEX idx_autonomous_agent_trades_user_created 
ON autonomous_agent_trades(user_id, created_at);

-- Índice para queries de atualização por user_id
-- Usado em: UPDATE autonomous_agent_config SET ... WHERE user_id = ?
CREATE INDEX idx_autonomous_agent_config_user_id 
ON autonomous_agent_config(user_id);

-- Índice para queries de trades por user_id
CREATE INDEX idx_autonomous_agent_trades_user_id 
ON autonomous_agent_trades(user_id);

-- Índice para queries de trades por status e data (usado em estatísticas)
CREATE INDEX idx_autonomous_agent_trades_status_created 
ON autonomous_agent_trades(status, created_at);

-- Índice para queries de trades por user_id e status
CREATE INDEX idx_autonomous_agent_trades_user_status 
ON autonomous_agent_trades(user_id, status);
