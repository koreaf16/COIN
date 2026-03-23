/**
 * Z4 Trade Recorder — 포지션/거래 DB 기록
 *
 * EXIT 시 1초봉 데이터 캡처:
 *   - 즉시: 진입 5분전 ~ 청산 시점까지 캡처
 *   - 5분 후: 청산 후 5분 데이터 추가 캡처하여 최종 저장
 */

import { getPool } from '../shared/db.js';

export class TradeRecorder {
  constructor() {
    this.stats = { entriesRecorded: 0, exitsRecorded: 0, errors: 0 };
    this.ringBuffer = null; // main에서 주입
  }

  /**
   * ringBuffer 체결 데이터 → 1초봉 배열 변환
   */
  _buildCandles1s(trades) {
    if (!trades.length) return [];
    const buckets = new Map();
    for (const t of trades) {
      const sec = Math.floor(t.ts);
      let b = buckets.get(sec);
      if (!b) {
        b = { time: sec, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 };
        buckets.set(sec, b);
      }
      if (t.price > b.high) b.high = t.price;
      if (t.price < b.low) b.low = t.price;
      b.close = t.price;
      b.volume += t.qty;
    }

    const keys = [...buckets.keys()].sort((a, b) => a - b);
    const candles = [];
    let prevClose = buckets.get(keys[0]).open;
    for (let sec = keys[0]; sec <= keys[keys.length - 1]; sec++) {
      const b = buckets.get(sec);
      if (b) { candles.push(b); prevClose = b.close; }
      else candles.push({ time: sec, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
    }
    return candles;
  }

  /**
   * 1초봉 캡처 (진입 5분전 ~ now)
   */
  _captureCandles(symbol, entryTimeSec) {
    if (!this.ringBuffer) return [];
    const nowSec = Date.now() / 1000;
    // 진입 5분전부터 현재까지
    const windowSec = Math.ceil(nowSec - entryTimeSec) + 300;
    const trades = this.ringBuffer.getTradesWindow(symbol, windowSec);
    return this._buildCandles1s(trades);
  }

  /**
   * 청산 5분 후 최종 캡처 → DB 저장
   */
  _schedulePostExitCapture(posId, symbol, entryTimeSec) {
    setTimeout(async () => {
      try {
        if (!this.ringBuffer) return;
        const nowSec = Date.now() / 1000;
        const windowSec = Math.ceil(nowSec - entryTimeSec) + 300;
        const trades = this.ringBuffer.getTradesWindow(symbol, windowSec);
        const candles = this._buildCandles1s(trades);
        if (!candles.length) return;

        const conn = await getPool().getConnection();
        try {
          await conn.execute(
            `UPDATE z4_positions SET candle_data = :data WHERE id = :id`,
            { id: posId, data: JSON.stringify(candles) },
            { autoCommit: true }
          );
        } finally { await conn.close(); }
      } catch (err) {
        console.error(`[Z4] Post-exit candle capture error (pos=${posId}):`, err.message);
      }
    }, 5 * 60 * 1000); // 5분 후
  }

  async record(trade) {
    if (trade.action === 'ENTRY') {
      await this._recordEntry(trade);
    } else if (trade.action === 'EXIT') {
      await this._recordExit(trade);
    }
  }

  async _recordEntry(trade) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z4_positions
         (id, symbol, direction, entry_price, target_price, safety_stop, time_stop_min, entry_time, entry_reasoning, plan_id, status)
         VALUES (:id, :sym, :dir, :price, :target, :safety, :tsMin, :ts, :reasoning, :planId, 'OPEN')`,
        {
          id: trade.positionId,
          sym: trade.symbol,
          dir: trade.direction,
          price: trade.entryPrice,
          target: trade.targetPrice || null,
          safety: trade.safetyStop || null,
          tsMin: trade.timeStopMin || 15,
          ts: new Date(trade.entryTime),
          reasoning: JSON.stringify(trade.entryReasoning || {}),
          planId: trade.planId || null,
        },
        { autoCommit: true }
      );

      await conn.execute(
        `INSERT INTO z4_trade_log (position_id, action, symbol, side, price, qty, fee_rate)
         VALUES (:posId, 'ENTRY', :sym, :side, :price, :qty, 0.04)`,
        {
          posId: trade.positionId,
          sym: trade.symbol,
          side: trade.direction === 'LONG' ? 'BUY' : 'SELL',
          price: trade.entryPrice,
          qty: trade.qty,
        },
        { autoCommit: true }
      );
      this.stats.entriesRecorded++;
    } catch (err) {
      this.stats.errors++;
      console.error('[Z4] Entry record error:', err.message);
    } finally {
      await conn.close();
    }
  }

  async _recordExit(trade) {
    // 1초봉 즉시 캡처 (진입 5분전 ~ 청산 시점)
    let candleJson = null;
    const entryTimeSec = trade.entryTime ? trade.entryTime / 1000 : (Date.now() / 1000 - (trade.holdTimeSec || 300));
    try {
      const candles = this._captureCandles(trade.symbol, entryTimeSec);
      if (candles.length > 0) candleJson = JSON.stringify(candles);
    } catch (err) {
      console.error(`[Z4] Candle capture error:`, err.message);
    }

    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `UPDATE z4_positions SET
           exit_price = :exitPrice,
           exit_time = SYSTIMESTAMP,
           exit_reason = :reason,
           exit_details = :details,
           pnl_pct = :pnlPct,
           pnl_amount = :pnlNet,
           status = 'CLOSED',
           candle_data = :candleData
         WHERE id = :id`,
        {
          id: trade.positionId,
          exitPrice: trade.exitPrice,
          reason: trade.exitReason,
          details: JSON.stringify(trade.exitDetails || {}),
          pnlPct: trade.pnlPct,
          pnlNet: trade.pnlNet,
          candleData: candleJson,
        },
        { autoCommit: true }
      );

      // 5분 후 최종 캡처 (청산 후 5분 데이터 포함)
      this._schedulePostExitCapture(trade.positionId, trade.symbol, entryTimeSec);

      await conn.execute(
        `INSERT INTO z4_trade_log (position_id, action, symbol, side, price, qty, fee_amount, fee_rate)
         VALUES (:posId, 'EXIT', :sym, :side, :price, :qty, :fee, 0.04)`,
        {
          posId: trade.positionId,
          sym: trade.symbol,
          side: trade.direction === 'LONG' ? 'SELL' : 'BUY',
          price: trade.exitPrice,
          qty: trade.qty || 0,
          fee: trade.feeTotal || 0,
        },
        { autoCommit: true }
      );
      this.stats.exitsRecorded++;
    } catch (err) {
      this.stats.errors++;
      console.error('[Z4] Exit record error:', err.message);
    } finally {
      await conn.close();
    }
  }
}
