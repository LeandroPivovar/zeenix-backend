-- ============================================
-- Script para verificar os campos gravados
-- ============================================

USE zeenix;

-- Verificar última configuração criada
SELECT 
    id,
    user_id,
    trader_name,
    allocation_type,
    allocation_value,
    allocation_percentage,
    leverage,
    stop_loss as 'Stop Loss (USD)',
    take_profit as 'Take Profit (USD)',
    blind_stop_loss as 'Blind Stop (0=Inativo, 1=Ativo)',
    is_active,
    session_status,
    activated_at
FROM copy_trading_config 
ORDER BY id DESC 
LIMIT 1\G

-- Verificar última sessão criada
SELECT 
    id,
    user_id,
    trader_name,
    status,
    initial_balance,
    current_balance,
    total_profit,
    started_at
FROM copy_trading_sessions 
ORDER BY id DESC 
LIMIT 1\G












