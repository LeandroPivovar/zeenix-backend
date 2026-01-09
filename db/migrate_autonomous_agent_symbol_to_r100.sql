-- Migração: Atualizar todos os agentes autônomos para usar R_100
-- Data: 2024-12-19
-- Descrição: Todos os agentes autônomos agora operam apenas em R_100

-- Atualizar símbolo padrão na tabela
UPDATE autonomous_agent_config 
SET symbol = 'R_100' 
WHERE symbol != 'R_100' OR symbol IS NULL;

-- Verificar se há registros que precisam ser atualizados
SELECT 
    COUNT(*) as total_registros,
    COUNT(CASE WHEN symbol = 'R_100' THEN 1 END) as r100_count,
    COUNT(CASE WHEN symbol != 'R_100' THEN 1 END) as outros_count
FROM autonomous_agent_config;


