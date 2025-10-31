-- Script para adicionar colunas faltantes (executar apenas se necessário)
-- Ignore erros de "coluna já existe" se as colunas já estiverem presentes

ALTER TABLE `courses` 
  ADD COLUMN `image_placeholder` varchar(100) DEFAULT NULL;

ALTER TABLE `courses` 
  ADD COLUMN `total_lessons` int NOT NULL DEFAULT 0;

ALTER TABLE `courses` 
  ADD COLUMN `total_duration` varchar(20) NOT NULL DEFAULT '';

