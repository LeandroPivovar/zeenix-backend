-- =========================================================================
-- CREATE TABLE: markets
-- Tabela para armazenar os mercados sincronizados da Deriv
-- =========================================================================

CREATE TABLE markets (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()), -- Ou UUID se for PostgreSQL, CHAR(36) comum em MySQL/MariaDB
    symbol VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    market VARCHAR(255) NOT NULL,
    market_display_name VARCHAR(255) NOT NULL,
    submarket VARCHAR(255) NOT NULL,
    submarket_display_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
