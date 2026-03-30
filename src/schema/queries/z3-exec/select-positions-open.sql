SELECT id, symbol, direction, entry_price, target_price, safety_stop, time_stop_min, entry_time, plan_id, entry_reasoning
FROM z4_positions 
WHERE status = 'OPEN'
