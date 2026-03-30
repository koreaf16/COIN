/**
 * @module Macro Collector
 * @description Yahoo Finance 및 FRED API에서 매크로 경제 지표(DXY, VIX, 금리 등)를 수집한다.
 *
 * ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
 * │ Yahoo/FRED   │ ──→ │ Macro Collector  │ ──→ │ Oracle DB    │
 * │ API          │     │ (Z0-Raw)         │     │ (z0_macro)   │
 * └──────────────┘     └──────────────────┘     └──────────────┘
 *                               ↓
 *                        매크로 레짐 분류
 *                       (risk_on/off/neutral)
 *
 * @zone z0-raw
 * @dependencies config.js, db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { config } from '../shared/config.js';
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_API_KEY = config.fred.apiKey;
const FRED_SERIES = config.fred.seriesIds?.filter(Boolean) || [];

const queries = loadQueries('z0-raw/macro-collector');

// Yahoo Finance 심볼 매핑
const YAHOO_INDICATORS = {
  'DXY':       'DX-Y.NYB',   // US Dollar Index
  'VIX':       '^VIX',        // Volatility Index
  'US10Y':     '^TNX',        // 10-Year Treasury Yield
  'NQ_FUTURE': 'NQ=F',        // NASDAQ 100 E-mini Futures
};

export class MacroCollector {
  constructor(opts = {}) {
    this.yahooIntervalMs = (opts.yahooIntervalMin || 5) * 60 * 1000;
    this.fredIntervalMs = (opts.fredIntervalHours || 24) * 60 * 60 * 1000;

    this._yahooTimer = null;
    this._fredTimer = null;

    this.currentRegime = 'neutral';
    this.latestData = {};
    this.stats = { yahooFetches: 0, fredFetches: 0, errors: 0 };
  }

  /**
   * 서비스 시작: 초기 데이터 로드 및 폴링 타이머 설정
   */
  async start() {
    try {
      await this._loadLatestFromDb();

      // Yahoo Finance 수집 시작
      this._fetchYahoo();
      this._yahooTimer = setInterval(() => this._fetchYahoo(), this.yahooIntervalMs);

      // FRED 수집 시작 (API 키 있을 경우)
      if (FRED_API_KEY) {
        this._fetchFred();
        this._fredTimer = setInterval(() => this._fetchFred(), this.fredIntervalMs);
      }

      logger.info(`[Z0-Macro] Started (Yahoo=${this.yahooIntervalMs / 60000}min, FRED=${FRED_API_KEY ? 'daily' : 'disabled'})`);
    } catch (err) {
      logger.error(`[Z0-Macro] Failed to start: ${err.message}`);
    }
  }

  /**
   * 서비스 종료: 타이머 해제
   */
  stop() {
    if (this._yahooTimer) clearInterval(this._yahooTimer);
    if (this._fredTimer) clearInterval(this._fredTimer);
    logger.info(`[Z0-Macro] Stopped (regime=${this.currentRegime})`);
  }

  getRegime() { return this.currentRegime; }
  getData() { return { ...this.latestData }; }

  /**
   * DB에서 가장 최근의 지표 데이터를 로드한다.
   */
  async _loadLatestFromDb() {
    try {
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(queries.getLatestIndicators);
        for (const row of result.rows) {
          this.latestData[row[0]] = row[1];
        }
        logger.info(`[Z0-Macro] Loaded ${result.rows.length} latest indicators from DB.`);
        this._updateRegime();
      } finally {
        await conn.close();
      }
    } catch (err) {
      logger.error(`[Z0-Macro] Error loading initial data from DB:`, err.message);
    }
  }

  /**
   * Yahoo Finance에서 지표를 수집한다.
   */
  async _fetchYahoo() {
    try {
      for (const [indicator, yahooSymbol] of Object.entries(YAHOO_INDICATORS)) {
        const value = await this._fetchYahooQuote(yahooSymbol);
        if (value !== null) {
          this.latestData[indicator] = value;
          await this._saveToDb(indicator, value, 'YAHOO');
          this.stats.yahooFetches++;
        }
      }
      this._updateRegime();
    } catch (err) {
      this.stats.errors++;
      logger.warn(`[Z0-Macro] Yahoo fetch cycle error:`, err.message);
    }
  }

  /**
   * Yahoo Finance API를 호출하여 개별 심볼의 가격을 가져온다.
   * @param {string} symbol
   */
  async _fetchYahooQuote(symbol) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
      let res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok && (res.status === 404 || res.status === 422)) {
        // 장 마감 시 2d range로 재시도
        const url2 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=5m`;
        res = await fetch(url2, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
      }

      if (!res.ok) return null;
      const data = await res.json();
      return data.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    } catch (err) {
      return null;
    }
  }

  /**
   * FRED API에서 지표를 수집한다.
   */
  async _fetchFred() {
    try {
      for (const seriesId of FRED_SERIES) {
        const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${FRED_API_KEY}&sort_order=desc&limit=2&file_type=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;

        const json = await res.json();
        const obs = json.observations;
        if (!obs?.length) continue;

        const value = parseFloat(obs[0].value);
        if (isNaN(value)) continue;

        this.latestData[seriesId] = value;
        if (obs.length > 1) {
          this.latestData[`${seriesId}_prev`] = parseFloat(obs[1].value) || value;
        }

        await this._saveToDb(seriesId, value, 'FRED');
        this.stats.fredFetches++;
      }
      logger.info(`[Z0-Macro] FRED updated: ${FRED_SERIES.length} series`);
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z0-Macro] FRED fetch error:`, err.message);
    }
  }

  /**
   * 수집된 데이터를 DB에 저장한다.
   */
  async _saveToDb(indicator, value, source) {
    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(queries.insertMacroData,
          { ind: indicator, val: value, src: source },
          { autoCommit: true }
        );
      } finally {
        await conn.close();
      }
    } catch (err) {
      logger.error(`[Z0-Macro] DB Save error (${indicator}):`, err.message);
    }
  }

  /**
   * 지표를 기반으로 매크로 레짐(Risk On/Off)을 분류한다.
   */
  _updateRegime() {
    const { DXY, VIX } = this.latestData;
    if (!DXY || !VIX) return;

    if (VIX > 30) {
      this.currentRegime = 'risk_off';
    } else if (VIX > 25) {
      this.currentRegime = 'risk_off';
    } else if (VIX < 15) {
      this.currentRegime = 'risk_on';
    } else if (VIX < 20) {
      this.currentRegime = DXY < 105 ? 'risk_on' : 'neutral';
    } else {
      this.currentRegime = 'neutral';
    }
  }
}
