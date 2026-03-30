-- name: getOiMatrix
SELECT price_dir, oi_dir FROM z1_oi_matrix 
WHERE symbol = :sym 
ORDER BY ts DESC 
FETCH FIRST 1 ROW ONLY

-- name: getMarketState
SELECT volatility_acceleration FROM z1_market_states 
WHERE symbol = :sym 
ORDER BY ts DESC 
FETCH FIRST 1 ROW ONLY
