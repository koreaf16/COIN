/**
 * Z0 Stablecoin Supply — CoinGecko (무료, 30req/분)
 *
 * USDT/USDC 시가총액 변화 → 시장 자금 유입/유출 추적
 * 시가총액 증가 = 새 자금 유입 = 매수 압력 예고
 * 주기: 30분 (CoinGecko 무료 제한 고려)
 */

import { getPool } from '../shared/db.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export class StablecoinCollector {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 30) * 60 * 1000;
    this._timer = null;
    this.current = { usdtMcap: 0, usdcMcap: 0, totalMcap: 0 };
    this.stats = { fetched: 0, errors: 0 };
  }

  start() {
    this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    console.log(`[Z0-Stable] Stablecoin supply started (interval=${this.intervalMs / 60000}min)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  getData() { return { ...this.current }; }

  async _fetch() {
    try {
      const url = `${COINGECKO_BASE}/simple/price?ids=tether,usd-coin&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'COIN-Trading-System/2.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { this.stats.errors++; return; }

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

      // DB 저장
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `INSERT INTO z0_stablecoin_supply (ts, usdt_mcap, usdc_mcap, total_mcap, usdt_change_24h, usdc_change_24h)
           VALUES (SYSTIMESTAMP, :usdt, :usdc, :total, :usdtChg, :usdcChg)`,
          {
            usdt: this.current.usdtMcap,
            usdc: this.current.usdcMcap,
            total: this.current.totalMcap,
            usdtChg: this.current.usdtChange24h,
            usdcChg: this.current.usdcChange24h,
          },
          { autoCommit: true }
        );
      } finally {
        await conn.close();
      }

      const totalB = (this.current.totalMcap / 1e9).toFixed(1);
      console.log(`[Z0-Stable] USDT+USDC: $${totalB}B (USDT ${this.current.usdtChange24h > 0 ? '+' : ''}${this.current.usdtChange24h.toFixed(2)}%)`);
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 5 === 1) {
        console.warn('[Z0-Stable] Fetch error:', err.message);
      }
    }
  }
}
