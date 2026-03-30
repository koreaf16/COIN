-- name: markTriggered
UPDATE z2_execution_plan
SET status = 'TRIGGERED', triggered_at = SYSTIMESTAMP
WHERE id = :id AND status = 'ACTIVE'

-- name: expirePlans
UPDATE z2_execution_plan 
SET status = 'EXPIRED'
WHERE status = 'ACTIVE' AND valid_until < CAST(SYSTIMESTAMP AS TIMESTAMP)

-- name: getActivePlans
SELECT id, symbol, direction, entry_conditions, target_price, stop_price,
       stop_conditions, time_stop_min, confidence, reasoning, valid_until
FROM z2_execution_plan
WHERE status = 'ACTIVE' AND valid_until > CAST(SYSTIMESTAMP AS TIMESTAMP)
ORDER BY confidence DESC
