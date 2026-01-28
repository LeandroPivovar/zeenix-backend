CREATE TABLE IF NOT EXISTS market_contracts (
  id SERIAL PRIMARY KEY,
  market_symbol VARCHAR(50) NOT NULL,
  contract_type VARCHAR(50) NOT NULL,
  contract_category VARCHAR(50),
  contract_display VARCHAR(100),
  min_contract_duration VARCHAR(20),
  max_contract_duration VARCHAR(20),
  sentiment VARCHAR(20),
  barriers INTEGER,
  exchange_name VARCHAR(50),
  market VARCHAR(50),
  submarket VARCHAR(50),
  payload JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_market_symbol
      FOREIGN KEY(market_symbol) 
      REFERENCES markets(symbol)
      ON DELETE CASCADE
);

CREATE INDEX idx_market_contracts_symbol ON market_contracts(market_symbol);
