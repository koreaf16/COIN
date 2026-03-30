/**
 * @module 스테이블코인 수집기
 * @description CoinGecko API에서 USDT, USDC의 시가총액을 수집하여 Oracle DB에 저장한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ CoinGecko│ ──→ │ Stable   │ ──→ │ Oracle   │
 * │ API      │     │ Collector│     │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↓
 *              state-vector-builder
 *
 * @zone z0-raw
 * @dependencies db.js, logger.js, query-loader.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const queries = loadQueries('z0-raw/stablecoin-collector');

export class StablecoinCollector {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 30) * 60 * 1000;
    this._timer = null;
    this.current = { usdtMcap: 0, usdcMcap: 0, totalMcap: 0 };
    this.stats = { fetched: 0, errors: 0 };
  }

  /**
   * 수집 시작
   */
  start() {
    this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    logger.info(`[Z0-Stable] Stablecoin supply started (interval=${this.intervalMs / 60000}min)`);
  }

  /**
   * 수집 중지
   */
  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  /**
   * 현재 데이터 반환
   */
  getData() { return { ...this.current }; }

  /**
   * CoinGecko API 호출 및 DB 저장
   * @private
   */
  async _fetch() {
    try {
      const url = `${COINGECKO_BASE}/simple/price?ids=tether,usd-coin&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'COIN-Trading-System/2.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        this.stats.errors++;
        logger.error(`[Z0-Stable] API response not ok: ${res.status} ${res.statusText}`);
        return;
      }

      const data = await res.json();
      const usdt = data.tether || {};
      const usdc = data['usd-coin'] || {};

      this.current = {
        usdtMcap: usdt.usd_market_cap || 0,
        usdcMcap: usdc.usd_market_cap || 0,
        totalMcap: (usdt.usd_market_cap || 0) + (usdc.usd_market_cap || 0),
        usdtChange24h: usdt.usd_24h_change || 0,
        usdcChange24h: usdc.usd_24h_change || 0,
      };
      this.stats.fetched++;

      await this._saveToDb();

      const totalB = (this.current.totalMcap / 1e9).toFixed(1);
      logger.info(`[Z0-Stable] USDT+USDC: $${totalB}B (USDT ${this.current.usdtChange24h > 0 ? '+' : ''}${this.current.usdtChange24h.toFixed(2)}%)`);
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 5 === 1) {
        logger.warn(`[Z0-Stable] Fetch error: ${err.message}`);
      }
    }
  }

  /**
   * 수집된 데이터를 Oracle DB에 저장
   * @private
   */
  async _saveToDb() {
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.execute(
        queries.insertStablecoinSupply,
        {
          usdt: this.current.usdtMcap,
          usdc: this.current.usdcMcap,
          total: this.current.totalMcap,
          usdtChg: this.current.usdtChange24h,
          usdcChg: this.current.usdcChange24h,
        },
        { autoCommit: true }
      );
    } catch (err) {
      logger.error(`[Z0-Stable] DB save error: ${err.message}`);
    } finally {
      if (conn) {
        try {
          await conn.close();
        } catch (closeErr) {
          logger.error(`[Z0-Stable] DB connection close error: ${closeErr.message}`);
        }
      }
    }
  }
}
