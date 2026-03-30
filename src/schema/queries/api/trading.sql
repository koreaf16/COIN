-- name: getPositions
SELECT p.id, p.symbol, p.direction, p.entry_price, p.entry_time, p.exit_price, p.exit_time,
       p.exit_reason, p.pnl_pct, p.pnl_amount, p.status, p.plan_id,
       (SELECT SUM(fee_amount) FROM z4_trade_log WHERE position_id = p.id) AS fee_amount,
       CASE
         WHEN p.status = 'OPEN' THEN
           NVL((SELECT qty
                  FROM z4_trade_log
                 WHERE position_id = p.id
                   AND action = 'ENTRY'
                 ORDER BY id ASC FETCH FIRST 1 ROW ONLY), 0)
           - NVL((SELECT SUM(qty)
                    FROM z4_trade_log
                   WHERE position_id = p.id
                     AND action = 'PARTIAL_EXIT'), 0)
         ELSE
           (SELECT qty
              FROM z4_trade_log
             WHERE position_id = p.id
               AND action = 'ENTRY'
             ORDER BY id ASC FETCH FIRST 1 ROW ONLY)
       END AS qty
FROM z4_positions p WHERE p.status = :status
ORDER BY COALESCE(p.exit_time, p.entry_time) DESC FETCH FIRST 100 ROWS ONLY

-- name: getPositionCandles
SELECT id, symbol, direction, entry_price, entry_time, exit_price, exit_time,
       target_price, safety_stop, candle_data
FROM z4_positions WHERE id = :id

-- name: getPlans
SELECT id, symbol, created_at, valid_until, direction, entry_conditions,
       target_price, confidence, reasoning, status
FROM z2_execution_plan WHERE status = :status
ORDER BY created_at DESC FETCH FIRST 50 ROWS ONLY

-- name: getPlansActive
SELECT id, symbol, created_at, valid_until, direction, entry_conditions,
       target_price, confidence, reasoning, status
FROM z2_execution_plan WHERE status = :status
AND valid_until > CAST(SYSTIMESTAMP AS TIMESTAMP)
ORDER BY created_at DESC FETCH FIRST 50 ROWS ONLY

-- name: getPlanById
SELECT id, symbol, created_at, valid_until, direction, entry_conditions,
       target_price, stop_price, stop_conditions, time_stop_min,
       confidence, reasoning, scenario_id, status, triggered_at
FROM z2_execution_plan WHERE id = :id

-- name: insertPlan
INSERT INTO z2_execution_plan
(symbol, valid_until, direction, entry_conditions, target_price, stop_price,
 stop_conditions, time_stop_min, confidence, reasoning, status)
VALUES (:sym, SYSTIMESTAMP + INTERVAL '4' HOUR, :dir, :entry, :target, :stopPrice,
        :stop, :ts, :conf, :reason, 'ACTIVE')
RETURNING id INTO :id

-- name: updatePlanStatus
UPDATE z2_execution_plan SET status = :status WHERE id = :id

-- name: deletePlan
DELETE FROM z2_execution_plan WHERE id = :id

-- name: expirePlans
UPDATE z2_execution_plan SET status = 'EXPIRED'
WHERE status = 'ACTIVE' AND valid_until < CAST(SYSTIMESTAMP AS TIMESTAMP)

-- name: getActivePlansForStatus
SELECT id, symbol, direction, entry_conditions, target_price,
       confidence, reasoning, created_at, valid_until
FROM z2_execution_plan
WHERE status = 'ACTIVE' AND valid_until > CAST(SYSTIMESTAMP AS TIMESTAMP)
ORDER BY valid_until DESC FETCH FIRST 100 ROWS ONLY
