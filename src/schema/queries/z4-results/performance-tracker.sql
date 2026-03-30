-- name: get_daily_performance
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) AS losses,
  SUM(pnl_amount) AS total_pnl,
  AVG(CASE WHEN pnl_pct > 0 THEN pnl_pct END) AS avg_win,
  AVG(CASE WHEN pnl_pct <= 0 THEN pnl_pct END) AS avg_loss,
  CASE WHEN SUM(CASE WHEN pnl_amount < 0 THEN ABS(pnl_amount) END) > 0
       THEN SUM(CASE WHEN pnl_amount > 0 THEN pnl_amount END)
            / SUM(CASE WHEN pnl_amount < 0 THEN ABS(pnl_amount) END)
       ELSE NULL END AS profit_factor,
  CASE WHEN STDDEV(pnl_pct) > 0
       THEN AVG(pnl_pct) / STDDEV(pnl_pct)
       ELSE NULL END AS sharpe_ratio
FROM z4_positions
WHERE status = 'CLOSED'
  AND pnl_amount IS NOT NULL
  AND TRUNC(
        CAST(
          FROM_TZ(CAST(exit_time AS TIMESTAMP), 'UTC')
          AT TIME ZONE 'America/New_York'
        AS DATE)
      ) = TO_DATE(:today, 'YYYY-MM-DD')

-- name: merge_performance
MERGE INTO z4_performance p
USING (SELECT 'DAILY' AS pt, TO_DATE(:today, 'YYYY-MM-DD') AS ps FROM dual) s
ON (p.period_type = s.pt AND p.period_start = s.ps)
WHEN MATCHED THEN UPDATE SET
  total_trades = :total, winning_trades = :wins, losing_trades = :losses,
  win_rate = :wr, total_pnl = :pnl, avg_win_pct = :avgW, avg_loss_pct = :avgL,
  profit_factor = :pf, sharpe_ratio = :sr
WHEN NOT MATCHED THEN INSERT
  (period_type, period_start, total_trades, winning_trades, losing_trades,
   win_rate, total_pnl, avg_win_pct, avg_loss_pct, profit_factor, sharpe_ratio)
  VALUES ('DAILY', TO_DATE(:today, 'YYYY-MM-DD'),
          :total, :wins, :losses, :wr, :pnl, :avgW, :avgL, :pf, :sr)
