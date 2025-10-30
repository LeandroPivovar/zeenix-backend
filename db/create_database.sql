-- Criação do banco de dados e tabela de usuários para MySQL
-- Ajuste o nome do banco conforme necessário antes de executar

CREATE DATABASE IF NOT EXISTS `zeenix` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `zeenix`;

-- Tabela de usuários compatível com TypeORM Entity `users`
CREATE TABLE IF NOT EXISTS `users` (
  `id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `IDX_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


