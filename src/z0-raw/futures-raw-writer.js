/**
 * Z0 Futures Raw Writer — z0 테이블에 배치 INSERT
 *
 * 배치 전략:
 *   - kline (closed만): 즉시 INSERT
 *   - liquidation: 즉시 INSERT
 *   - trade: 매 1초 배치 INSERT (buy/sell volume 집계 후 kline과 함께 저장)
 *   - depth/markPrice: Ring Buffer만 (DB 미저장)
 */

import { getPool } from '../shared/db.js';

export class FuturesRawWriter {
  constructor(opts = {}) {
    this.flushIntervalMs = opts.flushIntervalMs || 1000;
    this.enabled = opts.enabled !== false;

    // 심볼별 1분 집계 (buy_volume, sell_volume → kline INSERT 시 같이 기록)
    this.volumeAcc = new Map(); // symbol → { buyVol, sellVol, ts }

    this._timer = null;
    this.stats = {
      klinesFlushed: 0,
      liqFlushed: 0,
      derivUpdated: 0,
      errors: 0,
    };
  }

  start() {
    if (!this.enabled) return;
    // 주기적 volume 집계 flush는 kline close 시 처리하므로 별도 타이머 불필요
    console.log('[Z0-Writer] Started');
  }

  stop() {
    console.log(`[Z0-Writer] Stopped (K=${this.stats.klinesFlushed} L=${this.stats.liqFlushed} E=${this.stats.errors})`);
  }

  /** aggTrade → 1분 buy/sell volume 집계 */
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

  /** kline (closed) → z0_price_ohlcv INSERT */
  async onKlineClosed(kline) {
    if (!this.enabled || !kline.isClosed) return;

    // 해당 심볼의 집계된 buy/sell volume 가져오기
    const acc = this.volumeAcc.get(kline.symbol) || { buyVol: 0, sellVol: 0 };
    const buyVol = kline.interval === '1m' ? acc.buyVol : kline.takerBuyVol;
    const sellVol = kline.interval === '1m' ? acc.sellVol : (kline.volume - kline.takerBuyVol);

    // CVD 델타: 매수 - 매도 체결량 (LLM 시장 분석용)
    // cumulative가 아닌 per-kline delta로 저장 → oracle_reader에서 최근 2개 비교로 방향 도출
    const cvdDelta = buyVol - sellVol;

    // 1m kline close 시 집계 리셋
    if (kline.interval === '1m') {
      this.volumeAcc.set(kline.symbol, { buyVol: 0, sellVol: 0 });
    }

    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `INSERT INTO z0_price_ohlcv
           (symbol, timeframe, ts, open_price, high_price, low_price, close_price,
            volume, quote_volume, trade_count, buy_volume, sell_volume, cvd)
           VALUES (:symbol, :tf, :ts, :open, :high, :low, :close,
                   :vol, :qvol, :tc, :bvol, :svol, :cvd)`,
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
            cvd: cvdDelta,
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
        console.error(`[Z0-Writer] Kline error (${kline.symbol} ${kline.interval}):`, err.message);
      }
    }
  }

  /** forceOrder → z0_liquidation_raw INSERT */
  async onLiquidation(liq) {
    if (!this.enabled) return;

    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `INSERT INTO z0_liquidation_raw (symbol, ts, side, price, qty, usd_value)
           VALUES (:symbol, :ts, :side, :price, :qty, :usd)`,
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
      console.error(`[Z0-Writer] Liquidation error (${liq.symbol}):`, err.message);
    }
  }

  /** markPrice → Ring Buffer에만 보관 (DB 미저장, 빈 행 생성 방지) */
  onMarkPrice(mark) {
    // markPrice는 Ring Buffer에서 실시간 조회용으로만 사용
    // DB에는 REST collector가 1분마다 정리된 OI/펀딩비를 저장
  }
}
