-- name: extendPlan
UPDATE z2_execution_plan
SET valid_until = SYSTIMESTAMP + NUMTODSINTERVAL(:validMin, 'MINUTE')
WHERE symbol = :sym AND status = 'ACTIVE'
  AND created_at > SYSTIMESTAMP - NUMTODSINTERVAL(12, 'HOUR')

-- name: expireActivePlan
UPDATE z2_execution_plan 
SET status = 'EXPIRED'
WHERE symbol = :sym AND status = 'ACTIVE'

-- name: insertPlan
INSERT INTO z2_execution_plan
(symbol, valid_until, direction, entry_conditions, target_price, stop_price,
  stop_conditions, time_stop_min, confidence, reasoning, scenario_id, status)
VALUES (:sym, SYSTIMESTAMP + NUMTODSINTERVAL(:validMin, 'MINUTE'), :dir, :entry, :target, :stopPrice,
        :stop, :timeStop, :conf, :reasoning, :scenId, 'ACTIVE')

-- name: insertAnalysis
INSERT INTO z2_llm_analysis (symbol, ts, analysis_type, llm_source, result, confidence, embedding)
VALUES (:sym, SYSTIMESTAMP, :type, :src, :result, :conf, :emb)
