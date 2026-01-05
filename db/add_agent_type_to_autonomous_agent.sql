-- Migration: Adicionar campo agent_type para suportar múltiplos agentes autônomos
-- Permite escolher entre SENTINEL e FALCON

ALTER TABLE autonomous_agent_config 
ADD COLUMN agent_type VARCHAR(20) NOT NULL DEFAULT 'sentinel' 
COMMENT 'Tipo de agente: sentinel ou falcon'
AFTER symbol;

-- Atualizar registros existentes para 'sentinel' (padrão)
UPDATE autonomous_agent_config 
SET agent_type = 'sentinel' 
WHERE agent_type IS NULL OR agent_type = '';

-- Adicionar índice para melhor performance
CREATE INDEX idx_agent_type ON autonomous_agent_config(agent_type);

