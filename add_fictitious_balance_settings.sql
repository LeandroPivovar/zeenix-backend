-- Adicionar colunas para Saldo Fictício na tabela user_settings
ALTER TABLE user_settings
ADD COLUMN fictitious_balance_enabled BOOLEAN DEFAULT FALSE COMMENT 'Indica se o saldo fictício está ativado',
ADD COLUMN fictitious_balance_amount DECIMAL(10, 2) DEFAULT 10000.00 COMMENT 'Valor do saldo fictício';
