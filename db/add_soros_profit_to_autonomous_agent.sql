-- Script para adicionar campo soros_profit ao autonomous_agent_config
-- Este campo armazena o profit da última operação ganha no Soros
-- Necessário para cálculo correto de net_loss conforme documentação

ALTER TABLE autonomous_agent_config
ADD COLUMN soros_profit DECIMAL(10, 2) DEFAULT 0
COMMENT 'Profit da última operação ganha no Soros (para cálculo de net_loss)'
AFTER soros_stake;

