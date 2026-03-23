/**
 * Z0 Macro Collector — Yahoo Finance (15분 폴링) + FRED (일간)
 *
 * Yahoo Finance: DXY, VIX, US10Y, NQ 선물
 * FRED: FEDFUNDS, CPIAUCSL, DGS10, DGS2, UNRATE 등
 *
 * 매크로 레짐 분류: DXY 추세 + VIX 레벨 + 금리 방향 → risk_on/neutral/risk_off
 */

import { config } from '../shared/config.js';
import { getPool } from '../shared/db.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_API_KEY = config.fred.apiKey;
const FRED_SERIES = config.fred.seriesIds.filter(Boolean);

// Yahoo Finance 심볼 매핑
const YAHOO_INDICATORS = {
  'DXY':       'DX-Y.NYB',   // US Dollar Index
  'VIX':       '^VIX',        // Volatility Index
  'US10Y':     '^TNX',        // 10-Year Treasury Yield
  'NQ_FUTURE': 'NQ=F',        // NASDAQ 100 E-mini Futures
};

export class MacroCollector {
  constructor(opts = {}) {
    this.yahooIntervalMs = (opts.yahooIntervalMin || 5) * 60 * 1000;   // 5분
    this.fredIntervalMs = (opts.fredIntervalHours || 24) * 60 * 60 * 1000; // 24시간

    this._yahooTimer = null;
    this._fredTimer = null;

    this.currentRegime = 'neutral';
    this.latestData = {};   // indicator → value
    this.stats = { yahooFetches: 0, fredFetches: 0, errors: 0 };
  }

  async start() {
    await this._loadLatestFromDb();

    // Yahoo Finance
    this._fetchYahoo();
    this._yahooTimer = setInterval(() => this._fetchYahoo(), this.yahooIntervalMs);

    // FRED
    if (FRED_API_KEY) {
      this._fetchFred();
      this._fredTimer = setInterval(() => this._fetchFred(), this.fredIntervalMs);
    }

    console.log(`[Z0-Macro] Started (Yahoo=${this.yahooIntervalMs/60000}min, FRED=${FRED_API_KEY ? 'daily' : 'disabled'})`);
  }

  async _loadLatestFromDb() {
    try {
      const conn = await getPool().getConnection();
      const result = await conn.execute(`
        SELECT indicator, value 
        FROM (
          SELECT indicator, value, ROW_NUMBER() OVER (PARTITION BY indicator ORDER BY ts DESC) as rn
          FROM z0_macro_data
        ) 
        WHERE rn = 1
      `);
      for (const row of result.rows) {
        this.latestData[row[0]] = row[1];
      }
      await conn.close();
      console.log(`[Z0-Macro] Loaded ${result.rows.length} latest indicators from DB.`);
      this._updateRegime();
    } catch (err) {
      console.error(`[Z0-Macro] Error loading initial data from DB:`, err.message);
    }
  }

  stop() {
    if (this._yahooTimer) clearInterval(this._yahooTimer);
    if (this._fredTimer) clearInterval(this._fredTimer);
    console.log(`[Z0-Macro] Stopped (regime=${this.currentRegime})`);
  }

  getRegime() { return this.currentRegime; }
  getData() { return { ...this.latestData }; }

  // ── Yahoo Finance ──
  async _fetchYahoo() {
    for (const [indicator, yahooSymbol] of Object.entries(YAHOO_INDICATORS)) {
      try {
        const value = await this._fetchYahooQuote(yahooSymbol);
        if (value !== null) {
          this.latestData[indicator] = value;
          await this._saveToDb(indicator, value, 'YAHOO');
          this.stats.yahooFetches++;
        }
      } catch (err) {
        this.stats.errors++;
        // Yahoo 에러는 빈번할 수 있음 (장 마감 등) — 경고만
        if (this.stats.errors % 10 === 1) {
          console.warn(`[Z0-Macro] Yahoo ${indicator} error:`, err.message);
        }
      }
    }

    // 레짐 업데이트
    this._updateRegime();
  }

  async _fetchYahooQuote(symbol) {
    // Yahoo Finance v8 API (비공식이지만 안정적)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      // 장 마감 시 2d range로 재시도
      if (res.status === 404 || res.status === 422) {
        const url2 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=5m`;
        const res2 = await fetch(url2, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res2.ok) return null;
        const data2 = await res2.json();
        const close2 = data2.chart?.result?.[0]?.meta?.regularMarketPrice;
        return close2 ?? null;
      }
      return null;
    }

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    // 최신 가격
    const price = result.meta?.regularMarketPrice;
    return price ?? null;
  }

  // ── FRED ──
  async _fetchFred() {
    for (const seriesId of FRED_SERIES) {
      try {
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
      } catch (err) {
        this.stats.errors++;
      }
    }

    console.log(`[Z0-Macro] FRED updated: ${FRED_SERIES.length} series`);
  }

  // ── DB 저장 ──
  async _saveToDb(indicator, value, source) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z0_macro_data (indicator, ts, value, source)
         VALUES (:ind, SYSTIMESTAMP, :val, :src)`,
        { ind: indicator, val: value, src: source },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
  }

  // ── 매크로 레짐 분류 ──
  _updateRegime() {
    const dxy = this.latestData.DXY;
    const vix = this.latestData.VIX;

    if (!dxy || !vix) return; // 데이터 미수집

    // VIX 기반 1차 분류
    if (vix > 30) {
      this.currentRegime = 'risk_off';
    } else if (vix > 25) {
      this.currentRegime = 'risk_off';
    } else if (vix < 15) {
      this.currentRegime = 'risk_on';
    } else if (vix < 20) {
      this.currentRegime = dxy < 105 ? 'risk_on' : 'neutral';
    } else {
      this.currentRegime = 'neutral';
    }
  }
}
