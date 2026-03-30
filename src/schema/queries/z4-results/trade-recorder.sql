-- name: get_pending_captures
SELECT id, symbol, entry_time, exit_time, candle_data
FROM z4_positions
WHERE status = 'CLOSED'
  AND candle_post_exit = 0
  AND exit_time < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '70' SECOND
FETCH FIRST 10 ROWS ONLY

-- name: update_candle_post_exit
UPDATE z4_positions SET candle_data = :data, candle_post_exit = 1 WHERE id = :id

-- name: insert_position_entry
INSERT INTO z4_positions
(id, symbol, direction, entry_price, qty, target_price, safety_stop, time_stop_min, entry_time, entry_reasoning, plan_id, status, candle_post_exit)
VALUES (:id, :sym, :dir, :price, :qty, :target, :safety, :tsMin, :ts, :reasoning, :planId, 'OPEN', 0)

-- name: insert_trade_log
INSERT INTO z4_trade_log (position_id, action, symbol, side, price, qty, fee_amount, fee_rate)
VALUES (:posId, :action, :sym, :side, :price, :qty, :fee, :feeRate)

-- name: update_position_partial_exit
UPDATE z4_positions SET
  pnl_pct = COALESCE(:pnlPct, pnl_pct),
  pnl_amount = COALESCE(:pnlNet, pnl_amount),
  safety_stop = COALESCE(:safety, safety_stop)
WHERE id = :id
  AND status = 'OPEN'

-- name: update_position_exit
UPDATE z4_positions SET
  exit_price = :exitPrice,
  exit_time = SYSTIMESTAMP,
  exit_reason = :reason,
  exit_details = :details,
  pnl_pct = :pnlPct,
  pnl_amount = :pnlNet,
  status = 'CLOSED',
  candle_data = :candleData,
  candle_post_exit = 0
WHERE id = :id
