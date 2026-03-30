-- name: getKlines
SELECT ts, open_price, high_price, low_price, close_price, volume, trade_count, cvd
FROM z0_price_ohlcv
WHERE symbol = :symbol AND timeframe = :tf
ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getDerivatives
SELECT ts, open_interest, oi_change_pct, funding_rate, predicted_rate, long_ratio, short_ratio
FROM z0_derivatives WHERE symbol = :symbol
ORDER BY ts DESC FETCH FIRST 50 ROWS ONLY

-- name: getLlmAnalysis
SELECT id, symbol, ts, analysis_type, llm_source, result, confidence
FROM z2_llm_analysis WHERE symbol = :symbol AND analysis_type = :type
ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getMarketStates
SELECT ts, volatility_regime, trend_strength, funding_zscore,
       oi_change_pct, cvd_direction, macro_regime, sentiment_score,
       liq_asymmetry, next_1h_return, next_4h_return, next_24h_return
FROM z1_market_states WHERE symbol = :symbol
ORDER BY ts DESC FETCH FIRST 50 ROWS ONLY
