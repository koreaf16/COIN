UPDATE z4_positions 
SET status = 'MANUAL_REVIEW',
    exit_reason = 'RETRY_FAILED: ' || :reason
WHERE id = :id
