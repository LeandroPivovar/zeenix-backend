-- Adicionar colunas para payout real e bid_price do contrato
ALTER TABLE ai_trades 
ADD COLUMN payout DECIMAL(10, 2) COMMENT 'Payout real do contrato (retorno se ganhar)' AFTER stake_amount,
ADD COLUMN bid_price DECIMAL(10, 2) COMMENT 'Valor atual do contrato (atualizado em tempo real)' AFTER payout,
ADD COLUMN ask_price DECIMAL(10, 2) COMMENT 'Preço de compra/venda do contrato' AFTER bid_price;

