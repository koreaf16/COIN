/**
 * Z0 Fear & Greed Index — Alternative.me (완전 무료, 키 불필요)
 *
 * 0~100: 극단적 공포(0~24) → 공포(25~49) → 중립(50) → 탐욕(51~74) → 극단적 탐욕(75~100)
 * 역발상 시그널: 극단적 공포 + 숏과적 = 롱 기회 / 극단적 탐욕 + 롱과적 = 숏 기회
 * 주기: 10분 (API 갱신은 일 1회이지만, 빠른 감지 위해)
 */

import { getPool } from '../shared/db.js';

const API_URL = 'https://api.alternative.me/fng/?limit=1&format=json';

export class FearGreedCollector {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 10) * 60 * 1000;
    this._timer = null;
    this.current = { value: 50, classification: 'Neutral' };
    this.stats = { fetched: 0, errors: 0 };
  }

  start() {
    this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    console.log(`[Z0-FnG] Fear & Greed started (interval=${this.intervalMs / 60000}min)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  getValue() { return this.current.value; }
  getClassification() { return this.current.classification; }
  getData() { return { ...this.current }; }

  async _fetch() {
    try {
      const res = await fetch(API_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;

      const data = await res.json();
      const fng = data.data?.[0];
      if (!fng) return;

      this.current = {
        value: parseInt(fng.value),
        classification: fng.value_classification,
      };
      this.stats.fetched++;

      // DB 저장
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `MERGE INTO z0_fear_greed f
           USING (SELECT TRUNC(SYSTIMESTAMP, 'HH') AS ts FROM dual) s
           ON (f.ts = s.ts)
           WHEN NOT MATCHED THEN INSERT (ts, value, classification) VALUES (SYSTIMESTAMP, :val, :cls)
           WHEN MATCHED THEN UPDATE SET value = :val, classification = :cls`,
          { val: this.current.value, cls: this.current.classification },
          { autoCommit: true }
        );
      } finally {
        await conn.close();
      }

      console.log(`[Z0-FnG] Fear & Greed: ${this.current.value} (${this.current.classification})`);
    } catch (err) {
      this.stats.errors++;
    }
  }
}
