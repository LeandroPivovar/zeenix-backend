-- ============================================
-- Script para limpar todas as tabelas da Academy
-- ATENÇÃO: Esta query irá DELETAR TODOS os dados das tabelas relacionadas a cursos!
-- ============================================

-- Opção 1: Deletar usando CASCADE (mais simples, aproveita as foreign keys)
-- Como as foreign keys têm ON DELETE CASCADE, deletar de courses remove tudo automaticamente
DELETE FROM `courses`;

-- Opção 2: Deletar explicitamente cada tabela (mais seguro e explícito)
-- Desabilita verificação de foreign keys temporariamente
SET FOREIGN_KEY_CHECKS = 0;

-- Deleta na ordem: tabelas dependentes primeiro, depois as principais
DELETE FROM `materials`;
DELETE FROM `user_lesson_progress`;
DELETE FROM `lessons`;
DELETE FROM `modules`;
DELETE FROM `courses`;

-- Reabilita verificação de foreign keys
SET FOREIGN_KEY_CHECKS = 1;

-- ============================================
-- Opção 3: TRUNCATE (mais rápido, reseta AUTO_INCREMENT se houver)
-- ATENÇÃO: TRUNCATE não funciona com foreign keys ativas
-- ============================================
/*
SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE `materials`;
TRUNCATE TABLE `user_lesson_progress`;
TRUNCATE TABLE `lessons`;
TRUNCATE TABLE `modules`;
TRUNCATE TABLE `courses`;

SET FOREIGN_KEY_CHECKS = 1;
*/

-- ============================================
-- Opção 4: Deletar apenas dados de teste/específicos
-- ============================================
/*
-- Deletar apenas cursos específicos (exemplo)
DELETE FROM `courses` WHERE `id` IN ('c1', 'c2', 'c3', 'c4');

-- Ou deletar cursos criados após uma data específica
DELETE FROM `courses` WHERE `created_at` > '2024-01-01';
*/

-- ============================================
-- Verificar se as tabelas estão vazias
-- ============================================
SELECT 
    'materials' AS tabela, COUNT(*) AS registros FROM `materials`
UNION ALL
SELECT 
    'user_lesson_progress' AS tabela, COUNT(*) AS registros FROM `user_lesson_progress`
UNION ALL
SELECT 
    'lessons' AS tabela, COUNT(*) AS registros FROM `lessons`
UNION ALL
SELECT 
    'modules' AS tabela, COUNT(*) AS registros FROM `modules`
UNION ALL
SELECT 
    'courses' AS tabela, COUNT(*) AS registros FROM `courses`;


