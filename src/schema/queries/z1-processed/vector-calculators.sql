-- name: getVolatilityCandles
SELECT high_price, low_price, close_price FROM (
  SELECT high_price, low_price, close_price, ts FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '4h'
  ORDER BY ts DESC FETCH FIRST 31 ROWS ONLY
) ORDER BY ts ASC

-- name: getPriceForOI
SELECT close_price FROM (
  SELECT close_price, ts FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '1h'
  ORDER BY ts DESC FETCH FIRST 2 ROWS ONLY
) ORDER BY ts ASC

-- name: getOIDerivatives
SELECT oi_change_pct FROM z0_derivatives
WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getTrendCandles
SELECT close_price FROM (
  SELECT close_price FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = :tf
  ORDER BY ts DESC FETCH FIRST 26 ROWS ONLY
) ORDER BY ROWNUM

-- name: getFundingStats
SELECT AVG(funding_rate), STDDEV(funding_rate)
FROM z0_derivatives
WHERE symbol = :sym
  AND funding_rate IS NOT NULL
  AND ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '30' DAY

-- name: getCurrentFunding
SELECT funding_rate FROM z0_derivatives
WHERE symbol = :sym AND funding_rate IS NOT NULL
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getCVD
SELECT cvd FROM (
  SELECT cvd FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '1h' AND cvd IS NOT NULL
  ORDER BY ts DESC FETCH FIRST 2 ROWS ONLY
) ORDER BY ROWNUM

-- name: getLatestPrice
SELECT close_price FROM z0_price_ohlcv
WHERE symbol = :sym AND timeframe = '1m'
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getLiquidationMap
SELECT
  SUM(CASE WHEN price_level > :price THEN short_liq_usd ELSE 0 END) AS above,
  SUM(CASE WHEN price_level < :price THEN long_liq_usd ELSE 0 END) AS below
FROM z1_liquidation_map
WHERE symbol = :sym
  AND ts = (SELECT MAX(ts) FROM z1_liquidation_map WHERE symbol = :sym)
