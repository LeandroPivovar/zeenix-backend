-- Script de teste para verificar a tabela de Experts

-- 1. Verificar se a tabela existe
SHOW TABLES LIKE 'experts';

-- 2. Ver estrutura da tabela
DESCRIBE experts;

-- 3. Contar total de experts
SELECT COUNT(*) AS total_experts FROM experts;

-- 4. Listar todos os experts
SELECT 
    id,
    name,
    email,
    specialty,
    experience_years,
    rating,
    total_reviews,
    total_followers,
    win_rate,
    is_verified,
    is_active,
    created_at
FROM experts
ORDER BY rating DESC, created_at DESC;

-- 5. Verificar experts ativos
SELECT 
    COUNT(*) AS experts_ativos
FROM experts
WHERE is_active = TRUE;

-- 6. Verificar experts verificados
SELECT 
    COUNT(*) AS experts_verificados
FROM experts
WHERE is_verified = TRUE;

-- 7. Calcular avaliação média
SELECT 
    ROUND(AVG(rating), 1) AS avaliacao_media
FROM experts;

-- 8. Estatísticas por especialidade
SELECT 
    specialty,
    COUNT(*) AS total,
    ROUND(AVG(rating), 1) AS rating_medio,
    ROUND(AVG(win_rate), 1) AS win_rate_medio
FROM experts
GROUP BY specialty
ORDER BY total DESC;

