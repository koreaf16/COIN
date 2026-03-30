-- name: markPositionError
UPDATE z4_positions 
SET exit_reason = 'CLOSE_FAILED', status = 'ERROR' 
WHERE id = :id AND status = 'OPEN'

-- name: markPlanFailed
UPDATE z2_execution_plan 
SET status = 'FAILED' 
WHERE id = :id

-- name: getLatestOiMatrix
SELECT price_dir, oi_dir 
FROM z1_oi_matrix 
WHERE symbol = :sym 
ORDER BY ts DESC 
FETCH FIRST 1 ROW ONLY

-- name: getStalePositions
SELECT id, symbol, direction, entry_price, entry_time, time_stop_min
FROM z4_positions
WHERE status = 'OPEN'
  AND entry_time + NUMTODSINTERVAL(time_stop_min + 10, 'MINUTE') < CAST(SYSTIMESTAMP AS TIMESTAMP)

-- name: closeStalePosition
UPDATE z4_positions 
SET status = 'CLOSED', exit_time = SYSTIMESTAMP,
    exit_reason = 'STALE_CLEANUP', exit_price = entry_price,
    pnl_pct = NVL(pnl_pct, 0), pnl_amount = NVL(pnl_amount, 0)
WHERE id = :id

-- name: markStaleCloseFailed
UPDATE z4_positions 
SET exit_reason = 'STALE_CLOSE_FAILED' 
WHERE id = :id

-- name: getRecentErrorPositions
SELECT id, symbol, direction, entry_price
FROM z4_positions
WHERE status = 'ERROR'
  AND exit_time > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '1' HOUR

-- name: closeErrorRetrySuccess
UPDATE z4_positions 
SET status = 'CLOSED', exit_time = SYSTIMESTAMP,
    exit_reason = 'ERROR_RETRY_SUCCESS'
WHERE id = :id

-- name: markManualReview
UPDATE z4_positions 
SET status = 'MANUAL_REVIEW',
    exit_reason = 'RETRY_FAILED: ' || :reason
WHERE id = :id

-- name: getOpenPositions
SELECT p.id, p.symbol, p.direction, p.entry_price, p.qty, p.target_price, p.safety_stop, p.time_stop_min,
       p.entry_time, p.plan_id, p.entry_reasoning, p.pnl_amount,
       NVL((SELECT SUM(t.fee_amount)
             FROM z4_trade_log t
            WHERE t.position_id = p.id
              AND t.action = 'PARTIAL_EXIT'), 0) AS realized_fee_total,
       NVL((SELECT COUNT(*)
             FROM z4_trade_log t
            WHERE t.position_id = p.id
              AND t.action = 'PARTIAL_EXIT'), 0) AS partial_exit_count
FROM z4_positions p
WHERE p.status = 'OPEN'

-- name: markOrphanedClosed
UPDATE z4_positions 
SET status = 'CLOSED', exit_time = SYSTIMESTAMP,
    exit_reason = 'ORPHANED', exit_price = entry_price,
    pnl_amount = NVL(pnl_amount, 0), pnl_pct = NVL(pnl_pct, 0)
WHERE id = :id
