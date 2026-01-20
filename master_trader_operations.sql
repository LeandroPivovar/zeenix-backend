CREATE TABLE `master_trader_operations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `trader_id` CHAR(36) NOT NULL,
  `symbol` VARCHAR(50) NOT NULL,
  `contract_type` VARCHAR(50) NOT NULL,
  `stake` DECIMAL(15, 2) NOT NULL,
  `multiplier` INT NULL,
  `duration` INT NOT NULL,
  `duration_unit` VARCHAR(10) NOT NULL,
  `trade_type` VARCHAR(50) NOT NULL,
  `status` VARCHAR(20) DEFAULT 'pending',
  `result` VARCHAR(20) NULL,
  `profit` DECIMAL(15, 2) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`trader_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
