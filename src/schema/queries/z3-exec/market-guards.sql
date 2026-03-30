-- name: getRecentCandles
SELECT close_price, open_price FROM (
  SELECT close_price, open_price FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '1h'
  ORDER BY ts DESC FETCH FIRST 6 ROWS ONLY
)

-- name: getBtcClose
SELECT close_price FROM (
  SELECT close_price FROM z0_price_ohlcv
  WHERE symbol = 'BTCUSDT' AND timeframe = '1h'
  ORDER BY ts DESC FETCH FIRST 1 ROW ONLY
)
