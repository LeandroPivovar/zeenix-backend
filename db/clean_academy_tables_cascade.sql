-- ============================================
-- Script ULTRA SIMPLES - Aproveita CASCADE
-- Como as foreign keys têm ON DELETE CASCADE,
-- deletar de courses remove tudo automaticamente
-- ============================================

DELETE FROM `courses`;

-- Verifica se está tudo limpo
SELECT 
    'courses' AS tabela, COUNT(*) AS total FROM `courses`
UNION ALL
SELECT 'modules', COUNT(*) FROM `modules`
UNION ALL
SELECT 'lessons', COUNT(*) FROM `lessons`
UNION ALL
SELECT 'materials', COUNT(*) FROM `materials`
UNION ALL
SELECT 'user_lesson_progress', COUNT(*) FROM `user_lesson_progress`;

