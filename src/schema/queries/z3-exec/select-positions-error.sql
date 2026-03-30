SELECT id, symbol, direction, entry_price
FROM z4_positions
WHERE status = 'ERROR'
  AND exit_time > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '1' HOUR
