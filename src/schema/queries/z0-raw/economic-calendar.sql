-- name: mergeEconomicEvent
MERGE INTO z0_economic_calendar c
USING (SELECT :name AS event_name, TO_TIMESTAMP(:dt, 'YYYY-MM-DD"T"HH24:MI:SS') AS event_date FROM dual) s
ON (c.event_name = s.event_name AND c.event_date = s.event_date)
WHEN NOT MATCHED THEN 
  INSERT (event_date, event_name, country, importance, previous, forecast, actual)
  VALUES (s.event_date, :name, :country, :imp, :prev, :fore, :act)
WHEN MATCHED THEN 
  UPDATE SET actual = :act
