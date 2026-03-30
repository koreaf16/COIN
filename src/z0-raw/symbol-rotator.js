/**
 * @module 심볼 로테이터
 * @description Binance 24시간 티커 데이터를 분석하여 유동성과 변동성이 높은 심볼을 정기적으로 선정한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Binance  │ ──→ │ Symbol   │ ──→ │ Trading  │
 * │ Ticker   │     │ Rotator  │     │ Config   │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↓
 *                futures-ws-connector
 *                (구독 심볼 업데이트)
 *
 * @zone z0-raw
 * @dependencies logger.js, config.js
 */

import { logger } from "../shared/logger.js";

const BINANCE_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const ROTATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4시간
const FLEX_COUNT = 10;
const MIN_VOLUME_USD = 150_000_000;  // 최소 일 거래량 $150M (슬리피지 방지)
const MIN_ATR_PCT = 2.5;            // 최소 일 ATR 2.5%

// 제외 목록: 주식/금속/스테이블/USDC 페어/분기 선물
const EXCLUDE_PATTERNS = [
  'USDC', 'BUSD', 'TUSD', 'FDUSD', 'EUR', 'GBP', 'BRL', 'TRY', 'PLN', 'ARS',
  'XAUUSDT', 'XAGUSDT', 'TSLAUSDT', 'INTCUSDT', 'AMZNUSDT', 'COINUSDT',
  'EWYUSDT', 'GOOGLUSDT', 'NVDAUSDT', 'MSFTUSDT', 'AAPLUSDT', 'METAUSDT',
  'PAXGUSDT', 'PLTRUSDT',
];

export class SymbolRotator {
  constructor(config, opts = {}) {
    this.config = config;
    this.getOpenPositionSymbols = opts.getOpenPositionSymbols || (() => []);
    this.onRotation = opts.onRotation || (() => {});
    this._timer = null;
    this.lastRotation = null;
    this.stats = { rotations: 0, errors: 0 };
  }

  /**
   * 로테이션 시작
   */
  async start() {
    try {
      // 시작 30초 후 첫 로테이션 (WS 연결 대기)
      setTimeout(() => this.rotate(), 30_000);
      this._timer = setInterval(() => this.rotate(), ROTATION_INTERVAL_MS);
      logger.info(`[SymbolRotator] Started (every ${ROTATION_INTERVAL_MS / 3600000}h, flex=${FLEX_COUNT})`);
    } catch (err) {
      logger.error(`[SymbolRotator] Start error: ${err.message}`);
    }
  }

  /**
   * 로테이션 중지
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 심볼 로테이션 실행
   */
  async rotate() {
    try {
      const tickers = await this._fetchTickers();
      if (!tickers.length) {
        logger.warn('[SymbolRotator] No ticker data');
        return;
      }

      const coreSet = new Set(this.config.tradingSymbolsCore);
      const openSymbols = new Set(this.getOpenPositionSymbols());

      const scored = this._calculateScores(tickers, coreSet);
      const selected = this._selectSymbols(scored, openSymbols, coreSet);
      
      this._applyRotation(selected, scored);
    } catch (err) {
      this.stats.errors++;
      logger.error(`[SymbolRotator] Rotation error: ${err.message}`);
    }
  }

  /**
   * 티커 데이터를 기반으로 심볼 스코어 계산
   * @private
   */
  _calculateScores(tickers, coreSet) {
    return tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT')) return false;
        if (t.symbol.includes('_')) return false; // 분기 선물 제외
        if (EXCLUDE_PATTERNS.some(p => t.symbol.includes(p))) return false;
        if (coreSet.has(t.symbol)) return false; // Core는 별도
        return true;
      })
      .map(t => {
        const price = parseFloat(t.lastPrice);
        const vol = parseFloat(t.quoteVolume);
        const high = parseFloat(t.highPrice);
        const low = parseFloat(t.lowPrice);
        const atrPct = price > 0 ? ((high - low) / price) * 100 : 0;
        return { symbol: t.symbol, price, vol, atrPct, score: vol * atrPct };
      })
      .filter(t => t.vol >= MIN_VOLUME_USD && t.atrPct >= MIN_ATR_PCT)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 스코어와 오픈 포지션을 고려하여 Flex 심볼 선택
   * @private
   */
  _selectSymbols(scored, openSymbols, coreSet) {
    const selected = new Set();
    // 1) 오픈 포지션 심볼 먼저 확보 (Core가 아닌 것만)
    for (const s of openSymbols) {
      if (!coreSet.has(s)) selected.add(s);
    }
    // 2) 나머지 스코어 순으로 채움
    for (const t of scored) {
      if (selected.size >= FLEX_COUNT) break;
      selected.add(t.symbol);
    }
    return [...selected];
  }

  /**
   * 선택된 심볼을 설정에 적용하고 알림
   * @private
   */
  _applyRotation(newFlex, scored) {
    const { added, removed } = this.config.updateFlexSymbols(newFlex);

    this.lastRotation = {
      ts: new Date().toISOString(),
      flex: newFlex,
      total: this.config.tradingSymbols.length,
      topScored: scored.slice(0, 15).map(t => ({
        symbol: t.symbol, 
        score: Math.round(t.score / 1e6),
        vol: `${(t.vol / 1e6).toFixed(0)}M`, 
        atr: `${t.atrPct.toFixed(1)}%`,
      })),
    };

    this.stats.rotations++;

    if (added.length || removed.length) {
      logger.info(`[SymbolRotator] 로테이션 #${this.stats.rotations} — Flex: ${newFlex.join(', ')}`);
      this.onRotation(this.config.tradingSymbols, { added, removed });
    } else {
      logger.info(`[SymbolRotator] 로테이션 #${this.stats.rotations} — 변경 없음 (${this.config.tradingSymbols.length}개 유지)`);
    }
  }

  /**
   * Binance API에서 티커 데이터 조회
   * @private
   */
  async _fetchTickers() {
    try {
      const res = await fetch(BINANCE_TICKER_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      logger.error(`[SymbolRotator] Fetch failed: ${err.message}`);
      return [];
    }
  }

  /** API 엔드포인트용 */
  getStatus() {
    return {
      ...this.stats,
      lastRotation: this.lastRotation,
      core: this.config.tradingSymbolsCore,
      flex: this.config.tradingSymbolsFlex,
      total: this.config.tradingSymbols,
    };
  }
}
