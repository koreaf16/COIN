-- name: getLiquidationSum
SELECT 
  SUM(CASE WHEN side = 'SELL' THEN usd_value ELSE 0 END) as long_liq,
  SUM(CASE WHEN side = 'BUY' THEN usd_value ELSE 0 END) as short_liq
FROM z0_liquidation_raw 
WHERE symbol = :sym AND ts > SYSTIMESTAMP - INTERVAL '1' DAY

-- name: getPrevDerivatives
SELECT open_interest, funding_rate, long_ratio, short_ratio FROM z0_derivatives
WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: mergeDerivativesOI
MERGE INTO z0_derivatives d
USING (SELECT :sym AS symbol, :ts AS ts FROM dual) s
ON (d.symbol = s.symbol AND d.ts = s.ts)
WHEN MATCHED THEN 
  UPDATE SET open_interest = :oi, oi_change_pct = :chg, 
             liq_long_24h = :ll, liq_short_24h = :ls
WHEN NOT MATCHED THEN 
  INSERT (symbol, ts, open_interest, oi_change_pct, funding_rate, long_ratio, short_ratio, liq_long_24h, liq_short_24h)
  VALUES (:sym, :ts, :oi, :chg, :fr, :lr, :sr, :ll, :ls)

-- name: updateLongShortRatio
UPDATE z0_derivatives SET long_ratio = :lr, short_ratio = :sr
WHERE symbol = :sym AND ts = (SELECT MAX(ts) FROM z0_derivatives WHERE symbol = :sym)

-- name: updateFundingRates
UPDATE z0_derivatives SET predicted_rate = :pr, funding_rate = :fr
WHERE symbol = :sym AND ts = (SELECT MAX(ts) FROM z0_derivatives WHERE symbol = :sym)
