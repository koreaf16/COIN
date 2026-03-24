/**
 * Z0 Coinglass Collector — 청산맵 + 전체거래소 OI/펀딩비
 *
 * 수집 항목:
 *   - 청산 히트맵 (Liquidation Heatmap) — 가격대별 청산 클러스터 예측
 *   - 전체거래소 합산 OI (Binance만이 아닌 전체 시장)
 *   - 전체거래소 합산 펀딩비
 *   - 롱숏 비율 (전체 시장)
 *
 * API: https://open-api-v3.coinglass.com
 * Auth: coinglassSecret header
 */

import { config } from '../shared/config.js';
import { getPool } from '../shared/db.js';

const API_KEY = config.coinglass.apiKey;
const BASE_URL = 'https://open-api-v3.coinglass.com/api';

// Coinglass 심볼 (USDT 제거)
function cgSymbol(symbol) { return symbol.replace('USDT', ''); }

export class CoinglassCollector {
  constructor(symbols, opts = {}) {
    this.symbols = symbols.slice(0, 10); // 상위 10개만 (API 제한 고려)
    this.heatmapIntervalMs = (opts.heatmapIntervalMin || 15) * 60 * 1000;  // 15분
    this.oiIntervalMs = (opts.oiIntervalMin || 5) * 60 * 1000;             // 5분
    this._heatmapTimer = null;
    this._oiTimer = null;
    this.stats = { heatmapFetched: 0, oiFetched: 0, errors: 0 };
    this.latestHeatmap = new Map(); // symbol → heatmap data
  }

  start() {
    if (!API_KEY) {
      console.log('[Z0-Coinglass] API key not set, skipping');
      return;
    }
    this._fetchAllOI();
    this._oiTimer = setInterval(() => this._fetchAllOI(), this.oiIntervalMs);

    // 청산맵은 1분 후 시작 (데이터 축적 대기)
    setTimeout(() => {
      this._fetchAllHeatmap();
      this._heatmapTimer = setInterval(() => this._fetchAllHeatmap(), this.heatmapIntervalMs);
    }, 60000);

    console.log(`[Z0-Coinglass] Started (heatmap=${this.heatmapIntervalMs/60000}min, OI=${this.oiIntervalMs/60000}min, ${this.symbols.length} symbols)`);
  }

  stop() {
    if (this._heatmapTimer) clearInterval(this._heatmapTimer);
    if (this._oiTimer) clearInterval(this._oiTimer);
    console.log(`[Z0-Coinglass] Stopped (heatmap=${this.stats.heatmapFetched}, oi=${this.stats.oiFetched}, errors=${this.stats.errors})`);
  }

  getHeatmap(symbol) {
    return this.latestHeatmap.get(symbol) || null;
  }

  // ── 청산 히트맵 (15분마다) ──
  async _fetchAllHeatmap() {
    for (const symbol of this.symbols) {
      try {
        await this._fetchHeatmap(symbol);
        this.stats.heatmapFetched++;
      } catch (err) {
        this.stats.errors++;
      }
      await this._sleep(1000);
    }
  }

  async _fetchHeatmap(symbol) {
    const sym = cgSymbol(symbol);
    const res = await this._apiCall('/futures/liquidation/aggregated-heatmap', {
      symbol: sym, range: '24h',
    });

    if (!res?.data) return;

    // 히트맵 데이터 → z1_liquidation_map 저장
    const levels = res.data;
    if (!Array.isArray(levels)) return;

    this.latestHeatmap.set(symbol, levels);

    const conn = await getPool().getConnection();
    try {
      // 기존 데이터 정리 후 새로 INSERT
      await conn.execute(
        'DELETE FROM z1_liquidation_map WHERE symbol = :sym AND ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL \'1\' HOUR',
        { sym: symbol }
      );

      for (const level of levels.slice(0, 50)) { // 상위 50개 레벨만
        const priceLevel = level.price || level.priceLevel || 0;
        const longLiq = level.longLiqUsd || level.liqLong || 0;
        const shortLiq = level.shortLiqUsd || level.liqShort || 0;
        if (priceLevel <= 0) continue;

        await conn.execute(
          `INSERT INTO z1_liquidation_map (symbol, ts, price_level, long_liq_usd, short_liq_usd)
           VALUES (:sym, SYSTIMESTAMP, :price, :longLiq, :shortLiq)`,
          { sym: symbol, price: priceLevel, longLiq, shortLiq }
        );
      }
      await conn.execute('COMMIT');
    } finally {
      await conn.close();
    }
  }

  // ── 전체거래소 OI + 펀딩비 (5분마다) ──
  async _fetchAllOI() {
    for (const symbol of this.symbols) {
      try {
        await this._fetchOIFunding(symbol);
        this.stats.oiFetched++;
      } catch (err) {
        this.stats.errors++;
      }
      await this._sleep(500);
    }
  }

  async _fetchOIFunding(symbol) {
    const sym = cgSymbol(symbol);

    // 전체거래소 합산 OI
    const oiRes = await this._apiCall('/futures/open-interest/aggregated-ohlc', {
      symbol: sym, interval: '1h', limit: 1,
    });

    // 전체거래소 합산 펀딩비
    const fundingRes = await this._apiCall('/futures/funding-rate/oi-weight', {
      symbol: sym,
    });

    // z0_derivatives에 전체거래소 데이터 MERGE
    const conn = await getPool().getConnection();
    try {
      const totalOI = oiRes?.data?.[0]?.close || oiRes?.data?.[0]?.value || null;
      const oiWeightedFunding = fundingRes?.data?.oiWeightedFundingRate || fundingRes?.data?.rate || null;

      if (totalOI || oiWeightedFunding) {
        await conn.execute(
          `MERGE INTO z0_derivatives d
           USING (SELECT :sym AS symbol, SYSTIMESTAMP AS ts FROM dual) s
           ON (d.symbol = s.symbol AND d.ts = s.ts)
           WHEN NOT MATCHED THEN INSERT (symbol, ts, open_interest, funding_rate)
                                 VALUES (:sym, SYSTIMESTAMP, :oi, :funding)`,
          { sym: symbol, oi: totalOI, funding: oiWeightedFunding },
          { autoCommit: true }
        );
      }
    } finally {
      await conn.close();
    }
  }

  async _apiCall(path, params = {}) {
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = `${BASE_URL}${path}?${query}`;

    const res = await fetch(url, {
      headers: { 'coinglassSecret': API_KEY },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      if (res.status === 429) {
        await this._sleep(5000);
        return null;
      }
      throw new Error(`Coinglass ${res.status} ${path}`);
    }
    return res.json();
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
