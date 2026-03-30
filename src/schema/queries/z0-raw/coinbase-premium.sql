-- name: insertCoinbasePremium
INSERT INTO z0_macro_data (indicator, ts, value, source)
VALUES ('COINBASE_PREMIUM', SYSTIMESTAMP, :val, 'coinbase-binance')
