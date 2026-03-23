/**
 * Z0 On-chain Collector — CryptoQuant API
 *
 * 수집 항목:
 *   - 거래소 입출금량 (Exchange Inflow/Outflow)
 *   - 거래소 순유출 (Netflow)
 *   - 거래소 보유량 (Reserve)
 *   - 고래 비율 (Exchange Whale Ratio)
 *   - 스테이블코인 공급량
 *
 * API: https://api.cryptoquant.com/v1/
 * Auth: Bearer token
 */

import { config } from '../shared/config.js';
import { getPool } from '../shared/db.js';

const API_KEY = config.cryptoquant.apiKey;
const BASE_URL = 'https://api.cryptoquant.com/v1';

// CryptoQuant 심볼 매핑
const SUPPORTED_ASSETS = {
  BTCUSDT: 'btc',
  ETHUSDT: 'eth',
};

export class OnchainCollector {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 10) * 60 * 1000;  // 10분
    this._timer = null;
    this.stats = { fetched: 0, errors: 0 };
    this.latestData = new Map(); // symbol → onchain data
  }

  start() {
    if (!API_KEY) {
      console.log('[Z0-Onchain] CryptoQuant API key not set, skipping');
      return;
    }
    this._fetchAll();
    this._timer = setInterval(() => this._fetchAll(), this.intervalMs);
    console.log(`[Z0-Onchain] CryptoQuant started (interval=${this.intervalMs / 60000}min)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    console.log(`[Z0-Onchain] Stopped (fetched=${this.stats.fetched}, errors=${this.stats.errors})`);
  }

  getData(symbol) {
    return this.latestData.get(symbol) || null;
  }

  async _fetchAll() {
    for (const [symbol, asset] of Object.entries(SUPPORTED_ASSETS)) {
      try {
        const data = await this._fetchAsset(asset);
        if (data) {
          data.symbol = symbol;
          this.latestData.set(symbol, data);
          await this._saveToDB(data);
          this.stats.fetched++;
        }
      } catch (err) {
        this.stats.errors++;
        if (this.stats.errors % 5 === 1) {
          console.warn(`[Z0-Onchain] ${symbol} error:`, err.message);
        }
      }
      await new Promise(r => setTimeout(r, 1000)); // rate limit
    }
  }

  async _fetchAsset(asset) {
    const data = {};

    // 거래소 Netflow
    const netflow = await this._apiCall(`/${asset}/exchange-flows/netflow`, { window: 'hour', limit: 1 });
    if (netflow?.result?.data?.[0]) {
      const d = netflow.result.data[0];
      data.net_flow = d.netflow ?? d.value ?? 0;
    }

    // 거래소 Reserve
    const reserve = await this._apiCall(`/${asset}/exchange-flows/reserve`, { window: 'hour', limit: 1 });
    if (reserve?.result?.data?.[0]) {
      data.exchange_reserve = reserve.result.data[0].reserve ?? reserve.result.data[0].value ?? 0;
    }

    // 거래소 Inflow/Outflow
    const inflow = await this._apiCall(`/${asset}/exchange-flows/inflow`, { window: 'hour', limit: 1 });
    if (inflow?.result?.data?.[0]) {
      data.exchange_inflow = inflow.result.data[0].inflow ?? inflow.result.data[0].value ?? 0;
    }

    const outflow = await this._apiCall(`/${asset}/exchange-flows/outflow`, { window: 'hour', limit: 1 });
    if (outflow?.result?.data?.[0]) {
      data.exchange_outflow = outflow.result.data[0].outflow ?? outflow.result.data[0].value ?? 0;
    }

    // Exchange Whale Ratio
    const whale = await this._apiCall(`/${asset}/flow-indicator/exchange-whale-ratio`, { window: 'hour', limit: 1 });
    if (whale?.result?.data?.[0]) {
      data.whale_ratio = whale.result.data[0].exchange_whale_ratio ?? whale.result.data[0].value ?? 0;
    }

    return Object.keys(data).length > 0 ? data : null;
  }

  async _apiCall(path, params = {}) {
    const query = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    const url = `${BASE_URL}${path}?${query}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 5000)); // rate limit 대기
        return null;
      }
      throw new Error(`CQ ${res.status} ${path}`);
    }
    return res.json();
  }

  async _saveToDB(data) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z0_onchain
         (symbol, ts, exchange_inflow, exchange_outflow, net_flow,
          exchange_reserve, whale_ratio, source)
         VALUES (:sym, SYSTIMESTAMP, :inflow, :outflow, :netflow,
                 :reserve, :whale, 'cryptoquant')`,
        {
          sym: data.symbol,
          inflow: data.exchange_inflow || 0,
          outflow: data.exchange_outflow || 0,
          netflow: data.net_flow || 0,
          reserve: data.exchange_reserve || 0,
          whale: data.whale_ratio || 0,
        },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
  }
}
