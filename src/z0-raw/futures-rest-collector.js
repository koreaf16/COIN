/**
 * Z0 Futures REST Collector — OI, 펀딩비, 롱숏비 주기적 폴링
 *
 * 수집 항목:
 *   - Open Interest (1분마다)
 *   - Funding Rate (1시간마다 — 실시간은 markPrice WS에서)
 *   - Long/Short Ratio (5분마다)
 *
 * Binance API Rate Limit: 2400 req/min (weight 기반)
 * OI: weight 1, Funding: weight 1, LongShort: weight 1
 * 30심볼 × 1분 = 30 req/min (OI만) → 여유
 */

import { getPool } from '../shared/db.js';

const FAPI_BASE = 'https://fapi.binance.com';

export class FuturesRestCollector {
  constructor(symbols, opts = {}) {
    this.symbols = symbols;
    this.ringBuffer = opts.ringBuffer || null;
    this.oiIntervalMs = (opts.oiIntervalSec || 30) * 1000;          // 30초
    this.lsIntervalMs = (opts.lsIntervalSec || 300) * 1000;        // 5분 (Binance 한계)
    this.fundingIntervalMs = (opts.fundingIntervalSec || 60) * 1000; // 1분

    this._oiTimer = null;
    this._lsTimer = null;
    this._fundingTimer = null;
    this._oiBlacklist = new Set();  // OI 400 반복 심볼 스킵
    this._lastDeriv = new Map();  // symbol → 최신 파생 데이터 (ringBuffer push용)
    this.stats = { oiCollected: 0, lsCollected: 0, fundingCollected: 0, errors: 0 };
  }

  start() {
    // 즉시 1회 + 주기적
    this._collectAllOI();
    this._collectAllLongShort();
    this._collectAllFunding();

    this._oiTimer = setInterval(() => this._collectAllOI(), this.oiIntervalMs);
    this._lsTimer = setInterval(() => this._collectAllLongShort(), this.lsIntervalMs);
    this._fundingTimer = setInterval(() => this._collectAllFunding(), this.fundingIntervalMs);

    console.log(`[Z0-REST] Started (${this.symbols.length} symbols, OI=${this.oiIntervalMs/1000}s, LS=${this.lsIntervalMs/1000}s)`);
  }

  stop() {
    if (this._oiTimer) clearInterval(this._oiTimer);
    if (this._lsTimer) clearInterval(this._lsTimer);
    if (this._fundingTimer) clearInterval(this._fundingTimer);
    console.log(`[Z0-REST] Stopped (OI=${this.stats.oiCollected}, LS=${this.stats.lsCollected}, F=${this.stats.fundingCollected}, E=${this.stats.errors})`);
  }

  // ── OI (1분마다) ──
  async _collectAllOI() {
    for (const symbol of this.symbols) {
      if (this._oiBlacklist.has(symbol)) continue;
      try {
        await this._collectOI(symbol);
        this.stats.oiCollected++;
      } catch (err) {
        this.stats.errors++;
        if (err.message?.includes('400')) {
          this._oiBlacklist.add(symbol);
          console.warn(`[Z0-REST] OI 미지원 심볼 스킵: ${symbol}`);
        } else if (!err.message?.includes('429')) {
          console.error(`[Z0-REST] OI error ${symbol}:`, err.message);
        }
      }
      await this._sleep(50);
    }
  }

  async _collectOI(symbol) {
    const url = `${FAPI_BASE}/fapi/v1/openInterest?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OI ${res.status}`);
    const data = await res.json();

    const oi = parseFloat(data.openInterest);
    const ts = new Date(data.time);

