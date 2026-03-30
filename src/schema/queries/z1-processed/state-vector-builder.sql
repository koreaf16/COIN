-- name: insertMarketState
INSERT INTO z1_market_states
  (symbol, ts, state_vector, volatility_regime, trend_strength,
   funding_zscore, oi_change_pct, cvd_direction, macro_regime,
   sentiment_score, exchange_netflow, liq_asymmetry, volatility_acceleration)
VALUES (:symbol, SYSTIMESTAMP, :vec, :volReg, :trend, :fzs, :oiChg, :cvd, :macro, :sent, :netflow, :liqAsym, :volAcc)

-- name: saveVolatilityRegime
INSERT INTO z1_volatility_regime (symbol, ts, regime, atr_14, bb_width)
VALUES (:sym, SYSTIMESTAMP, :reg, :atr, :bbw)

-- name: saveOIMatrix
INSERT INTO z1_oi_matrix (symbol, ts, price_dir, oi_dir, interpretation)
VALUES (:sym, SYSTIMESTAMP, :pd, :od, :interp)

-- name: getOIChange
SELECT oi_change_pct FROM z0_derivatives
WHERE symbol = :sym AND oi_change_pct IS NOT NULL
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getSentimentScore
SELECT j.result.sentiment FROM z2_llm_analysis j
WHERE j.analysis_type = 'sentiment'
ORDER BY j.ts DESC FETCH FIRST 1 ROW ONLY

-- name: getExchangeNetflow
SELECT net_flow FROM z0_onchain WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: findBackfillTargets
SELECT ROWID, symbol, ts FROM z1_market_states
WHERE (next_1h_return IS NULL AND ts < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '1' HOUR)
   OR (next_4h_return IS NULL AND ts < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '4' HOUR)
   OR (next_24h_return IS NULL AND ts < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '24' HOUR)
ORDER BY ts ASC FETCH FIRST 200 ROWS ONLY

-- name: getPriceForReturn
SELECT close_price FROM z0_price_ohlcv WHERE symbol = :sym AND timeframe = '1h' AND ts >= :ts ORDER BY ts ASC FETCH FIRST 1 ROW ONLY

-- name: findSimilarStates
SELECT ts, next_1h_return, next_4h_return, next_24h_return, VECTOR_DISTANCE(state_vector, :vec, COSINE) AS similarity
FROM z1_market_states WHERE symbol = :sym AND VECTOR_DISTANCE(state_vector, :vec, COSINE) < 0.3
ORDER BY similarity FETCH FIRST :k ROWS ONLY

-- name: updateMarketStateReturns
UPDATE z1_market_states
SET next_1h_return = COALESCE(:r1h, next_1h_return),
    next_4h_return = COALESCE(:r4h, next_4h_return),
    next_24h_return = COALESCE(:r24h, next_24h_return)
WHERE ROWID = :rid
