-- name: checkKlineCount
SELECT COUNT(*) AS cnt
FROM z0_price_ohlcv
WHERE symbol = :sym AND timeframe = :tf

-- name: insertKline
INSERT INTO z0_price_ohlcv
(symbol, timeframe, ts, open_price, high_price, low_price, close_price,
 volume, quote_volume, trade_count, buy_volume, sell_volume)
VALUES (:symbol, :tf, :ts, :open, :high, :low, :close,
        :vol, :qvol, :tc, :bvol, :svol)
