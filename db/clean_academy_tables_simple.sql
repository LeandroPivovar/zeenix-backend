-- ============================================
-- Script SIMPLES para limpar todas as tabelas da Academy
-- ATENÇÃO: Esta query irá DELETAR TODOS os dados!
-- ============================================

-- Desabilita verificação de foreign keys
SET FOREIGN_KEY_CHECKS = 0;

-- Deleta todas as tabelas relacionadas (na ordem correta)
DELETE FROM `materials`;
DELETE FROM `user_lesson_progress`;
DELETE FROM `lessons`;
DELETE FROM `modules`;
DELETE FROM `courses`;

-- Reabilita verificação de foreign keys
SET FOREIGN_KEY_CHECKS = 1;

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

