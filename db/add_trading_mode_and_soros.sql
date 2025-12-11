-- Script para adicionar campos necessários para Trading Mode, Soros e Stop Loss Blindado
-- Execute este script no banco de dados

-- 1. Adicionar Trading Mode
ALTER TABLE autonomous_agent_config
ADD COLUMN trading_mode VARCHAR(20) NOT NULL DEFAULT 'normal' 
COMMENT 'Modo de negociação: veloz, normal, lento'
AFTER risk_level;

-- 2. Adicionar Stop Loss Type
ALTER TABLE autonomous_agent_config
ADD COLUMN stop_loss_type VARCHAR(20) NOT NULL DEFAULT 'normal'
COMMENT 'Tipo de stop loss: normal, blindado'
AFTER trading_mode;

-- 3. Adicionar campos de Soros
ALTER TABLE autonomous_agent_config
ADD COLUMN soros_level INT UNSIGNED NOT NULL DEFAULT 0
COMMENT 'Nível atual do Soros: 0 (inativo), 1, 2'
AFTER martingale_level;

ALTER TABLE autonomous_agent_config
ADD COLUMN soros_stake DECIMAL(10, 2) DEFAULT 0
COMMENT 'Stake atual do Soros'
AFTER soros_level;

-- 4. Adicionar contador de Martingale (para limite M5 no Conservador)
ALTER TABLE autonomous_agent_config
ADD COLUMN martingale_count INT UNSIGNED NOT NULL DEFAULT 0
COMMENT 'Contador de níveis de Martingale (para limite M5 no modo Conservador)'
AFTER martingale_level;

-- 5. Atualizar ENUM do martingale_level para incluir M2
ALTER TABLE autonomous_agent_config
MODIFY COLUMN martingale_level ENUM('M0', 'M1', 'M2') NOT NULL DEFAULT 'M0'
COMMENT 'M0: Rise/Fall, M1: Higher/Lower, M2: Touch/No Touch';

-- 6. Adicionar campo para saldo inicial (necessário para Stop Loss Blindado)
ALTER TABLE autonomous_agent_config
ADD COLUMN initial_balance DECIMAL(10, 2) DEFAULT 0
COMMENT 'Saldo inicial do dia (para cálculo do Stop Loss Blindado)'
AFTER daily_loss_limit;

-- 7. Adicionar campo para lucro pico (necessário para Stop Loss Blindado)
ALTER TABLE autonomous_agent_config
ADD COLUMN profit_peak DECIMAL(10, 2) DEFAULT 0
COMMENT 'Pico de lucro do dia (para cálculo do Stop Loss Blindado)'
AFTER daily_profit;

