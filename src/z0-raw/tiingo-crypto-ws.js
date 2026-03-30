/**
 * @module Tiingo 크립토 WebSocket
 * @description Tiingo API를 통해 여러 거래소의 실시간 암호화폐 가격 데이터를 수집한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Tiingo   │ ──→ │ Tiingo   │ ──→ │ Price    │
 * │ WS API   │     │ Crypto WS│     │ Cache    │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↓
 *                market-guards
 *                (거래소 간 가격 괴리 감시)
 *
 * @zone z0-raw
 * @dependencies logger.js, config.js, ws
 */

import WebSocket from 'ws';
import { logger } from "../shared/logger.js";
import { config } from '../shared/config.js';

const WS_URL = 'wss://api.tiingo.com/crypto';
const API_KEY = config.tiingo.apiKey;

/**
 * Tiingo 심볼 형식으로 변환: btcusd, ethusd (소문자, USD 페어)
 * @param {string} symbol 
 * @returns {string}
 */
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

  /**
   * WebSocket 연결 시작
   */
  start() {
    if (!API_KEY) {
      logger.info('[Z0-Tiingo] No API key, skipping crypto WS');
      return;
    }
    this.running = true;
    this._connect();
  }

  /**
   * WebSocket 연결 중지
   */
  stop() {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info(`[Z0-Tiingo] Stopped (msgs=${this.stats.messages} trades=${this.stats.trades} quotes=${this.stats.quotes})`);
  }

  /**
   * 특정 심볼의 멀티 거래소 가격 조회
   */
  getMultiExchangePrices(symbol) {
    const ticker = toTiingoTicker(symbol);
    return this.prices.get(ticker) || {};
  }

  /**
   * 거래소 간 가격 스프레드 계산 (차익거래 기회 감지)
   */
  getExchangeSpread(symbol) {
    const prices = this.getMultiExchangePrices(symbol);
    const entries = Object.values(prices).filter(p => p.last > 0);
    if (entries.length < 2) return null;
    
    const sorted = entries.map(p => p.last).sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const spreadPct = ((max - min) / min) * 100;
    
    return { min, max, spreadPct, exchangeCount: entries.length };
  }

  /**
   * WebSocket 연결 및 이벤트 핸들러 등록
   * @private
   */
  _connect() {
    if (!this.running) return;

    logger.info(`[Z0-Tiingo] Connecting to crypto WS (attempt ${this.attempt + 1})...`);
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => this._onOpen(ws));
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => { if (this.running) this._retry(); });
    ws.on('error', (err) => {
      this.stats.errors++;
      logger.error(`[Z0-Tiingo] WS error: ${err.message}`);
    });

    this.ws = ws;
  }

  /**
   * WebSocket 연결 시 구독 메시지 전송
   * @private
   */
  _onOpen(ws) {
    this.attempt = 0;
    this.retryDelay = 2000;

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
    logger.info(`[Z0-Tiingo] Crypto WS connected, subscribing ${tickers.length} tickers`);
  }

  /**
   * WebSocket 메시지 수신 핸들러
   * @private
   */
  _onMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      this.stats.messages++;
      this._handleMessage(msg);
    } catch (err) {
      // ignore parse errors
    }
  }

  /**
   * 메시지 타입에 따른 처리
   * @private
   */
  _handleMessage(msg) {
    if (!msg.messageType || msg.messageType !== 'A' || !msg.data) return;

    const data = msg.data;
    if (!Array.isArray(data) || data.length < 6) return;

    const updateType = data[0]; // 'T' = trade, 'Q' = quote
    const ticker = data[1];     // e.g., 'btcusd'
    const exchange = data[3];   // e.g., 'binance', 'coinbase'

    if (!this.prices.has(ticker)) {
      this.prices.set(ticker, {});
    }
    const exchangePrices = this.prices.get(ticker);

    if (updateType === 'T') {
      this._handleTradeUpdate(ticker, exchange, data, exchangePrices);
    } else if (updateType === 'Q') {
      this._handleQuoteUpdate(ticker, exchange, data, exchangePrices);
    }

    if (this.onPriceUpdate) {
      this.onPriceUpdate(ticker, exchange, exchangePrices[exchange]);
    }
  }

  /**
   * 거래 데이터 처리
   * @private
   */
  _handleTradeUpdate(ticker, exchange, data, exchangePrices) {
    const lastPrice = data[4];
    const volume = data[5];
    
    exchangePrices[exchange] = {
      ...(exchangePrices[exchange] || {}),
      last: lastPrice,
      volume,
      ts: Date.now() / 1000,
    };
    this.stats.trades++;
  }

  /**
   * 호가 데이터 처리
   * @private
   */
  _handleQuoteUpdate(ticker, exchange, data, exchangePrices) {
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

  /**
   * 재연결 로직
   * @private
   */
  _retry() {
    this.attempt++;
    if (this.attempt > 50) {
      logger.error('[Z0-Tiingo] Max retries exceeded');
      return;
    }
    setTimeout(() => this._connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60000);
  }
}
