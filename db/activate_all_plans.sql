-- ============================================
-- Ativar todos os planos no banco
-- ============================================

USE zeenix;

-- Mostrar estado atual
SELECT 
    id,
    name,
    slug,
    is_active as 'Status Antes (0=Inativo, 1=Ativo)'
FROM plans;

-- Ativar todos os planos
UPDATE plans SET is_active = 1;

-- Mostrar estado após atualização
SELECT 
    id,
    name,
    slug,
    is_active as 'Status Depois (0=Inativo, 1=Ativo)'
FROM plans;

SELECT '✅ Todos os planos foram ativados!' as Resultado;








