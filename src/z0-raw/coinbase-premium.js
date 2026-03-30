/**
 * @module Coinbase 프리미엄 수집기
 * @description Coinbase(USD)와 Binance(USDT)의 가격 차이를 통해 기관 투자자의 매수/매도 압력을 측정한다.
 *
 * ┌──────────┐     ┌─────────────┐     ┌─────────────┐
 * │ Coinbase │ ──→ │ Coinbase    │ ──→ │ Oracle DB   │
 * │ Binance  │     │ Premium     │     │ (z0_macro)  │
 * └──────────┘     └─────────────┘     └─────────────┘
 *
 * @zone z0-raw
 * @dependencies config.js, db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const COINBASE_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
const queries = loadQueries('z0-raw/coinbase-premium');

export class CoinbasePremiumCollector {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 1) * 60 * 1000;
    this._timer = null;
    this.stats = { fetched: 0, errors: 0 };
    this.latestPremium = 0;
  }

  start() {
    this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    logger.info(`[Z0-Premium] Started (${this.intervalMs / 60000}min)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    logger.info(`[Z0-Premium] Stopped: Fetched=${this.stats.fetched}`);
  }

  async _fetch() {
    try {
      const [cbRes, bnRes] = await Promise.all([
        fetch(COINBASE_URL, { signal: AbortSignal.timeout(5000) }),
        fetch(BINANCE_URL, { signal: AbortSignal.timeout(5000) })
      ]);

      if (!cbRes.ok || !bnRes.ok) throw new Error('API fetch failed');

      const cbData = await cbRes.json();
      const bnData = await bnRes.json();

      const cbPrice = parseFloat(cbData?.data?.amount);
      const bnPrice = parseFloat(bnData?.price);

      if (cbPrice > 0 && bnPrice > 0) {
        const premium = ((cbPrice - bnPrice) / bnPrice) * 100;
        this.latestPremium = premium;
        
        await this._saveToDb(premium);
        this.stats.fetched++;
      }
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 10 === 1) {
        logger.warn(`[Z0-Premium] Fetch error: ${err.message}`);
      }
    }
  }

  async _saveToDb(premium) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.insertCoinbasePremium, { val: premium }, { autoCommit: true });
    } catch (err) {
      logger.error(`[Z0-Premium] DB save error: ${err.message}`);
    } finally {
      await conn.close();
    }
  }
}
