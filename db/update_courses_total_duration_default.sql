-- Ajuste para garantir valor padrão em total_duration
ALTER TABLE `courses`
MODIFY COLUMN `total_duration` VARCHAR(20) NOT NULL DEFAULT '0 min';


