-- Adicionar campos relacionados ao trading/Deriv na tabela experts

-- Adicionar campos (uma coluna por vez)
ALTER TABLE experts ADD COLUMN login_original VARCHAR(50) NULL COMMENT 'LoginID Original (conta de teste da Deriv)';
ALTER TABLE experts ADD COLUMN login_alvo VARCHAR(50) NULL COMMENT 'LoginID Alvo (conta real conectada à Deriv)';
ALTER TABLE experts ADD COLUMN saldo_alvo DECIMAL(15,2) DEFAULT 0.00 COMMENT 'Saldo Alvo em USD';
ALTER TABLE experts ADD COLUMN connection_status VARCHAR(50) DEFAULT 'Desconectado' COMMENT 'Status da conexão: Ativo, Sincronizando, Desconectado';

-- Atualizar experts existentes com dados de exemplo
UPDATE experts SET 
    login_original = 'VRTC12345678',
    login_alvo = 'CR8765432',
    saldo_alvo = 15340.50,
    connection_status = 'Ativo'
WHERE email = 'carlos.silva@example.com';

UPDATE experts SET 
    login_original = 'VRTC87654321',
    login_alvo = 'CR2345678',
    saldo_alvo = 21110.00,
    connection_status = 'Sincronizando'
WHERE email = 'ana.rodrigues@example.com';

UPDATE experts SET 
    login_original = 'VRTC55566677',
    login_alvo = 'CR-Inválido',
    saldo_alvo = 8361.50,
    connection_status = 'Desconectado'
WHERE email = 'joao.martins@example.com';

UPDATE experts SET 
    login_original = 'VRTC99887766',
    login_alvo = 'CR5544332',
    saldo_alvo = 12500.00,
    connection_status = 'Ativo'
WHERE email = 'maria.santos@example.com';

UPDATE experts SET 
    login_original = 'VRTC11223344',
    login_alvo = 'CR9988776',
    saldo_alvo = 18750.00,
    connection_status = 'Ativo'
WHERE email = 'pedro.costa@example.com';

-- Verificar os dados atualizados
SELECT 
    email,
    login_original,
    login_alvo,
    CONCAT('US$ ', FORMAT(saldo_alvo, 2, 'pt_BR')) AS saldo_formatado,
    connection_status,
    is_active
FROM experts
ORDER BY saldo_alvo DESC;

