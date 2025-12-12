-- Script para corrigir o tipo de dados do user_id nas tabelas do agente autônomo
-- Alterando de INT UNSIGNED para VARCHAR(36) para compatibilidade com UUID da tabela users

USE `zeenix`;

-- Alterar user_id na tabela autonomous_agent_config
ALTER TABLE `autonomous_agent_config` 
MODIFY COLUMN `user_id` VARCHAR(36) NOT NULL COMMENT 'UUID do usuário (char(36) da tabela users)';

-- Alterar user_id na tabela autonomous_agent_trades
ALTER TABLE `autonomous_agent_trades` 
MODIFY COLUMN `user_id` VARCHAR(36) NOT NULL COMMENT 'UUID do usuário (char(36) da tabela users)';

-- Alterar user_id na tabela autonomous_agent_logs
ALTER TABLE `autonomous_agent_logs` 
MODIFY COLUMN `user_id` VARCHAR(36) NOT NULL COMMENT 'UUID do usuário (char(36) da tabela users)';

SELECT 'Colunas user_id alteradas para VARCHAR(36) com sucesso!' AS message;



