/**
 * @module 공포 탐욕 지수 수집기
 * @description Alternative.me API를 통해 암호화폐 시장의 공포 탐욕 지수(Fear & Greed Index)를 수집한다.
 *
 * ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 * │ Alternative  │ ──→ │ Fear-Greed   │ ──→ │ Oracle DB    │
 * │ .me API      │     │ Collector    │     │ (z0_fng)     │
 * └──────────────┘     └──────────────┘     └──────────────┘
 *
 * @zone z0-raw
 * @dependencies db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const API_URL = 'https://api.alternative.me/fng/?limit=1&format=json';
const queries = loadQueries('z0-raw/fear-greed-collector');

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
    logger.info(`[Z0-FnG] Fear & Greed started (${this.intervalMs / 60000}min)`);
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

      await this._saveToDb();
      logger.info(`[Z0-FnG] Fear & Greed: ${this.current.value} (${this.current.classification})`);
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z0-FnG] Fetch error: ${err.message}`);
    }
  }

  async _saveToDb() {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.mergeFearGreed, {
        val: this.current.value,
        cls: this.current.classification
      }, { autoCommit: true });
    } finally {
      await conn.close();
    }
  }
}
