UPDATE z4_positions 
SET status = 'CLOSED', 
    exit_time = SYSTIMESTAMP,
    exit_reason = 'STALE_CLEANUP', 
    exit_price = entry_price, 
    pnl_pct = 0, 
    pnl_amount = 0
WHERE id = :id
