-- Mostrar todos os experts cadastrados
-- Execute este arquivo para ver todos os experts no banco de dados

-- Versão simples (principais campos)
SELECT 
    id,
    name AS 'Nome',
    email AS 'Email',
    specialty AS 'Especialidade',
    experience_years AS 'Anos Exp.',
    rating AS 'Avaliação',
    total_reviews AS 'Reviews',
    win_rate AS 'Win Rate %',
    is_verified AS 'Verificado',
    is_active AS 'Ativo',
    created_at AS 'Cadastrado em'
FROM experts
ORDER BY rating DESC, created_at DESC;

-- Versão formatada (mais legível)
SELECT 
    CONCAT('ID: ', SUBSTRING(id, 1, 8), '...') AS 'Identificação',
    name AS 'Nome Completo',
    email AS 'Email de Contato',
    specialty AS 'Especialidade',
    CONCAT(experience_years, ' anos') AS 'Experiência',
    CONCAT(ROUND(rating, 1), ' ⭐ (', total_reviews, ' reviews)') AS 'Avaliação',
    CONCAT(total_followers, ' seguidores') AS 'Seguidores',
    CONCAT(total_signals, ' sinais') AS 'Sinais Enviados',
    CONCAT(ROUND(win_rate, 1), '%') AS 'Taxa de Acerto',
    CASE 
        WHEN is_verified = 1 THEN '✅ Verificado'
        ELSE '❌ Não Verificado'
    END AS 'Status Verificação',
    CASE 
        WHEN is_active = 1 THEN '✅ Ativo'
        ELSE '❌ Inativo'
    END AS 'Status Atividade',
    DATE_FORMAT(created_at, '%d/%m/%Y %H:%i') AS 'Data de Cadastro'
FROM experts
ORDER BY rating DESC, created_at DESC;

-- Estatísticas gerais
SELECT 
    '📊 ESTATÍSTICAS GERAIS' AS '';

SELECT 
    COUNT(*) AS 'Total de Experts',
    SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS 'Experts Ativos',
    SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) AS 'Experts Verificados',
    CONCAT(ROUND(AVG(rating), 1), ' ⭐') AS 'Avaliação Média',
    CONCAT(ROUND(AVG(win_rate), 1), '%') AS 'Win Rate Médio',
    SUM(total_followers) AS 'Total de Seguidores',
    SUM(total_signals) AS 'Total de Sinais'
FROM experts;

-- Agrupar por especialidade
SELECT 
    '📈 POR ESPECIALIDADE' AS '';

SELECT 
    specialty AS 'Especialidade',
    COUNT(*) AS 'Quantidade',
    CONCAT(ROUND(AVG(rating), 1), ' ⭐') AS 'Média Rating',
    CONCAT(ROUND(AVG(win_rate), 1), '%') AS 'Média Win Rate',
    CONCAT(ROUND(AVG(experience_years), 0), ' anos') AS 'Média Experiência'
FROM experts
GROUP BY specialty
ORDER BY COUNT(*) DESC, AVG(rating) DESC;

-- Top 3 Experts
SELECT 
    '🏆 TOP 3 EXPERTS (POR RATING)' AS '';

SELECT 
    name AS 'Nome',
    specialty AS 'Especialidade',
    CONCAT(rating, ' ⭐') AS 'Avaliação',
    CONCAT(win_rate, '%') AS 'Win Rate',
    CASE WHEN is_verified = 1 THEN '✅' ELSE '❌' END AS 'Verificado'
FROM experts
ORDER BY rating DESC
LIMIT 3;

