-- Adiciona campos de role e status para gerenciamento de administradores
-- Execute este script no banco de dados

-- Adicionar coluna de role (função do usuário)
ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'user' AFTER password;

-- Adicionar coluna de status
ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT true AFTER role;

-- Adicionar coluna de último login
ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL AFTER is_active;

-- Criar índice para busca por role
CREATE INDEX idx_users_role ON users(role);

-- Criar índice para busca por status
CREATE INDEX idx_users_is_active ON users(is_active);

-- Atualizar usuários existentes (todos começam como 'user')
UPDATE users SET role = 'user', is_active = true WHERE role IS NULL;

