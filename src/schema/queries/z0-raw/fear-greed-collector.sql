-- name: mergeFearGreed
MERGE INTO z0_fear_greed f
USING (SELECT TRUNC(SYSTIMESTAMP, 'HH') AS ts FROM dual) s
ON (f.ts = s.ts)
WHEN NOT MATCHED THEN 
  INSERT (ts, value, classification) 
  VALUES (SYSTIMESTAMP, :val, :cls)
WHEN MATCHED THEN 
  UPDATE SET value = :val, classification = :cls
