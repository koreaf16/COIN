UPDATE z4_positions 
SET status = 'CLOSED', 
    exit_time = SYSTIMESTAMP,
    exit_reason = 'ORPHANED', 
    exit_price = entry_price, 
    pnl_amount = 0, 
    pnl_pct = 0
WHERE id = :id
