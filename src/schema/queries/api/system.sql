-- name: getPerformance
SELECT period_type, period_start, total_trades, winning_trades, losing_trades,
       win_rate, total_pnl, avg_win_pct, avg_loss_pct, profit_factor, sharpe_ratio
FROM z4_performance ORDER BY period_start DESC FETCH FIRST 30 ROWS ONLY

-- name: getLatestMacro
SELECT value, ts FROM z0_macro_data WHERE indicator = :ind
ORDER BY ts DESC FETCH FIRST 1 ROW ONLY

-- name: getEconomicCalendar
SELECT id, event_date, event_name, importance, previous, forecast, actual
FROM z0_economic_calendar WHERE event_date > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '1' DAY
ORDER BY event_date ASC FETCH FIRST 20 ROWS ONLY

-- name: getFearGreed
SELECT ts, value, classification FROM z0_fear_greed ORDER BY ts DESC FETCH FIRST 10 ROWS ONLY

-- name: getStablecoinSupply
SELECT ts, usdt_mcap, usdc_mcap, total_mcap, usdt_change_24h, usdc_change_24h FROM z0_stablecoin_supply ORDER BY ts DESC FETCH FIRST 10 ROWS ONLY

-- name: getSettings
SELECT key, value, description FROM sys_config ORDER BY key

-- name: updateSetting
UPDATE sys_config SET value = :val, updated_at = SYSTIMESTAMP WHERE key = :key

-- name: getZ0SummaryOhlcv
SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_price_ohlcv

-- name: getZ0SummaryDerivatives
SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_derivatives

-- name: getZ0SummaryLiquidations
SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_liquidation_raw

-- name: getZ0SummaryMacro
SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_macro_data

-- name: getZ0SummaryNews
SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_news_raw

-- name: getZ0RecentOhlcv
SELECT symbol, timeframe, ts, open_price, high_price, low_price, close_price, volume, trade_count, buy_volume, sell_volume, cvd
FROM z0_price_ohlcv ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentOhlcvBySymbol
SELECT symbol, timeframe, ts, open_price, high_price, low_price, close_price, volume, trade_count, buy_volume, sell_volume, cvd
FROM z0_price_ohlcv WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentDerivatives
SELECT symbol, ts, open_interest, oi_change_pct, funding_rate, predicted_rate, long_ratio, short_ratio, liq_long_24h, liq_short_24h
FROM z0_derivatives ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentDerivativesBySymbol
SELECT symbol, ts, open_interest, oi_change_pct, funding_rate, predicted_rate, long_ratio, short_ratio, liq_long_24h, liq_short_24h
FROM z0_derivatives WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentLiquidations
SELECT symbol, ts, side, price, qty, usd_value
FROM z0_liquidation_raw ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentLiquidationsBySymbol
SELECT symbol, ts, side, price, qty, usd_value
FROM z0_liquidation_raw WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentMacro
SELECT indicator, ts, value, source FROM z0_macro_data ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ0RecentNews
SELECT ts, source, title, tickers, url FROM z0_news_raw ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ2RecentLlmAnalysis
SELECT id, symbol, ts, analysis_type, llm_source, confidence, latency_ms, token_count
FROM z2_llm_analysis ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ2RecentLlmAnalysisByType
SELECT id, symbol, ts, analysis_type, llm_source, confidence, latency_ms, token_count
FROM z2_llm_analysis WHERE analysis_type = :type ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY

-- name: getZ2LlmAnalysisDetail
SELECT id, symbol, ts, analysis_type, llm_source, result, confidence, latency_ms, token_count
FROM z2_llm_analysis WHERE id = :id
