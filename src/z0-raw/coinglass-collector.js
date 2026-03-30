/**
 * @module Coinglass 수집기
 * @description Coinglass API를 통해 전체 거래소의 미체결 약정(OI), 펀딩비, 청산 히트맵 데이터를 수집한다.
 *
 * ┌───────────┐     ┌───────────┐     ┌───────────┐
 * │ Coinglass │ ──→ │ Coinglass │ ──→ │ Oracle DB │
 * │ API       │     │ Collector │     │ (z1_liq)  │
 * └───────────┘     └───────────┘     └───────────┘
 *
 * @zone z0-raw
 * @dependencies config.js, db.js, query-loader.js, logger.js
 */

import { config } from '../shared/config.js';
import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const API_KEY = config.coinglass.apiKey;
const BASE_URL = 'https://open-api-v3.coinglass.com/api';
const queries = loadQueries('z0-raw/coinglass-collector');

export class CoinglassCollector {
  constructor(symbols, opts = {}) {
    this.symbols = symbols.slice(0, 15);
    this.heatmapIntervalMs = (opts.heatmapIntervalMin || 15) * 60 * 1000;
    this.oiIntervalMs = (opts.oiIntervalMin || 5) * 60 * 1000;
    this._heatmapTimer = null;
    this._oiTimer = null;
    this.stats = { heatmapFetched: 0, oiFetched: 0, errors: 0 };
    this.latestHeatmap = new Map();
  }

  start() {
    if (!API_KEY) {
      logger.warn('[Z0-Coinglass] API key not set, skipping');
      return;
    }
    this._fetchAllOI();
    this._oiTimer = setInterval(() => this._fetchAllOI(), this.oiIntervalMs);

    this._heatmapInitTimer = setTimeout(() => {
      this._heatmapInitTimer = null;
      this._fetchAllHeatmap();
      this._heatmapTimer = setInterval(() => this._fetchAllHeatmap(), this.heatmapIntervalMs);
    }, 60000);

    logger.info(`[Z0-Coinglass] Started (${this.symbols.length} symbols)`);
  }

  stop() {
    if (this._heatmapInitTimer) clearTimeout(this._heatmapInitTimer);
    if (this._heatmapTimer) clearInterval(this._heatmapTimer);
    if (this._oiTimer) clearInterval(this._oiTimer);
    logger.info(`[Z0-Coinglass] Stopped: H=${this.stats.heatmapFetched}, OI=${this.stats.oiFetched}`);
  }

  async _fetchAllHeatmap() {
    try {
      for (const symbol of this.symbols) {
        try {
          await this._fetchHeatmap(symbol);
          this.stats.heatmapFetched++;
        } catch (err) {
          this.stats.errors++;
        }
        await this._sleep(1000);
      }
    } catch (err) {
      logger.error(`[Z0-Coinglass] Heatmap collection error: ${err.message}`);
    }
  }

  async _fetchHeatmap(symbol) {
    const sym = symbol.replace('USDT', '');
    const res = await this._apiCall('/futures/liquidation/aggregated-heatmap', { symbol: sym, range: '24h' });
    if (!res?.data || !Array.isArray(res.data)) return;

    this.latestHeatmap.set(symbol, res.data);
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.deleteRecentLiquidationMap, { sym: symbol });
      for (const level of res.data.slice(0, 50)) {
        await this._insertHeatmapLevel(conn, symbol, level);
      }
      await conn.execute('COMMIT');
    } finally {
      await conn.close();
    }
  }

  async _insertHeatmapLevel(conn, symbol, level) {
    const price = level.price || level.priceLevel || 0;
    const longLiq = level.longLiqUsd || level.liqLong || 0;
    const shortLiq = level.shortLiqUsd || level.liqShort || 0;
    if (price > 0) {
      await conn.execute(queries.insertLiquidationMap, { sym: symbol, price, longLiq, shortLiq });
    }
  }

  async _fetchAllOI() {
    try {
      for (const symbol of this.symbols) {
        try {
          await this._fetchOIFunding(symbol);
          this.stats.oiFetched++;
        } catch (err) {
          this.stats.errors++;
        }
        await this._sleep(500);
      }
    } catch (err) {
      logger.error(`[Z0-Coinglass] OI collection error: ${err.message}`);
    }
  }

  async _fetchOIFunding(symbol) {
    const sym = symbol.replace('USDT', '');
    const [oiRes, fundingRes] = await Promise.all([
      this._apiCall('/futures/open-interest/aggregated-ohlc', { symbol: sym, interval: '1h', limit: 1 }),
      this._apiCall('/futures/funding-rate/oi-weight', { symbol: sym })
    ]);

    const totalOI = oiRes?.data?.[0]?.close || oiRes?.data?.[0]?.value || null;
    const funding = fundingRes?.data?.oiWeightedFundingRate || fundingRes?.data?.rate || null;

    if (totalOI || funding) {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(queries.mergeAggregatedDerivatives, { sym: symbol, oi: totalOI, funding }, { autoCommit: true });
      } finally {
        await conn.close();
      }
    }
  }

  async _apiCall(path, params = {}) {
    try {
      const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const url = `${BASE_URL}${path}?${query}`;
      const res = await fetch(url, { headers: { 'coinglassSecret': API_KEY }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        if (res.status === 429) { await this._sleep(5000); return null; }
        throw new Error(`Coinglass ${res.status} ${path}`);
      }
      return await res.json();
    } catch (err) {
      throw err;
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
