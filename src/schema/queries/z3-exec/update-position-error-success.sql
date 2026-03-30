UPDATE z4_positions 
SET status = 'CLOSED', 
    exit_time = SYSTIMESTAMP,
    exit_reason = 'ERROR_RETRY_SUCCESS'
WHERE id = :id
