-- Upgrade script to allow large Base64 images for course cover and social sharing
-- Run this after deploying the code that expects LONGTEXT columns

ALTER TABLE `courses`
MODIFY COLUMN `social_image` LONGTEXT NULL,
MODIFY COLUMN `cover_image` LONGTEXT NULL;


