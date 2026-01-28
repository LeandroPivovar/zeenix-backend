-- =========================================================================
-- MIGRATION CONSOLIDADA: DERIV CURRENCY (ATUALIZADO)
-- Adiciona suporte a moeda (USD/DEMO) em todas as tabelas de operação
-- =========================================================================

-- 1. Tabela trades (Operações Manuais)
ALTER TABLE trades ADD COLUMN deriv_currency VARCHAR(10) NULL DEFAULT 'USD';

-- 2. Tabela autonomous_agent_trades (Agentes Autônomos)
ALTER TABLE autonomous_agent_trades ADD COLUMN deriv_currency VARCHAR(10) NULL DEFAULT 'USD';

-- 3. Tabela ai_user_config (Configuração de Sessão de IA)
ALTER TABLE ai_user_config ADD COLUMN deriv_currency VARCHAR(10) NULL DEFAULT 'USD';

-- 4. Tabela ai_trades (Operações de IA - Histórico)
-- Necessário para validar se a operação específica foi em conta Real
ALTER TABLE ai_trades ADD COLUMN deriv_currency VARCHAR(10) NULL DEFAULT 'USD';

-- 5. Tabela copy_trading_operations (Operações de Copy Trading)
ALTER TABLE copy_trading_operations ADD COLUMN deriv_currency VARCHAR(10) NULL DEFAULT 'USD';
