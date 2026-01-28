-- =========================================================================
-- MIGRATION: ADD operations COLUMN TO markets
-- Adiciona coluna JSON para armazenar array de operações disponíveis
-- =========================================================================

-- Para MySQL / MariaDB
ALTER TABLE markets ADD COLUMN operations JSON NULL;

-- Exemplo de update se necessário inicializar:
-- UPDATE markets SET operations = '[]' WHERE operations IS NULL;
