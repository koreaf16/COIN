-- name: getMarketOhlcv
SELECT close_price, volume FROM z0_price_ohlcv
WHERE symbol = :sym AND timeframe = '1m' ORDER BY ts DESC FETCH FIRST 6 ROWS ONLY

-- name: getDerivatives
SELECT open_interest, oi_change_pct, funding_rate, predicted_rate,
       long_ratio, short_ratio, liq_long_24h, liq_short_24h
FROM z0_derivatives WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getCvd1h
SELECT (buy_volume - sell_volume) as net_vol, volume FROM z0_price_ohlcv WHERE symbol = :sym AND timeframe = '1h'
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getOnchain
SELECT mpi, stablecoin_supply, whale_ratio FROM z0_onchain
WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: get4hCandles
SELECT high_price, low_price, close_price FROM (
  SELECT high_price, low_price, close_price FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '4h'
  ORDER BY ts DESC FETCH FIRST 20 ROWS ONLY
)

-- name: get1hCandles
SELECT close_price FROM (
  SELECT close_price FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '1h'
  ORDER BY ts DESC FETCH FIRST 15 ROWS ONLY
)

-- name: get1hCandlesFull
SELECT open_price, high_price, low_price, close_price, volume FROM (
  SELECT open_price, high_price, low_price, close_price, volume FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '1h'
  ORDER BY ts DESC FETCH FIRST 120 ROWS ONLY
)

-- name: get4hCandlesFull
SELECT open_price, high_price, low_price, close_price, volume FROM (
  SELECT open_price, high_price, low_price, close_price, volume FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '4h'
  ORDER BY ts DESC FETCH FIRST 120 ROWS ONLY
)

-- name: get1dCandlesFull
SELECT open_price, high_price, low_price, close_price, volume FROM (
  SELECT open_price, high_price, low_price, close_price, volume FROM z0_price_ohlcv
  WHERE symbol = :sym AND timeframe = '1d'
  ORDER BY ts DESC FETCH FIRST 90 ROWS ONLY
)

-- name: getBtcOhlcv
SELECT close_price FROM (
  SELECT close_price FROM z0_price_ohlcv
  WHERE symbol = 'BTCUSDT' AND timeframe = '1h'
  ORDER BY ts DESC FETCH FIRST 3 ROWS ONLY
)

-- name: getVolatilityRegime
SELECT regime, atr_14, bb_width FROM z1_volatility_regime
WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getMarketState
SELECT volatility_acceleration FROM z1_market_states
WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getOiMatrix
SELECT price_dir, oi_dir, interpretation FROM z1_oi_matrix
WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getMacroData
SELECT indicator, value FROM (
  SELECT indicator, value, ROW_NUMBER() OVER (PARTITION BY indicator ORDER BY ts DESC) rn
  FROM z0_macro_data WHERE indicator IN ('DXY','VIX','US10Y','NQ_FUTURE','COINBASE_PREMIUM')
) WHERE rn = 1

-- name: getLiquidationMap
SELECT price_level, long_liq_usd, short_liq_usd FROM z1_liquidation_map
WHERE symbol = :sym AND ts = (SELECT MAX(ts) FROM z1_liquidation_map WHERE symbol = :sym)
ORDER BY (long_liq_usd + short_liq_usd) DESC FETCH FIRST 5 ROWS ONLY

-- name: getLatestVector
SELECT state_vector
FROM z1_market_states
WHERE symbol = :sym
ORDER BY ts DESC
FETCH FIRST 1 ROW ONLY

-- name: getSimilarStates
SELECT m.ts, m.next_1h_return, m.next_4h_return, m.next_24h_return,
       VECTOR_DISTANCE(m.state_vector, :vec, COSINE) AS similarity
FROM z1_market_states m
WHERE m.symbol = :sym
  AND m.ts < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '2' HOUR
  AND VECTOR_DISTANCE(m.state_vector, :vec, COSINE) < 0.4
ORDER BY similarity
FETCH FIRST :lim ROWS ONLY

-- name: countStateVectors
SELECT COUNT(*) FROM z1_market_states
WHERE symbol = :sym AND state_vector IS NOT NULL

-- name: getRecentAnalysis
SELECT result FROM z2_llm_analysis
WHERE symbol = :sym AND analysis_type = :atype
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getRecentSentiment
SELECT result FROM z2_llm_analysis
WHERE analysis_type = 'sentiment'
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getRecentEventsBySymbol
SELECT ts, result FROM z2_llm_analysis
WHERE symbol = :sym AND analysis_type = 'event'
ORDER BY ts DESC FETCH FIRST :limit ROWS ONLY

-- name: getActivePlans
SELECT id, direction, target_price, confidence FROM z2_execution_plan
WHERE symbol = :sym AND status = 'ACTIVE' AND valid_until > CAST(SYSTIMESTAMP AS TIMESTAMP)
ORDER BY created_at DESC

-- name: getRecentLosses
SELECT direction, entry_price, exit_price, pnl_pct, exit_reason, entry_reasoning
FROM z4_positions WHERE symbol = :sym AND pnl_pct < -0.5
ORDER BY entry_time DESC FETCH FIRST :limit ROWS ONLY
