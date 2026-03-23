/**
 * Z4 Performance Tracker — 일간/주간/월간 성과 집계
 */

import { getPool } from '../shared/db.js';
import { todayET } from '../shared/time.js';

export class PerformanceTracker {
  constructor(opts = {}) {
    this.updateIntervalMs = (opts.updateIntervalMin || 60) * 60 * 1000;
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => this._updateDaily(), this.updateIntervalMs);
    // 시작 시 즉시 1회
    setTimeout(() => this._updateDaily(), 5000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _updateDaily() {
    const conn = await getPool().getConnection();
    try {
      const today = todayET();
      const result = await conn.execute(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) AS losses,
           SUM(pnl_amount) AS total_pnl,
           AVG(CASE WHEN pnl_pct > 0 THEN pnl_pct END) AS avg_win,
           AVG(CASE WHEN pnl_pct <= 0 THEN pnl_pct END) AS avg_loss
         FROM z4_positions
         WHERE status = 'CLOSED'
           AND TRUNC(exit_time) = TO_DATE(:today, 'YYYY-MM-DD')`,
        { today }
      );

      const row = result.rows?.[0];
      if (!row || row[0] === 0) return;

      const [total, wins, losses, totalPnl, avgWin, avgLoss] = row;
      const winRate = total > 0 ? (wins / total) * 100 : 0;

      await conn.execute(
        `MERGE INTO z4_performance p
         USING (SELECT 'DAILY' AS pt, TO_DATE(:today, 'YYYY-MM-DD') AS ps FROM dual) s
         ON (p.period_type = s.pt AND p.period_start = s.ps)
         WHEN MATCHED THEN UPDATE SET
           total_trades = :total, winning_trades = :wins, losing_trades = :losses,
           win_rate = :wr, total_pnl = :pnl, avg_win_pct = :avgW, avg_loss_pct = :avgL
         WHEN NOT MATCHED THEN INSERT
           (period_type, period_start, total_trades, winning_trades, losing_trades,
            win_rate, total_pnl, avg_win_pct, avg_loss_pct)
           VALUES ('DAILY', TO_DATE(:today, 'YYYY-MM-DD'),
                   :total, :wins, :losses, :wr, :pnl, :avgW, :avgL)`,
        { today, total, wins, losses, wr: winRate, pnl: totalPnl, avgW: avgWin, avgL: avgLoss },
        { autoCommit: true }
      );
    } catch (err) {
      // 성과 기록 실패는 비치명적
    } finally {
      await conn.close();
    }
  }
}
