-- Script para alterar session_date de DATE para TIMESTAMP
-- Isso permite armazenar data e hora completa para calcular o tempo ativo corretamente

ALTER TABLE autonomous_agent_config
MODIFY COLUMN session_date TIMESTAMP NULL 
COMMENT 'Data e hora da sessão atual (para cálculo do tempo ativo)';







