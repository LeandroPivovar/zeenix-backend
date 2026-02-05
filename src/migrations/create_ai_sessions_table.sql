CREATE TABLE IF NOT EXISTS ai_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    ai_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active', -- active, stopped, error
    total_trades INT DEFAULT 0,
    total_wins INT DEFAULT 0,
    total_losses INT DEFAULT 0,
    total_profit DECIMAL(10, 2) DEFAULT 0.00,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status)
);
