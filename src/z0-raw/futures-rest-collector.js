/**
 * @module Futures REST 수집기
 * @description Binance Futures REST API를 통해 미체결 약정(OI), 롱숏 비율, 펀딩비를 수집한다.
 *
 * ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 * │ Binance REST │ ──→ │ Futures REST │ ──→ │ Oracle DB    │
 * │ API          │     │ Collector    │     │ (z0_derivs)  │
 * └──────────────┘     └──────────────┘     └──────────────┘
 *
 * @zone z0-raw
 * @dependencies db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const FAPI_BASE = 'https://fapi.binance.com';
const queries = loadQueries('z0-raw/futures-rest-collector');

export class FuturesRestCollector {
  constructor(symbols, opts = {}) {
    this.symbols = symbols;
    this.oiIntervalMs = (opts.oiIntervalSec || 30) * 1000;
    this.lsIntervalMs = (opts.lsIntervalSec || 300) * 1000;
    this.fundingIntervalMs = (opts.fundingIntervalSec || 60) * 1000;

    this._oiTimer = null;
    this._lsTimer = null;
    this._fundingTimer = null;
    this._oiBlacklist = new Set();
    this.stats = { oiCollected: 0, lsCollected: 0, fundingCollected: 0, errors: 0 };
  }

  start() {
    this._collectAllOI();
    this._collectAllLongShort();
    this._collectAllFunding();

    this._oiTimer = setInterval(() => this._collectAllOI(), this.oiIntervalMs);
    this._lsTimer = setInterval(() => this._collectAllLongShort(), this.lsIntervalMs);
    this._fundingTimer = setInterval(() => this._collectAllFunding(), this.fundingIntervalMs);

    logger.info(`[Z0-REST] Started (${this.symbols.length} symbols)`);
  }

  stop() {
    if (this._oiTimer) clearInterval(this._oiTimer);
    if (this._lsTimer) clearInterval(this._lsTimer);
    if (this._fundingTimer) clearInterval(this._fundingTimer);
    logger.info(`[Z0-REST] Stopped: OI=${this.stats.oiCollected}, LS=${this.stats.lsCollected}, F=${this.stats.fundingCollected}`);
  }

  async _collectAllOI() {
    try {
      for (const symbol of this.symbols) {
        if (this._oiBlacklist.has(symbol)) continue;
        try {
          await this._collectOI(symbol);
          this.stats.oiCollected++;
        } catch (err) {
          this.stats.errors++;
          this._handleOiError(symbol, err);
        }
        await this._sleep(50);
      }
    } catch (err) {
      logger.error(`[Z0-REST] All OI collection error: ${err.message}`);
    }
  }

  _handleOiError(symbol, err) {
    if (err.message?.includes('400')) {
      this._oiBlacklist.add(symbol);
      logger.warn(`[Z0-REST] OI 스킵: ${symbol}`);
    } else if (!err.message?.includes('429')) {
      logger.error(`[Z0-REST] OI error ${symbol}:`, err.message);
    }
  }

  async _collectOI(symbol) {
    const conn = await getPool().getConnection();
    try {
      const { oi, ts } = await this._fetchOiFromBinance(symbol);
      const liq = await this._getLiquidationSum(conn, symbol);
      const prev = await this._getPreviousDerivatives(conn, symbol);

      let oiChangePct = 0;
      if (prev && prev.open_interest > 0) {
        oiChangePct = ((oi - prev.open_interest) / prev.open_interest) * 100;
      }

      await conn.execute(queries.mergeDerivativesOI, {
        sym: symbol, ts, oi, chg: oiChangePct,
        fr: prev?.funding_rate || null,
        lr: prev?.long_ratio || null,
        sr: prev?.short_ratio || null,
        ll: liq.long_liq, ls: liq.short_liq
      }, { autoCommit: true });
    } finally {
      await conn.close();
    }
  }

  async _fetchOiFromBinance(symbol) {
    const oiUrl = `${FAPI_BASE}/fapi/v1/openInterest?symbol=${symbol}`;
    const res = await fetch(oiUrl);
    if (!res.ok) throw new Error(`OI ${res.status}`);
    const data = await res.json();
    return {
      oi: parseFloat(data.openInterest),
      ts: new Date(Math.floor(data.time / 60000) * 60000)
    };
  }

  async _getLiquidationSum(conn, symbol) {
    const result = await conn.execute(queries.getLiquidationSum, { sym: symbol });
    return {
      long_liq: result.rows?.[0]?.[0] || 0,
      short_liq: result.rows?.[0]?.[1] || 0
    };
  }

  async _getPreviousDerivatives(conn, symbol) {
    const result = await conn.execute(queries.getPrevDerivatives, { sym: symbol });
    if (result.rows?.length > 0) {
      const [oi, fr, lr, sr] = result.rows[0];
      return { open_interest: oi, funding_rate: fr, long_ratio: lr, short_ratio: sr };
    }
    return null;
  }

  async _collectAllLongShort() {
    try {
      for (const symbol of this.symbols) {
        try {
          await this._collectLongShort(symbol);
          this.stats.lsCollected++;
        } catch (err) {
          this.stats.errors++;
        }
        await this._sleep(50);
      }
    } catch (err) {
      logger.error(`[Z0-REST] All LS collection error: ${err.message}`);
    }
  }

  async _collectLongShort(symbol) {
    const url = `${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.length) return;

    const latest = data[0];
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.updateLongShortRatio, {
        sym: symbol, lr: parseFloat(latest.longAccount), sr: parseFloat(latest.shortAccount)
      }, { autoCommit: true });
    } finally {
      await conn.close();
    }
  }

  async _collectAllFunding() {
    try {
      const res = await fetch(`${FAPI_BASE}/fapi/v1/premiumIndex`);
      if (!res.ok) return;
      const data = await res.json();
      
      const premiumMap = this._parsePremiumData(data);
      const conn = await getPool().getConnection();
      try {
        for (const symbol of this.symbols) {
          const rates = premiumMap.get(symbol);
          if (rates) {
            await conn.execute(queries.updateFundingRates, {
              sym: symbol, pr: rates.predictedRate, fr: rates.fundingRate
            }, { autoCommit: true });
            this.stats.fundingCollected++;
          }
        }
      } finally {
        await conn.close();
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z0-REST] Funding collection error: ${err.message}`);
    }
  }

  _parsePremiumData(data) {
    const map = new Map();
    for (const item of data) {
      const mark = parseFloat(item.markPrice);
      const index = parseFloat(item.indexPrice);
      const predicted = index > 0 ? (mark - index) / index / 8 : 0;
      map.set(item.symbol, { fundingRate: parseFloat(item.lastFundingRate), predictedRate: predicted });
    }
    return map;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
