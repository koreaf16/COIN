/**
 * Z3 Plan Cache — execution_plan 메모리 캐시
 * 1분마다 DB에서 ACTIVE 플랜 조회 → 메모리 캐시
 * 룰엔진이 매초 이 캐시를 읽어 조건 평가
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';

export class PlanCache {
  constructor(opts = {}) {
    this.refreshIntervalMs = (opts.refreshIntervalSec || 60) * 1000;
    this.plans = new Map(); // symbol → [plan, plan, ...]
    this._timer = null;
    this.lastRefresh = 0;
  }

  start() {
    this._refresh();
    this._timer = setInterval(() => this._refresh(), this.refreshIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  /** 특정 심볼의 ACTIVE 플랜 목록 */
  getActivePlans(symbol) {
    return this.plans.get(symbol) || [];
  }

  /** 전체 ACTIVE 플랜 수 */
  get totalActive() {
    let count = 0;
    for (const plans of this.plans.values()) count += plans.length;
    return count;
  }

  /** 플랜 상태 업데이트 (TRIGGERED) */
  async markTriggered(planId) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `UPDATE z2_execution_plan
         SET status = 'TRIGGERED', triggered_at = SYSTIMESTAMP
         WHERE id = :id AND status = 'ACTIVE'`,
        { id: planId },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
    // 캐시에서도 제거
    for (const [sym, plans] of this.plans) {
      this.plans.set(sym, plans.filter(p => p.id !== planId));
    }
  }

  async _refresh() {
    try {
      const conn = await getPool().getConnection();
      try {
        // 만료된 플랜 자동 EXPIRED 처리
        await conn.execute(
          `UPDATE z2_execution_plan SET status = 'EXPIRED'
           WHERE status = 'ACTIVE' AND valid_until < SYSTIMESTAMP`,
          {}, { autoCommit: true }
        );

        // ACTIVE 플랜 조회
        const result = await conn.execute(
          `SELECT id, symbol, direction, entry_conditions, target_price, stop_price,
                  stop_conditions, time_stop_min, confidence, reasoning
           FROM z2_execution_plan
           WHERE status = 'ACTIVE' AND valid_until > SYSTIMESTAMP
           ORDER BY confidence DESC`,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        this.plans.clear();
        for (const row of (result.rows || [])) {
          const symbol = row.SYMBOL;
          if (!this.plans.has(symbol)) this.plans.set(symbol, []);

          let entryConditions = row.ENTRY_CONDITIONS;
          let stopConditions = row.STOP_CONDITIONS;
          // JSON 파싱 (Oracle JSON → JS object)
          if (typeof entryConditions === 'string') entryConditions = JSON.parse(entryConditions);
          if (typeof stopConditions === 'string') stopConditions = JSON.parse(stopConditions);

          this.plans.get(symbol).push({
            id: row.ID,
            symbol,
            direction: row.DIRECTION,
            entryConditions,
            targetPrice: row.TARGET_PRICE,
            stopPrice: row.STOP_PRICE,
            stopConditions,
            timeStopMin: row.TIME_STOP_MIN,
            confidence: row.CONFIDENCE,
            reasoning: row.REASONING,
          });
        }

        this.lastRefresh = Date.now();
      } finally {
        await conn.close();
      }
    } catch (err) {
      console.error('[Z3-Cache] Refresh error:', err.message);
    }
  }
}
