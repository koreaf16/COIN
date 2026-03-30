/**
 * @module 플랜 캐시
 * @description 실행 계획(Execution Plan)을 메모리에 캐싱하고 주기적으로 갱신한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Oracle DB    │ ───→ │ Plan         │ ───→ │ Rule Engine  │
 * │ (Plans)      │      │ Cache        │      │              │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *                              ↑
 *                       ┌──────────────┐
 *                       │ Scheduler    │
 *                       │ (Z2 Intel)   │
 *                       └──────────────┘
 *
 * @zone z3-exec
 * @dependencies db.js, query-loader.js, logger.js
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { loadQueries } from '../shared/query-loader.js';

const queries = loadQueries('z3-exec/plan-cache');

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

  /** 특정 심볼의 ACTIVE 플랜 목록 (만료된 캐시 자동 제거) */
  getActivePlans(symbol) {
    const plans = this.plans.get(symbol) || [];
    const now = Date.now();
    return plans.filter(p => !p.validUntil || p.validUntil > now);
  }

  /** 전체 ACTIVE 플랜 수 (만료 제외) */
  get totalActive() {
    const now = Date.now();
    let count = 0;
    for (const plans of this.plans.values()) {
      count += plans.filter(p => !p.validUntil || p.validUntil > now).length;
    }
    return count;
  }

  /** 특정 심볼의 인메모리 validUntil 즉시 갱신 (DB 연장과 동기화) */
  extendPlans(symbol, newValidUntilMs) {
    const plans = this.plans.get(symbol);
    if (!plans) return;
    for (const p of plans) {
      p.validUntil = newValidUntilMs;
    }
  }

  /** 플랜 상태 업데이트 (TRIGGERED) */
  async markTriggered(planId) {
    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(queries.markTriggered, { id: planId }, { autoCommit: true });
      } finally {
        await conn.close();
      }
      // 캐시에서도 제거
      for (const [sym, plans] of this.plans) {
        this.plans.set(sym, plans.filter(p => p.id !== planId));
      }
    } catch (err) {
      logger.error(`[Z3-Cache] markTriggered error: ${err.message}`);
    }
  }

  async _refresh() {
    try {
      const conn = await getPool().getConnection();
      try {
        // 만료된 플랜 자동 EXPIRED 처리
        await conn.execute(queries.expirePlans, {}, { autoCommit: true });

        // ACTIVE 플랜 조회
        const result = await conn.execute(queries.getActivePlans, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // Atomic swap
        const newPlans = new Map();
        for (const row of (result.rows || [])) {
          const symbol = row.SYMBOL;
          if (!newPlans.has(symbol)) newPlans.set(symbol, []);

          let entryConditions = row.ENTRY_CONDITIONS;
          let stopConditions = row.STOP_CONDITIONS;
          if (typeof entryConditions === 'string') entryConditions = JSON.parse(entryConditions);
          if (typeof stopConditions === 'string') stopConditions = JSON.parse(stopConditions);

          newPlans.get(symbol).push({
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
            validUntil: row.VALID_UNTIL instanceof Date ? row.VALID_UNTIL.getTime() : null,
          });
        }
        this.plans = newPlans;
        this.lastRefresh = Date.now();
      } finally {
        await conn.close();
      }
    } catch (err) {
      logger.error('[Z3-Cache] Refresh error:', err.message);
    }
  }
}
