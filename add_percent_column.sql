-- Add percent column to master_trader_operations table
ALTER TABLE `master_trader_operations` ADD COLUMN `percent` DECIMAL(5, 2) NULL AFTER `stake`;
