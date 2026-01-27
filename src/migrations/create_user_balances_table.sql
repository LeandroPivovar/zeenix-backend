CREATE TABLE `user_balances` (
    `id` varchar(36) NOT NULL,
    `user_id` varchar(36) NOT NULL,
    `demo_balance` decimal(36,18) DEFAULT '0.000000000000000000',
    `real_balance` decimal(36,18) DEFAULT '0.000000000000000000',
    `currency` varchar(10) DEFAULT 'USD',
    `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (`id`),
    KEY `FK_user_balances_user` (`user_id`),
    CONSTRAINT `FK_user_balances_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
