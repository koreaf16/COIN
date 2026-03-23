/**
 * Z0 Tiingo Crypto WebSocket — Pro 실시간 크립토 가격
 *
 * Tiingo 크립토 WebSocket은 다수 거래소(Binance, Coinbase, Kraken 등) 집계 데이터 제공.
 * Binance Futures WS와 교차검증 + 다른 거래소 가격 차이 감지용.
 *
 * WebSocket URL: wss://api.tiingo.com/crypto
 * thresholdLevel: 5 = 모든 Top-of-Book 업데이트
 *
 * Pro 기능: 더 높은 메시지 한도, 모든 거래소 커버리지
 */

import WebSocket from 'ws';
import { config } from '../shared/config.js';

const WS_URL = 'wss://api.tiingo.com/crypto';
const API_KEY = config.tiingo.apiKey;

// Tiingo 심볼 형식: btcusd, ethusd (소문자, USD 페어)
function toTiingoTicker(symbol) {
  return symbol.toLowerCase().replace('usdt', 'usd');
}

export class TiingoCryptoWs {
  constructor(symbols, opts = {}) {
    this.symbols = symbols;
    this.thresholdLevel = opts.thresholdLevel || 5;
    this.ws = null;
    this.running = false;
    this.retryDelay = 2000;
    this.attempt = 0;
    this.stats = { messages: 0, trades: 0, quotes: 0, errors: 0 };

    // 심볼별 멀티 거래소 가격 캐시
    this.prices = new Map(); // tiingoTicker → { exchange → { last, bid, ask, ts } }
    this.onPriceUpdate = opts.onPriceUpdate || null;
  }

  start() {
    if (!API_KEY) {
      console.log('[Z0-Tiingo] No API key, skipping crypto WS');
      return;
    }
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.ws) { this.ws.close(); this.ws = null; }
    console.log(`[Z0-Tiingo] Stopped (msgs=${this.stats.messages} trades=${this.stats.trades} quotes=${this.stats.quotes})`);
  }

  /** 특정 심볼의 멀티 거래소 가격 조회 */
  getMultiExchangePrices(symbol) {
    const ticker = toTiingoTicker(symbol);
    return this.prices.get(ticker) || {};
  }

  /** 거래소 간 가격 스프레드 계산 (차익거래 기회 감지) */
  getExchangeSpread(symbol) {
    const prices = this.getMultiExchangePrices(symbol);
    const entries = Object.values(prices).filter(p => p.last > 0);
    if (entries.length < 2) return null;
    const sorted = entries.map(p => p.last).sort((a, b) => a - b);
    const spreadPct = ((sorted[sorted.length - 1] - sorted[0]) / sorted[0]) * 100;
    return { min: sorted[0], max: sorted[sorted.length - 1], spreadPct, exchangeCount: entries.length };
  }

  _connect() {
    if (!this.running) return;

    console.log(`[Z0-Tiingo] Connecting to crypto WS (attempt ${this.attempt + 1})...`);
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      this.attempt = 0;
      this.retryDelay = 2000;

      // 구독 메시지
      const tickers = this.symbols.map(toTiingoTicker);
      const subMsg = {
        eventName: 'subscribe',
        authorization: API_KEY,
        eventData: {
          thresholdLevel: this.thresholdLevel,
          tickers,
        },
      };
      ws.send(JSON.stringify(subMsg));
      console.log(`[Z0-Tiingo] Crypto WS connected, subscribing ${tickers.length} tickers`);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this.stats.messages++;
        this._handleMessage(msg);
      } catch {}
    });

    ws.on('close', (code) => {
      if (this.running) this._retry();
    });

    ws.on('error', (err) => {
      this.stats.errors++;
      console.error(`[Z0-Tiingo] WS error: ${err.message}`);
    });

    this.ws = ws;
  }

  _handleMessage(msg) {
    // Tiingo WS 메시지 형식:
    // messageType: 'A' (trade/quote), 'H' (heartbeat), 'I' (info)
    if (!msg.messageType) return;

    if (msg.messageType === 'A' && msg.data) {
      // data: [messageType, ticker, date, exchange, last, volume, ...]
      // Trade update: data[0] = 'T', Quote update: data[0] = 'Q'
      const data = msg.data;
      if (!Array.isArray(data) || data.length < 6) return;

      const updateType = data[0]; // 'T' = trade, 'Q' = quote
      const ticker = data[1];     // e.g., 'btcusd'
      const exchange = data[3];   // e.g., 'binance', 'coinbase'
      const lastPrice = data[4];
      const volume = data[5];

      if (!this.prices.has(ticker)) this.prices.set(ticker, {});
      const exchangePrices = this.prices.get(ticker);

      if (updateType === 'T') {
        // Trade update
        exchangePrices[exchange] = {
          last: lastPrice,
          volume,
          ts: Date.now() / 1000,
          ...(exchangePrices[exchange] || {}),
          last: lastPrice,
        };
        this.stats.trades++;
      } else if (updateType === 'Q') {
        // Quote update — data: [Q, ticker, date, exchange, bidSize, bidPrice, midPrice, askSize, askPrice]
        const bidPrice = data[5];
        const askPrice = data[8];
        exchangePrices[exchange] = {
          ...(exchangePrices[exchange] || {}),
          bid: bidPrice,
          ask: askPrice,
          spread: askPrice - bidPrice,
          ts: Date.now() / 1000,
        };
        this.stats.quotes++;
      }

      if (this.onPriceUpdate) {
        this.onPriceUpdate(ticker, exchange, exchangePrices[exchange]);
      }
    }
  }

  _retry() {
    this.attempt++;
    if (this.attempt > 50) {
      console.error('[Z0-Tiingo] Max retries exceeded');
      return;
    }
    setTimeout(() => this._connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60000);
  }
}
