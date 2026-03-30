/**
 * @module 바이낸스 선물 마켓 데이터
 * @description Binance USDT-M Futures API의 시장 데이터 조회 및 계좌 설정을 담당한다.
 *
 * ┌──────────────┐      ┌──────────────┐
 * │ Binance      │ ───→ │ Binance      │
 * │ Market       │      │ API          │
 * └──────────────┘      └──────────────┘
 *
 * @zone z3-exec
 * @dependencies logger.js, crypto
 */

import { logger } from "../shared/logger.js";
import crypto from 'crypto';

export class BinanceFuturesMarket {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || '';
    this.apiSecret = opts.apiSecret || '';
    this.testnet = opts.testnet !== false;
    this.baseUrl = this.testnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    // 심볼별 수량 정밀도 캐시
    this._symbolInfo = new Map(); // symbol → { stepSize, pricePrecision, minQty, minNotional }
    this._infoLoaded = false;
  }

  // ── 계좌/시장 정보 ──

  async getAccountInfo() {
    try {
      return await this._signedRequest('GET', '/fapi/v2/account');
    } catch (err) {
      logger.error(`[Binance] getAccountInfo error: ${err.message}`);
      throw err;
    }
  }

  async getBalance() {
    try {
      const balances = await this._signedRequest('GET', '/fapi/v2/balance');
      const usdt = balances.find(b => b.asset === 'USDT');
      return {
        total: parseFloat(usdt?.balance || 0),
        available: parseFloat(usdt?.availableBalance || 0),
        unrealizedPnl: parseFloat(usdt?.crossUnPnl || 0),
      };
    } catch (err) {
      logger.error(`[Binance] getBalance error: ${err.message}`);
      throw err;
    }
  }

  async getPositions(symbol = null) {
    try {
      const params = symbol ? { symbol } : {};
      const positions = await this._signedRequest('GET', '/fapi/v2/positionRisk', params);
      return positions
        .filter(p => parseFloat(p.positionAmt) !== 0)
        .map(p => ({
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
          qty: Math.abs(parseFloat(p.positionAmt)),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit),
          leverage: parseInt(p.leverage),
          marginType: p.marginType,
          liquidationPrice: parseFloat(p.liquidationPrice),
        }));
    } catch (err) {
      logger.error(`[Binance] getPositions error: ${err.message}`);
      throw err;
    }
  }

  // ── 설정 ──

  async setLeverage(symbol, leverage) {
    try {
      return await this._signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (err) {
      logger.error(`[Binance] setLeverage error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  async setMarginType(symbol, marginType = 'ISOLATED') {
    try {
      return await this._signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType });
    } catch (err) {
      // -4046: No need to change margin type
      if (err.message?.includes('-4046')) return null;
      logger.error(`[Binance] setMarginType error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  async setupSymbol(symbol, leverage) {
    try {
      await this.setMarginType(symbol, 'ISOLATED');
      await this.setLeverage(symbol, leverage);
    } catch (err) {
      logger.warn(`[Binance] setupSymbol failed ${symbol}: ${err.message}`);
    }
  }

  // ── 시장 분석 ──

  async estimateSlippage(symbol, quoteQty, side) {
    try {
      const book = await this._fetchOrderBook(symbol);
      const levels = side === 'BUY' ? book.asks : book.bids;
      if (!levels.length) return { slippagePct: 0, depthUsd: 0 };

      const bestPrice = parseFloat(levels[0][0]);
      let { totalCost, totalQty, depthUsd } = this._calculateDepth(levels, quoteQty);

      if (totalQty === 0) return { slippagePct: 100, depthUsd };
      const avgPrice = totalCost / totalQty;
      const slippagePct = Math.abs(avgPrice - bestPrice) / bestPrice * 100;

      return { slippagePct: parseFloat(slippagePct.toFixed(4)), depthUsd: Math.round(depthUsd) };
    } catch (err) {
      logger.error(`[Binance] estimateSlippage error ${symbol}: ${err.message}`);
      return { slippagePct: 0, depthUsd: 0 };
    }
  }

  _calculateDepth(levels, quoteQty) {
    let remaining = quoteQty;
    let totalCost = 0;
    let totalQty = 0;
    let depthUsd = 0;

    for (const [priceStr, qtyStr] of levels) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const levelValue = price * qty;
      depthUsd += levelValue;

      if (remaining > 0) {
        const fill = Math.min(remaining, levelValue);
        totalCost += fill;
        totalQty += fill / price;
        remaining -= fill;
      }
    }
    return { totalCost, totalQty, depthUsd };
  }

  async _fetchOrderBook(symbol) {
    try {
      const url = `${this.baseUrl}/fapi/v1/depth?symbol=${symbol}&limit=20`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`OrderBook fetch failed: ${res.status}`);
      return await res.json();
    } catch (err) {
      logger.error(`[Binance] _fetchOrderBook error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  // ── 유틸리티 ──

  getSymbolInfo(symbol) {
    return this._symbolInfo.get(symbol) || null;
  }

  isReady() {
    return !!this.apiKey && this._infoLoaded;
  }

  _roundQty(symbol, qty) {
    const info = this._symbolInfo.get(symbol);
    if (!info) return parseFloat(qty.toFixed(6));
    const step = info.stepSize;
    const rounded = Math.floor(qty / step) * step;
    const decimals = this._countDecimals(step);
    const result = parseFloat(rounded.toFixed(decimals));
    return Math.max(result, info.minQty);
  }

  _roundPrice(symbol, price) {
    const info = this._symbolInfo.get(symbol);
    if (!info) return parseFloat(price.toFixed(2));
    const tick = info.tickSize;
    const rounded = Math.round(price / tick) * tick;
    const decimals = this._countDecimals(tick);
    return parseFloat(rounded.toFixed(decimals));
  }

  _countDecimals(num) {
    const str = num.toString();
    if (str.includes('.')) return str.split('.')[1].length;
    return 0;
  }

  async _loadExchangeInfo() {
    try {
      const res = await fetch(`${this.baseUrl}/fapi/v1/exchangeInfo`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const data = await res.json();
      this._parseExchangeInfo(data);
      this._infoLoaded = true;
    } catch (err) {
      logger.warn('[Binance] ExchangeInfo load failed:', err.message);
    }
  }

  _parseExchangeInfo(data) {
    for (const sym of (data.symbols || [])) {
      if (sym.status !== 'TRADING') continue;
      const lotFilter = sym.filters?.find(f => f.filterType === 'LOT_SIZE');
      const priceFilter = sym.filters?.find(f => f.filterType === 'PRICE_FILTER');
      const minNotional = sym.filters?.find(f => f.filterType === 'MIN_NOTIONAL');

      this._symbolInfo.set(sym.symbol, {
        stepSize: parseFloat(lotFilter?.stepSize || '0.001'),
        minQty: parseFloat(lotFilter?.minQty || '0.001'),
        tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
        pricePrecision: sym.pricePrecision || 2,
        quantityPrecision: sym.quantityPrecision || 3,
        minNotional: parseFloat(minNotional?.notional || '5'),
      });
    }
  }

  async _signedRequest(method, path, params = {}) {
    try {
      if (!this.apiKey) throw new Error('Binance API key not configured');

      const timestamp = Date.now();
      const queryParams = { ...params, timestamp, recvWindow: 5000 };
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      const signature = crypto.createHmac('sha256', this.apiSecret)
        .update(queryString).digest('hex');

      const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;
      const res = await fetch(url, {
        method,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Binance ${method} ${path}: ${res.status} ${body}`);
      }
      return await res.json();
    } catch (err) {
      logger.error(`[Binance] _signedRequest error ${method} ${path}: ${err.message}`);
      throw err;
    }
  }
}
