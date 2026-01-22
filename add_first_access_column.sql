-- Adicionar coluna first_access à tabela users
ALTER TABLE users ADD COLUMN first_access BOOLEAN DEFAULT TRUE;
