-- Adicionar campos de estratégia e nível de risco ao agente autônomo

ALTER TABLE autonomous_agent_config
ADD COLUMN IF NOT EXISTS strategy VARCHAR(50) DEFAULT 'arion' COMMENT 'Estratégia selecionada: arion, cryptomax, orion_ultra, metaflow',
ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) DEFAULT 'balanced' COMMENT 'Nível de risco: conservative, balanced, aggressive';

