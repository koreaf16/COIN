-- name: getLatestIndicators
SELECT indicator, value 
FROM (
  SELECT indicator, value, ROW_NUMBER() OVER (PARTITION BY indicator ORDER BY ts DESC) as rn
  FROM z0_macro_data
) 
WHERE rn = 1

-- name: insertMacroData
INSERT INTO z0_macro_data (indicator, ts, value, source)
VALUES (:ind, SYSTIMESTAMP, :val, :src)
