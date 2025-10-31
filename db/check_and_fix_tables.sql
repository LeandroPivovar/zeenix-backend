-- Script para verificar e corrigir problemas nas tabelas
-- Execute este script se encontrar erros de duplicação de chave primária

-- Verificar registros com IDs vazios ou NULL na tabela modules
SELECT * FROM `modules` WHERE `id` IS NULL OR `id` = '';

-- Verificar registros com IDs vazios ou NULL na tabela lessons
SELECT * FROM `lessons` WHERE `id` IS NULL OR `id` = '';

-- Verificar registros com IDs vazios ou NULL na tabela courses
SELECT * FROM `courses` WHERE `id` IS NULL OR `id` = '';

-- Se encontrar registros problemáticos, você pode deletá-los:
-- DELETE FROM `modules` WHERE `id` IS NULL OR `id` = '';
-- DELETE FROM `lessons` WHERE `id` IS NULL OR `id` = '';
-- DELETE FROM `courses` WHERE `id` IS NULL OR `id` = '';

-- Verificar se as tabelas têm a estrutura correta
SHOW CREATE TABLE `modules`;
SHOW CREATE TABLE `lessons`;
SHOW CREATE TABLE `courses`;

