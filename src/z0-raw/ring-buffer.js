/**
 * Z0 Ring Buffer — 심볼별 고정 크기 순환 버퍼
 * trade: 최근 10,000건, depth: 최신 1건, kline: 타임프레임별 100건
 * derivatives: 최근 100건, markPrice: 최신 1건
 */

class CircularBuffer {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.buf = new Array(maxSize);
    this.head = 0;
    this.count = 0;
  }

  push(item) {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  last() {
    if (this.count === 0) return null;
    const idx = (this.head - 1 + this.maxSize) % this.maxSize;
    return this.buf[idx];
  }

  get length() {
    return this.count;
  }

  /** 최근 N초간 데이터 반환 (ts 기준 필터) */
  filterByTime(cutoffTs) {
    const result = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxSize * 2) % this.maxSize;
      const item = this.buf[idx];
      if (item.ts < cutoffTs) break;
      result.push(item);
    }
    return result.reverse();
  }

  /** 전체 데이터를 시간순으로 반환 */
  toArray() {
    const result = [];
    const start = this.count < this.maxSize ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result.push(this.buf[(start + i) % this.maxSize]);
    }
    return result;
  }
}

export class RingBuffer {
  constructor(tradeSize = 10000, klineSize = 100) {
    this.trades = new Map();       // symbol → CircularBuffer
    this.depths = new Map();       // symbol → 최신 depth
    this.klines = new Map();       // symbol:timeframe → CircularBuffer
    this.derivatives = new Map();  // symbol → CircularBuffer (OI, 펀딩비 등)
    this.markPrices = new Map();   // symbol → 최신 markPrice + 펀딩비 예측
    this.tradeSize = tradeSize;
    this.klineSize = klineSize;

    this.stats = { tradeCount: 0, depthCount: 0, klineCount: 0, derivCount: 0, liqCount: 0 };
  }

  pushTrade(symbol, trade) {
    if (!this.trades.has(symbol)) {
      this.trades.set(symbol, new CircularBuffer(this.tradeSize));
    }
    this.trades.get(symbol).push(trade);
    this.stats.tradeCount++;
  }

  pushDepth(symbol, depth) {
    this.depths.set(symbol, depth);
    this.stats.depthCount++;
  }

  pushKline(symbol, kline) {
    const key = `${symbol}:${kline.interval}`;
    if (!this.klines.has(key)) {
      this.klines.set(key, new CircularBuffer(this.klineSize));
    }
    this.klines.get(key).push(kline);
    this.stats.klineCount++;
  }

  pushDerivatives(symbol, data) {
    if (!this.derivatives.has(symbol)) {
      this.derivatives.set(symbol, new CircularBuffer(100));
    }
    this.derivatives.get(symbol).push(data);
    this.stats.derivCount++;
  }

  pushMarkPrice(symbol, data) {
    this.markPrices.set(symbol, data);
  }

  // ── 조회 ──

  getLastPrice(symbol) {
    const buf = this.trades.get(symbol);
    if (!buf || buf.length === 0) return null;
    return buf.last().price;
  }

  getTradesWindow(symbol, seconds) {
    const buf = this.trades.get(symbol);
    if (!buf) return [];
    const cutoff = Date.now() / 1000 - seconds;
    return buf.filterByTime(cutoff);
  }

  getDepth(symbol) {
    return this.depths.get(symbol) || null;
  }

  getLastKline(symbol, timeframe = '1m') {
    const key = `${symbol}:${timeframe}`;
    const buf = this.klines.get(key);
    if (!buf || buf.length === 0) return null;
    return buf.last();
  }

  getKlines(symbol, timeframe = '1m') {
    const key = `${symbol}:${timeframe}`;
    const buf = this.klines.get(key);
    if (!buf) return [];
    return buf.toArray();
  }

  getLastDerivatives(symbol) {
    const buf = this.derivatives.get(symbol);
    if (!buf || buf.length === 0) return null;
    return buf.last();
  }

  getMarkPrice(symbol) {
    return this.markPrices.get(symbol) || null;
  }

  /** 현재 시장 스냅샷 (룰엔진/LLM용) */
  getSnapshot(symbol) {
    const price = this.getLastPrice(symbol);
    const depth = this.getDepth(symbol);
    const deriv = this.getLastDerivatives(symbol);
    const mark = this.getMarkPrice(symbol);
    const kline1h = this.getLastKline(symbol, '1h');

    return {
      symbol,
      price,
      depth,
      derivatives: deriv,
      markPrice: mark,
      kline1h,
      ts: Date.now() / 1000,
    };
  }
}
