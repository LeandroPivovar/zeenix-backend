-- ============================================
-- Popular Benefícios dos Planos
-- ============================================

USE zeenix;

-- Atualizar Plano Starter com benefícios
UPDATE plans 
SET features = JSON_OBJECT(
    'benefits', JSON_ARRAY(
        '✓ IA Orion limitada',
        '✓ 10 sinais por dia',
        '✓ Suporte por e-mail',
        '✓ Academy básica'
    )
)
WHERE slug = 'starter';

-- Atualizar Plano Pro com benefícios
UPDATE plans 
SET features = JSON_OBJECT(
    'benefits', JSON_ARRAY(
        '✓ IA Orion completa',
        '✓ Copy Trading ilimitado',
        '✓ Zenix Academy completa',
        '✓ Suporte prioritário',
        '✓ Sinais ilimitados'
    )
)
WHERE slug = 'pro';

-- Atualizar Zenix Black com benefícios
UPDATE plans 
SET features = JSON_OBJECT(
    'benefits', JSON_ARRAY(
        '✓ IA Orion Black Module',
        '✓ Copy Trading Premium',
        '✓ Zenix Academy Black Edition',
        '✓ Suporte 1 on 1',
        '✓ Dashboards personalizados',
        '✓ API Access'
    )
)
WHERE slug = 'black';

-- Verificar resultado
SELECT 
    name as 'Plano',
    slug,
    JSON_EXTRACT(features, '$.benefits') as 'Benefícios (JSON)',
    JSON_LENGTH(JSON_EXTRACT(features, '$.benefits')) as 'Total'
FROM plans
ORDER BY display_order;

SELECT '✅ Benefícios atualizados com sucesso!' as Resultado;
SELECT '💡 DICA: Você pode usar ícones/emojis no texto dos benefícios!' as Dica;
SELECT '   Exemplo: "✓ IA Orion" ou "🤖 IA Orion" ou "⭐ IA Orion"' as Exemplo;

