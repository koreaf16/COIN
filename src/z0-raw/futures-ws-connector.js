/**
 * Z0 Futures WebSocket Connector — Binance USDT-M Futures Combined Stream
 * 재연결 로직 (지수 백오프, 최대 60초)
 *
 * 스트림:
 *   - aggTrade: 체결 데이터 (CVD 계산용)
 *   - kline: 1m/5m/1h/4h/1d 멀티 타임프레임
 *   - depth20@100ms: 호가창 (Ring Buffer만)
 *   - markPrice@1s: 마크가격 + 펀딩비 예측
 *   - forceOrder: 실시간 청산
 *
 * Binance 제한: 하나의 connection에 최대 1024 streams
 * 30심볼 × 9스트림 = 270 스트림 → 1 connection으로 충분
 */

import WebSocket from 'ws';

const WS_BASE = 'wss://fstream.binance.com';
const KLINE_TIMEFRAMES = ['1m', '5m', '1h', '4h', '1d'];

export class FuturesWsConnector {
  constructor(symbols, { onTrade, onKline, onDepth, onMarkPrice, onLiquidation, onStatus }) {
    this.symbols = symbols;
    this.onTrade = onTrade || (() => {});
    this.onKline = onKline || (() => {});
    this.onDepth = onDepth || (() => {});
    this.onMarkPrice = onMarkPrice || (() => {});
    this.onLiquidation = onLiquidation || (() => {});
    this.onStatus = onStatus || (() => {});

    this.ws = null;
    this.retryDelay = 1000;
    this.maxRetries = 100;
    this.attempt = 0;
    this.running = false;
    this.messageCount = 0;
  }

  async start() {
    this.running = true;
    this.attempt = 0;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** 심볼 동적 교체 — stop → 심볼 변경 → 재연결 */
  updateSymbols(newSymbols) {
    const prev = this.symbols.length;
    this.symbols = newSymbols;
    console.log(`[Z0-WS] Symbol update: ${prev} → ${newSymbols.length} symbols, reconnecting...`);
    this.stop();
    this.running = true;
    this.attempt = 0;
    this._connect();
  }

  _buildStreams() {
    const streams = [];
    for (const s of this.symbols) {
      const sl = s.toLowerCase();
      // aggTrade: 체결
      streams.push(`${sl}@aggTrade`);
      // kline: 멀티 타임프레임
      for (const tf of KLINE_TIMEFRAMES) {
        streams.push(`${sl}@kline_${tf}`);
      }
      // depth: 호가창
      streams.push(`${sl}@depth20@100ms`);
      // markPrice: 마크가격 + 펀딩비
      streams.push(`${sl}@markPrice@1s`);
      // forceOrder: 청산
      streams.push(`${sl}@forceOrder`);
    }
    return streams;
  }

  _connect() {
    if (!this.running) return;

    const streams = this._buildStreams();
    const url = `${WS_BASE}/stream?streams=${streams.join('/')}`;

    this.onStatus('connecting', { attempt: this.attempt + 1, streamCount: streams.length });
    const ws = new WebSocket(url);

    ws.on('open', () => {
      this.attempt = 0;
      this.retryDelay = 1000;
      this.onStatus('connected', { symbols: this.symbols.length, streams: streams.length });
      console.log(`[Z0] Futures WS connected (${this.symbols.length} symbols, ${streams.length} streams)`);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this.messageCount++;
        this._dispatch(msg);
      } catch (err) {
        // JSON 파싱 에러 무시
      }
    });

    ws.on('close', (code) => {
      this.onStatus('disconnected', { code });
      if (this.running) this._retry();
    });

    ws.on('error', (err) => {
      console.error(`[Z0] Futures WS error: ${err.code || ''} ${err.message}`);
      this.onStatus('error', { message: err.message });
    });

    // ping/pong keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);
    ws.on('close', () => clearInterval(pingInterval));

    this.ws = ws;
  }

  _dispatch(msg) {
    const { stream, data } = msg;
    if (!stream || !data) return;

    const atIdx = stream.indexOf('@');
    const symbolRaw = stream.slice(0, atIdx);
    const symbol = symbolRaw.toUpperCase();
    const streamType = stream.slice(atIdx + 1);

    if (streamType === 'aggTrade') {
      this.onTrade(this._normalizeTrade(symbol, data));
    } else if (streamType.startsWith('kline_')) {
      const kline = this._normalizeKline(symbol, data);
      this.onKline(kline);
    } else if (streamType.startsWith('depth')) {
      this.onDepth(this._normalizeDepth(symbol, data));
    } else if (streamType.startsWith('markPrice')) {
      this.onMarkPrice(this._normalizeMarkPrice(symbol, data));
    } else if (streamType === 'forceOrder') {
      this.onLiquidation(this._normalizeLiquidation(symbol, data));
    }
  }

  _normalizeTrade(symbol, d) {
    const qty = parseFloat(d.q);
    const price = parseFloat(d.p);
    return {
      type: 'trade',
      symbol,
      ts: d.T / 1000,
      price,
      qty,
      isBuyerMaker: d.m,  // true = 매도체결(seller initiated)
      tradeId: d.a,        // aggTrade ID
      usdValue: price * qty,
    };
  }

  _normalizeKline(symbol, d) {
    const k = d.k;
    return {
      type: 'kline',
      symbol,
      ts: d.E / 1000,
      klineOpenTs: k.t / 1000,
      klineCloseTs: k.T / 1000,
      interval: k.i,
      isClosed: k.x,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      quoteVolume: parseFloat(k.q),
      tradeCount: k.n,
      takerBuyVol: parseFloat(k.V),
      takerBuyQuote: parseFloat(k.Q),
    };
  }

  _normalizeDepth(symbol, d) {
    return {
      type: 'depth',
      symbol,
      ts: Date.now() / 1000,
      bids: d.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: d.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    };
  }

  _normalizeMarkPrice(symbol, d) {
    return {
      type: 'markPrice',
      symbol,
      ts: d.E / 1000,
      markPrice: parseFloat(d.p),
      indexPrice: parseFloat(d.i),
      fundingRate: parseFloat(d.r),           // 현재 펀딩비
      nextFundingTime: d.T / 1000,            // 다음 펀딩 시각
    };
  }

  _normalizeLiquidation(symbol, d) {
    const o = d.o;
    const price = parseFloat(o.p);
    const qty = parseFloat(o.q);
    return {
      type: 'liquidation',
      symbol: o.s,
      ts: o.T / 1000,
      side: o.S,         // 'BUY' or 'SELL' — 청산 주문 방향
      price,
      qty,
      usdValue: price * qty,
    };
  }

  _retry() {
    this.attempt++;
    if (this.attempt > this.maxRetries) {
      console.error('[Z0] Max retries exceeded. Giving up.');
      this.onStatus('failed', { attempts: this.attempt });
      return;
    }

    console.log(`[Z0] Reconnecting in ${this.retryDelay / 1000}s (attempt ${this.attempt})...`);
    setTimeout(() => this._connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60000);
  }
}
