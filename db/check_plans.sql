-- ============================================
-- Verificar Planos no Banco de Dados
-- ============================================

USE zeenix;

-- Verificar todos os planos
SELECT 
    id,
    name,
    slug,
    price,
    currency,
    is_active as 'Ativo (0=Não, 1=Sim)',
    is_popular as 'Popular',
    is_recommended as 'Recomendado',
    display_order as 'Ordem',
    features
FROM plans
ORDER BY display_order;

-- Contar planos por status
SELECT 
    CASE 
        WHEN is_active = 1 THEN 'Ativos'
        ELSE 'Inativos'
    END as Status,
    COUNT(*) as Total
FROM plans
GROUP BY is_active;

-- Verificar estrutura da coluna is_active
SELECT 
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'zeenix'
AND TABLE_NAME = 'plans'
AND COLUMN_NAME = 'is_active';

















