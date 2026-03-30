UPDATE z4_positions 
SET exit_reason = 'CLOSE_FAILED', status = 'ERROR' 
WHERE id = :id AND status = 'OPEN'
