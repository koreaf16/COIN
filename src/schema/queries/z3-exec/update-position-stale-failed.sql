UPDATE z4_positions 
SET exit_reason = 'STALE_CLOSE_FAILED' 
WHERE id = :id
