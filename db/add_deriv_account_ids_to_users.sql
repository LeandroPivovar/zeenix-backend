ALTER TABLE users
ADD COLUMN id_real_account VARCHAR(50) NULL DEFAULT NULL AFTER token_real_currency,
ADD COLUMN id_demo_account VARCHAR(50) NULL DEFAULT NULL AFTER id_real_account;
