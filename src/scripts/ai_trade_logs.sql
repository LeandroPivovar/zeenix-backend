CREATE TABLE IF NOT EXISTS ai_trade_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ai_sessions_id INT NOT NULL,
    invested_value DECIMAL(10, 2) NOT NULL,
    returned_value DECIMAL(10, 2) NOT NULL,
    result VARCHAR(50) NOT NULL, -- 'WON', 'LOST'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ai_sessions_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);