    // 이전 OI와 비교하여 변화율 계산
    const conn = await getPool().getConnection();
    try {
      // 이전 행에서 OI + 펀딩비 + 롱숏비 가져오기 (이어받기)
      const prev = await conn.execute(
        `SELECT open_interest, funding_rate, long_ratio, short_ratio FROM z0_derivatives
         WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
        { sym: symbol }
      );
      let oiChangePct = 0;
      let prevFr = null, prevLr = null, prevSr = null;
      if (prev.rows?.length > 0) {
        if (prev.rows[0][0] > 0) oiChangePct = ((oi - prev.rows[0][0]) / prev.rows[0][0]) * 100;
        prevFr = prev.rows[0][1];  // 이전 펀딩비 이어받기
        prevLr = prev.rows[0][2];  // 이전 롱비율 이어받기
        prevSr = prev.rows[0][3];  // 이전 숏비율 이어받기
      }

      await conn.execute(
        `MERGE INTO z0_derivatives d
         USING (SELECT :sym AS symbol, :ts AS ts FROM dual) s
         ON (d.symbol = s.symbol AND d.ts = s.ts)
         WHEN MATCHED THEN UPDATE SET open_interest = :oi, oi_change_pct = :chg
         WHEN NOT MATCHED THEN INSERT (symbol, ts, open_interest, oi_change_pct, funding_rate, long_ratio, short_ratio)
                               VALUES (:sym, :ts, :oi, :chg, :fr, :lr, :sr)`,
        { sym: symbol, ts, oi, chg: oiChangePct, fr: prevFr, lr: prevLr, sr: prevSr },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }

    // RingBuffer 업데이트 — OI + 이전 펀딩비/롱숏비 유지
    const prev = this._lastDeriv.get(symbol) || {};
    const deriv = {
      ...prev,
      open_interest: oi,
      oi_change_pct: oiChangePct,
      funding_rate: prevFr ?? prev.funding_rate ?? 0,
      long_ratio: prevLr ?? prev.long_ratio ?? 0,
      short_ratio: prevSr ?? prev.short_ratio ?? 0,
    };
    this._lastDeriv.set(symbol, deriv);
    this.ringBuffer?.pushDerivatives(symbol, deriv);
  }

  // ── Long/Short Ratio (5분마다) ──
  async _collectAllLongShort() {
    for (const symbol of this.symbols) {
      try {
        await this._collectLongShort(symbol);
        this.stats.lsCollected++;
      } catch (err) {
        this.stats.errors++;
      }
      await this._sleep(50);
    }
  }

  async _collectLongShort(symbol) {
    const url = `${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return; // 일부 심볼은 이 API 미지원
    const data = await res.json();
    if (!data.length) return;

    const latest = data[0];
    const longRatio = parseFloat(latest.longAccount);
    const shortRatio = parseFloat(latest.shortAccount);
    const ts = new Date(latest.timestamp);

    const conn = await getPool().getConnection();
    try {
      // 최신 행에 롱숏비 UPDATE (별도 행 생성 방지)
      await conn.execute(
        `UPDATE z0_derivatives SET long_ratio = :lr, short_ratio = :sr
         WHERE symbol = :sym AND ts = (SELECT MAX(ts) FROM z0_derivatives WHERE symbol = :sym)`,
        { sym: symbol, lr: longRatio, sr: shortRatio },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }

    // RingBuffer 업데이트 — 롱숏비만 갱신
    const prev = this._lastDeriv.get(symbol) || {};
    const deriv = { ...prev, long_ratio: longRatio, short_ratio: shortRatio };
    this._lastDeriv.set(symbol, deriv);
    this.ringBuffer?.pushDerivatives(symbol, deriv);
  }

  // ── Funding Rate (1시간마다) ──
  async _collectAllFunding() {
    for (const symbol of this.symbols) {
      try {
        await this._collectFunding(symbol);
        this.stats.fundingCollected++;
      } catch (err) {
        this.stats.errors++;
      }
      await this._sleep(50);
    }
  }

  async _collectFunding(symbol) {
    const url = `${FAPI_BASE}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.length) return;

    const fundingRate = parseFloat(data[0].fundingRate);

    // 최신 행에 펀딩비 UPDATE (별도 행 생성 방지)
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `UPDATE z0_derivatives SET funding_rate = :fr
         WHERE symbol = :sym AND ts = (SELECT MAX(ts) FROM z0_derivatives WHERE symbol = :sym)`,
        { sym: symbol, fr: fundingRate },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }

    // RingBuffer 업데이트 — 펀딩비만 갱신
    const prev = this._lastDeriv.get(symbol) || {};
    const deriv = { ...prev, funding_rate: fundingRate };
    this._lastDeriv.set(symbol, deriv);
    this.ringBuffer?.pushDerivatives(symbol, deriv);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
