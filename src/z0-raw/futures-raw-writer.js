/**
 * @module Futures Raw Writer
 * @description Binance Futures WebSocket에서 수신한 원시 데이터를 Oracle DB에 배치 또는 개별 저장한다.
 *
 * ┌───────────────┐     ┌───────────────────┐     ┌───────────────┐
 * │ WebSocket     │ ──→ │ Futures Raw Writer│ ──→ │ Oracle DB     │
 * │ (Kline, Liq)  │     │                   │     │ (z0_price,...)│
 * └───────────────┘     └───────────────────┘     └───────────────┘
 *                                ↑
 *                        volume 집계 (1m)
 *
 * @zone z0-raw
 * @dependencies db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const queries = loadQueries('z0-raw/futures-raw-writer');

export class FuturesRawWriter {
  constructor(opts = {}) {
    this.flushIntervalMs = opts.flushIntervalMs || 1000;
    this.enabled = opts.enabled !== false;

    // 심볼별 1분 집계 (buy_volume, sell_volume → kline INSERT 시 같이 기록)
    this.volumeAcc = new Map(); // symbol → { buyVol, sellVol }

    this.stats = {
      klinesFlushed: 0,
      liqFlushed: 0,
      errors: 0,
    };
  }

  /**
   * 서비스 시작
   */
  start() {
    if (!this.enabled) return;
    logger.info('[Z0-Writer] Started');
  }

  /**
   * 서비스 종료
   */
  stop() {
    logger.info(`[Z0-Writer] Stopped (K=${this.stats.klinesFlushed} L=${this.stats.liqFlushed} E=${this.stats.errors})`);
  }

  /**
   * aggTrade 데이터를 수집하여 1분 단위 buy/sell volume을 집계한다.
   * @param {Object} trade
   */
  onTrade(trade) {
    if (!this.enabled) return;
    const key = `${trade.symbol}`;
    if (!this.volumeAcc.has(key)) {
      this.volumeAcc.set(key, { buyVol: 0, sellVol: 0 });
    }
    const acc = this.volumeAcc.get(key);
    if (trade.isBuyerMaker) {
      // isBuyerMaker=true → 매도 체결 (seller initiated = taker sell)
      acc.sellVol += trade.qty;
    } else {
      // isBuyerMaker=false → 매수 체결 (buyer initiated = taker buy)
      acc.buyVol += trade.qty;
    }
  }

  /**
   * 확정된 Kline 데이터를 DB에 저장한다.
   * @param {Object} kline
   */
  async onKlineClosed(kline) {
    if (!this.enabled || !kline.isClosed) return;

    try {
      // 해당 심볼의 집계된 buy/sell volume 가져오기
      const acc = this.volumeAcc.get(kline.symbol) || { buyVol: 0, sellVol: 0 };
      const buyVol = kline.interval === '1m' ? acc.buyVol : kline.takerBuyVol;
      const sellVol = kline.interval === '1m' ? acc.sellVol : (kline.volume - kline.takerBuyVol);

      // 1m kline close 시 집계 리셋
      if (kline.interval === '1m') {
        this.volumeAcc.set(kline.symbol, { buyVol: 0, sellVol: 0 });
      }

      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          queries.insertKline,
          {
            symbol: kline.symbol,
            tf: kline.interval,
            ts: new Date(kline.klineCloseTs * 1000),
            open: kline.open,
            high: kline.high,
            low: kline.low,
            close: kline.close,
            vol: kline.volume,
            qvol: kline.quoteVolume,
            tc: kline.tradeCount,
            bvol: buyVol,
            svol: sellVol,
          },
          { autoCommit: true }
        );
        this.stats.klinesFlushed++;
      } finally {
        await conn.close();
      }
    } catch (err) {
      // Duplicate key는 정상 (같은 kline 재수신)
      if (!err.message?.includes('ORA-00001')) {
        this.stats.errors++;
        logger.error(`[Z0-Writer] Kline error (${kline.symbol} ${kline.interval}):`, err.message);
      }
    }
  }

  /**
   * 청산(Liquidation) 데이터를 DB에 저장한다.
   * @param {Object} liq
   */
  async onLiquidation(liq) {
    if (!this.enabled) return;

    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          queries.insertLiquidation,
          {
            symbol: liq.symbol,
            ts: new Date(liq.ts * 1000),
            side: liq.side,
            price: liq.price,
            qty: liq.qty,
            usd: liq.usdValue,
          },
          { autoCommit: true }
        );
        this.stats.liqFlushed++;
      } finally {
        await conn.close();
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z0-Writer] Liquidation error (${liq.symbol}):`, err.message);
    }
  }

  /**
   * markPrice 수신 시 처리 (현재는 DB 저장 안 함)
   * @param {Object} mark
   */
  onMarkPrice(mark) {
    // markPrice는 Ring Buffer에서 실시간 조회용으로만 사용
  }
}
