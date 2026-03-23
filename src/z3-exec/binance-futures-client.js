/**
 * Z3 Binance Futures Client — USDT-M Futures API
 *
 * Testnet: https://testnet.binancefuture.com  (모의거래)
 * Mainnet: https://fapi.binance.com           (실전)
 *
 * .env.local에서 BINANCE_TESTNET=true/false 로 전환.
 * API 키만 교체하면 바로 실전 투입 가능.
 */

import crypto from 'crypto';

export class BinanceFuturesClient {
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

  /** 서버 시작 시 1회 호출 — 심볼 정보 로드 */
  async init() {
    if (!this.apiKey) {
      console.log('[Binance] No API key — exchange calls disabled');
      return;
    }
    await this._loadExchangeInfo();
    console.log(`[Binance] Init complete (${this.testnet ? 'TESTNET' : 'MAINNET'}, ${this._symbolInfo.size} symbols)`);
  }

  // ── 계좌 ──

  async getAccountInfo() {
    return this._signedRequest('GET', '/fapi/v2/account');
  }

  async getBalance() {
    const balances = await this._signedRequest('GET', '/fapi/v2/balance');
    const usdt = balances.find(b => b.asset === 'USDT');
    return {
      total: parseFloat(usdt?.balance || 0),
      available: parseFloat(usdt?.availableBalance || 0),
      unrealizedPnl: parseFloat(usdt?.crossUnPnl || 0),
    };
  }

  async getPositions(symbol = null) {
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
  }

  // ── 설정 ──

  async setLeverage(symbol, leverage) {
    return this._signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  async setMarginType(symbol, marginType = 'ISOLATED') {
    try {
      return await this._signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType });
    } catch (err) {
      // -4046: No need to change margin type
      if (err.message?.includes('-4046')) return null;
      throw err;
    }
  }

  /** 심볼 초기 설정 (레버리지 + 격리마진) */
  async setupSymbol(symbol, leverage) {
    await this.setMarginType(symbol, 'ISOLATED');
    await this.setLeverage(symbol, leverage);
  }

  // ── 주문 ──

  /** 시장가 진입 */
  async marketOrder(symbol, side, qty) {
    const roundedQty = this._roundQty(symbol, qty);
    if (!roundedQty || roundedQty <= 0) {
      throw new Error(`Invalid qty for ${symbol}: ${qty} → ${roundedQty}`);
    }

    const result = await this._signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,                    // 'BUY' or 'SELL'
      type: 'MARKET',
      quantity: roundedQty,
    });

    return {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      type: result.type,
      status: result.status,
      avgPrice: parseFloat(result.avgPrice || 0),
      executedQty: parseFloat(result.executedQty || 0),
      cumQuote: parseFloat(result.cumQuote || 0),
    };
  }

  /** 지정가 주문 */
  async limitOrder(symbol, side, qty, price, timeInForce = 'GTC') {
    const roundedQty = this._roundQty(symbol, qty);
    const roundedPrice = this._roundPrice(symbol, price);

    const result = await this._signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      quantity: roundedQty,
      price: roundedPrice,
      timeInForce,
    });

    return {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      status: result.status,
      price: parseFloat(result.price),
    };
  }

  /** 스탑마켓 (안전망 손절) */
  async stopMarketOrder(symbol, side, qty, stopPrice) {
    const roundedQty = this._roundQty(symbol, qty);
    const roundedStop = this._roundPrice(symbol, stopPrice);

    const result = await this._signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'STOP_MARKET',
      quantity: roundedQty,
      stopPrice: roundedStop,
      closePosition: 'false',
      reduceOnly: 'true',  // [Bug#6] 리버스 포지션 방지
    });

    return {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      status: result.status,
      stopPrice: parseFloat(result.stopPrice),
    };
  }

  /** 테이크프로핏 마켓 */
  async takeProfitMarketOrder(symbol, side, qty, stopPrice) {
    const roundedQty = this._roundQty(symbol, qty);
    const roundedStop = this._roundPrice(symbol, stopPrice);

    const result = await this._signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      quantity: roundedQty,
      stopPrice: roundedStop,
      closePosition: 'false',
      reduceOnly: 'true',  // [Bug#6] 리버스 포지션 방지
    });

    return { orderId: result.orderId, status: result.status };
  }

  /** 포지션 전량 청산 (반대 방향 시장가) */
  async closePosition(symbol, side, qty) {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const roundedQty = this._roundQty(symbol, qty);
    if (!roundedQty || roundedQty <= 0) {
      throw new Error(`Invalid close qty for ${symbol}: ${qty} → ${roundedQty}`);
    }
    const result = await this._signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: roundedQty,
      reduceOnly: 'true',
    });
    return {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      status: result.status,
      avgPrice: parseFloat(result.avgPrice || 0),
      executedQty: parseFloat(result.executedQty || 0),
    };
  }

  /** 심볼의 모든 미체결 주문 취소 */
  async cancelAllOrders(symbol) {
    return this._signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  }

  /** 주문 상태 조회 */
  async getOrder(symbol, orderId) {
    const result = await this._signedRequest('GET', '/fapi/v1/order', { symbol, orderId });
    return {
      orderId: result.orderId,
      status: result.status,
      avgPrice: parseFloat(result.avgPrice || 0),
      executedQty: parseFloat(result.executedQty || 0),
    };
  }

  /** 미체결 주문 목록 */
  async getOpenOrders(symbol = null) {
    const params = symbol ? { symbol } : {};
    return this._signedRequest('GET', '/fapi/v1/openOrders', params);
  }

  // ── 수량/가격 정밀도 ──

  _roundQty(symbol, qty) {
    const info = this._symbolInfo.get(symbol);
    if (!info) return parseFloat(qty.toFixed(6));
    const step = info.stepSize;
    const rounded = Math.floor(qty / step) * step;
    const decimals = this._countDecimals(step);
    return parseFloat(rounded.toFixed(decimals));
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
      this._infoLoaded = true;
    } catch (err) {
      console.warn('[Binance] ExchangeInfo load failed:', err.message);
    }
  }

  getSymbolInfo(symbol) {
    return this._symbolInfo.get(symbol) || null;
  }

  isReady() {
    return !!this.apiKey && this._infoLoaded;
  }

  // ── HTTP ──

  async _signedRequest(method, path, params = {}) {
    if (!this.apiKey) throw new Error('Binance API key not configured');

    const timestamp = Date.now();
    const queryParams = { ...params, timestamp, recvWindow: 5000 };
    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const signature = crypto.createHmac('sha256', this.apiSecret)
      .update(queryString).digest('hex');

    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;

    const fetchOpts = {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
      signal: AbortSignal.timeout(10000),
    };

    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance ${method} ${path}: ${res.status} ${body}`);
    }
    return res.json();
  }
}
