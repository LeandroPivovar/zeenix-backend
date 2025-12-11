-- Adicionar campos de estratégia e nível de risco ao agente autônomo
-- Execute este script no banco de dados MySQL

-- Adicionar coluna strategy
ALTER TABLE autonomous_agent_config
ADD COLUMN strategy VARCHAR(50) NOT NULL DEFAULT 'arion' COMMENT 'Estratégia selecionada: arion, cryptomax, orion_ultra, metaflow';

-- Adicionar coluna risk_level
ALTER TABLE autonomous_agent_config
ADD COLUMN risk_level VARCHAR(20) NOT NULL DEFAULT 'balanced' COMMENT 'Nível de risco: conservative, balanced, aggressive';

