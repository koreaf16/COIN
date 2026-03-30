-- name: insertLogicCheck
INSERT INTO z3_logic_checks
(position_id, ts, check_result, valid_count, invalid_count, recommendation)
VALUES (:posId, SYSTIMESTAMP, :result, :validCount, :invalidCount, :recommendation)
