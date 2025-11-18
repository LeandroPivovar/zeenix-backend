-- Tabela de Experts/Especialistas do sistema
CREATE TABLE IF NOT EXISTS experts (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    specialty VARCHAR(100) NOT NULL COMMENT 'Especialidade: Forex, Crypto, Stocks, etc',
    bio TEXT COMMENT 'Biografia/Descrição do expert',
    avatar_url VARCHAR(500) NULL COMMENT 'URL da foto do expert',
    experience_years INT DEFAULT 0 COMMENT 'Anos de experiência',
    rating DECIMAL(3,2) DEFAULT 0.00 COMMENT 'Avaliação média (0-5)',
    total_reviews INT DEFAULT 0 COMMENT 'Total de avaliações recebidas',
    total_followers INT DEFAULT 0 COMMENT 'Total de seguidores',
    total_signals INT DEFAULT 0 COMMENT 'Total de sinais enviados',
    win_rate DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Taxa de acerto (%)',
    is_verified BOOLEAN DEFAULT false COMMENT 'Expert verificado pela plataforma',
    is_active BOOLEAN DEFAULT true COMMENT 'Expert ativo no sistema',
    social_links JSON NULL COMMENT 'Links de redes sociais',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_specialty (specialty),
    INDEX idx_is_verified (is_verified),
    INDEX idx_is_active (is_active),
    INDEX idx_rating (rating),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inserir alguns experts de exemplo
INSERT INTO experts (id, name, email, specialty, bio, experience_years, rating, total_reviews, total_followers, total_signals, win_rate, is_verified, is_active) VALUES
(UUID(), 'Carlos Silva', 'carlos.silva@example.com', 'Forex', 'Especialista em mercado Forex com 15 anos de experiência. Focado em day trading e análise técnica.', 15, 4.8, 234, 1520, 450, 78.50, true, true),
(UUID(), 'Ana Rodrigues', 'ana.rodrigues@example.com', 'Crypto', 'Analista de criptomoedas e blockchain. Especializada em Bitcoin e altcoins.', 8, 4.9, 189, 2340, 320, 82.30, true, true),
(UUID(), 'João Martins', 'joao.martins@example.com', 'Stocks', 'Trader de ações com foco em análise fundamentalista e swing trading.', 12, 4.7, 156, 980, 280, 75.40, true, true),
(UUID(), 'Maria Santos', 'maria.santos@example.com', 'Options', 'Especialista em opções binárias e estratégias avançadas de trading.', 10, 4.6, 98, 756, 195, 73.20, true, true),
(UUID(), 'Pedro Costa', 'pedro.costa@example.com', 'Commodities', 'Trader de commodities com experiência em ouro, petróleo e grãos.', 18, 4.5, 78, 543, 156, 71.80, false, true);

