SELECT id, symbol, direction, entry_price, entry_time, time_stop_min
FROM z4_positions
WHERE status = 'OPEN'
  AND entry_time + NUMTODSINTERVAL(time_stop_min + 10, 'MINUTE') < CAST(SYSTIMESTAMP AS TIMESTAMP)
