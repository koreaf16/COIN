-- name: insertKline
INSERT INTO z0_price_ohlcv
(symbol, timeframe, ts, open_price, high_price, low_price, close_price,
 volume, quote_volume, trade_count, buy_volume, sell_volume)
VALUES (:symbol, :tf, :ts, :open, :high, :low, :close,
        :vol, :qvol, :tc, :bvol, :svol)

-- name: insertLiquidation
INSERT INTO z0_liquidation_raw (symbol, ts, side, price, qty, usd_value)
VALUES (:symbol, :ts, :side, :price, :qty, :usd)
