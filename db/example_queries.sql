-- Exemplos de consultas SQL usando os nomes corretos das colunas (snake_case)
-- Use estas consultas como referência ao consultar o banco manualmente

-- ============================================
-- CONSULTAS PARA A TABELA courses
-- ============================================

-- Selecionar todos os cursos
SELECT `id`, `title`, `description`, `image_placeholder`, `total_lessons`, `total_duration`, `created_at`, `updated_at` 
FROM `courses`;

-- Selecionar um curso específico
SELECT `id`, `title`, `description`, `image_placeholder`, `total_lessons`, `total_duration`, `created_at`, `updated_at` 
FROM `courses` 
WHERE `id` = '00000000-0000-0000-0000-000000000001';

-- ============================================
-- CONSULTAS PARA A TABELA modules
-- ============================================

-- Selecionar todos os módulos
SELECT `id`, `course_id`, `title`, `order_index`, `created_at`, `updated_at` 
FROM `modules`;

-- Selecionar módulos de um curso específico
SELECT `id`, `course_id`, `title`, `order_index`, `created_at`, `updated_at` 
FROM `modules` 
WHERE `course_id` = '00000000-0000-0000-0000-000000000001'
ORDER BY `order_index`;

-- ============================================
-- CONSULTAS PARA A TABELA lessons
-- ============================================

-- Selecionar todas as aulas
SELECT `id`, `course_id`, `module_id`, `title`, `description`, `duration`, `video_url`, `order_index`, `created_at`, `updated_at` 
FROM `lessons`;

-- Selecionar aulas de um curso específico
SELECT `id`, `course_id`, `module_id`, `title`, `description`, `duration`, `video_url`, `order_index`, `created_at`, `updated_at` 
FROM `lessons` 
WHERE `course_id` = '00000000-0000-0000-0000-000000000001'
ORDER BY `order_index`;

-- Selecionar aulas de um módulo específico
SELECT `id`, `course_id`, `module_id`, `title`, `description`, `duration`, `video_url`, `order_index`, `created_at`, `updated_at` 
FROM `lessons` 
WHERE `module_id` = '00000000-0000-0000-0000-000000000011'
ORDER BY `order_index`;

-- ============================================
-- CONSULTAS COM JOIN
-- ============================================

-- Selecionar cursos com suas aulas
SELECT 
    c.`id` as course_id,
    c.`title` as course_title,
    l.`id` as lesson_id,
    l.`title` as lesson_title,
    l.`duration`,
    l.`order_index`
FROM `courses` c
LEFT JOIN `lessons` l ON c.`id` = l.`course_id`
ORDER BY c.`id`, l.`order_index`;

-- Selecionar curso com módulos e aulas
SELECT 
    c.`id` as course_id,
    c.`title` as course_title,
    m.`id` as module_id,
    m.`title` as module_title,
    m.`order_index` as module_order,
    l.`id` as lesson_id,
    l.`title` as lesson_title,
    l.`duration`,
    l.`order_index` as lesson_order
FROM `courses` c
LEFT JOIN `modules` m ON c.`id` = m.`course_id`
LEFT JOIN `lessons` l ON m.`id` = l.`module_id`
WHERE c.`id` = '00000000-0000-0000-0000-000000000001'
ORDER BY m.`order_index`, l.`order_index`;

