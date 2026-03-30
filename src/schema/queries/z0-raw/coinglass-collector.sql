-- name: deleteRecentLiquidationMap
DELETE FROM z1_liquidation_map 
WHERE symbol = :sym AND ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '1' HOUR

-- name: insertLiquidationMap
INSERT INTO z1_liquidation_map (symbol, ts, price_level, long_liq_usd, short_liq_usd)
VALUES (:sym, SYSTIMESTAMP, :price, :longLiq, :shortLiq)

-- name: mergeAggregatedDerivatives
MERGE INTO z0_derivatives d
USING (SELECT :sym AS symbol, SYSTIMESTAMP AS ts FROM dual) s
ON (d.symbol = s.symbol AND d.ts = s.ts)
WHEN NOT MATCHED THEN 
  INSERT (symbol, ts, open_interest, funding_rate)
  VALUES (:sym, SYSTIMESTAMP, :oi, :funding)
