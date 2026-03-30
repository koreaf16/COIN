/**
 * @module 성과 추적기 (Performance Tracker)
 * @description 일간/주간/월간 매매 성과를 집계하여 Oracle DB에 저장한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Z4       │ ──→ │ Perfor-  │ ──→ │ Oracle   │
 * │ Positions│     │ mance    │     │ DB       │
 * └──────────┘     │ Tracker  │     └──────────┘
 *                  └──────────┘
 *
 * @zone z4-results
 * @dependencies db.js, time.js, query-loader.js, logger.js
 */

import { getPool } from '../shared/db.js';
import { todayET } from '../shared/time.js';
import { loadQueries } from '../shared/query-loader.js';
import { logger } from '../shared/logger.js';

const queries = loadQueries('z4-results/performance-tracker');

export class PerformanceTracker {
  constructor(opts = {}) {
    this.updateIntervalMs = (opts.updateIntervalMin || 60) * 60 * 1000;
    this._timer = null;
  }

  /**
   * 성과 추적 루프 시작
   */
  start() {
    try {
      this._timer = setInterval(() => this._updateDaily(), this.updateIntervalMs);
      // 시작 시 즉시 1회 수행 (5초 후)
      setTimeout(() => this._updateDaily(), 5000);
      logger.info('[Z4] PerformanceTracker started');
    } catch (err) {
      logger.error('[Z4] PerformanceTracker start error:', err.message);
    }
  }

  /**
   * 성과 추적 루프 중지
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      logger.info('[Z4] PerformanceTracker stopped');
    }
  }

  /**
   * 일간 성과 집계 및 저장
   * @private
   */
  async _updateDaily() {
    let conn;
    try {
      conn = await getPool().getConnection();
      const today = todayET();
      
      const result = await conn.execute(queries.get_daily_performance, { today });

      const row = result.rows?.[0];
      if (!row || row[0] === 0) return;

      const [total, wins, losses, totalPnl, avgWin, avgLoss, profitFactor, sharpeRatio] = row;
      const winRate = total > 0 ? (wins / total) * 100 : 0;

      await conn.execute(
        queries.merge_performance,
        { 
          today, total, wins, losses, wr: winRate, pnl: totalPnl, avgW: avgWin, avgL: avgLoss,
          pf: profitFactor ?? null, sr: sharpeRatio ?? null 
        },
        { autoCommit: true }
      );
      
      logger.info(`[Z4] Daily performance updated for ${today}: trades=${total}, pnl=${totalPnl.toFixed(2)}`);
    } catch (err) {
      // 성과 기록 실패는 비치명적이지만 로깅은 수행
      logger.error('[Z4] Daily performance update error:', err.message);
    } finally {
      if (conn) {
        try {
          await conn.close();
        } catch (closeErr) {
          logger.error('[Z4] Connection close error:', closeErr.message);
        }
      }
    }
  }
}
