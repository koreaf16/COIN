/**
 * @module 거래 기록기 (Trade Recorder)
 * @description 매매 체결(Entry/Exit) 정보와 가격 캔들 데이터를 Oracle DB에 기록한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Z3       │ ──→ │ Trade    │ ──→ │ Oracle   │
 * │ Executor │     │ Recorder │     │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↑
 *                RingBuffer(Z0)
 *             (캔들 데이터 캡처용)
 *
 * @zone z4-results
 * @dependencies oracledb, db.js, logger.js, query-loader.js
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { loadQueries } from '../shared/query-loader.js';

const queries = loadQueries('z4-results/trade-recorder');

export class TradeRecorder {
  constructor() {
    this.stats = { entriesRecorded: 0, exitsRecorded: 0, partialExitsRecorded: 0, postCaptures: 0, errors: 0 };
    this.ringBuffer = null; // main에서 주입
    this._pollTimer = null;
  }

  /**
   * 10초 폴링 시작 — 청산 1분 경과 건 후행 캡처
   */
  startPostExitPoller() {
    try {
      this._pollTimer = setInterval(() => this._pollPendingCaptures(), 10 * 1000);
      logger.info('[Z4] Post-exit poller started');
    } catch (err) {
      logger.error('[Z4] Poller start error:', err.message);
    }
  }

  /**
   * 폴링 중지
   */
  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      logger.info('[Z4] Post-exit poller stopped');
    }
  }

  /**
   * ringBuffer 체결 데이터 → 1초봉 배열 변환
   * @private
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
      if (b) { 
        candles.push(b); 
        prevClose = b.close; 
      } else {
        candles.push({ time: sec, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
      }
    }
    return candles;
  }

  /**
   * 1초봉 캡처 (진입 5분전 ~ now)
   * @private
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
   * 10초마다: DB에서 청산 1분 경과 + candle_post_exit=0 인 건 조회 → 후행 캡처
   * (청산 후 1분간의 가격 추이를 기존 캔들에 이어붙임)
   * @private
   */
  async _pollPendingCaptures() {
    if (!this.ringBuffer) return;
    let conn;
    try {
      conn = await getPool().getConnection();
      const result = await conn.execute(
        queries.get_pending_captures,
        {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      for (const row of (result.rows || [])) {
        const exitTimeSec = row.EXIT_TIME instanceof Date ? row.EXIT_TIME.getTime() / 1000 : null;
        let existingCandles = [];
        if (row.CANDLE_DATA) {
          try {
            existingCandles = JSON.parse(typeof row.CANDLE_DATA === 'string' ? row.CANDLE_DATA : await row.CANDLE_DATA);
          } catch (jsonErr) {
            logger.warn(`[Z4] JSON parse error for pos=${row.ID}`);
          }
        }
        await this._doPostExitCapture(row.ID, row.SYMBOL, exitTimeSec, existingCandles);
      }
    } catch (err) {
      if (!String(err.message).includes('ORA-00904')) {
        logger.error('[Z4] Post-exit poll error:', err.message);
      }
    } finally {
      if (conn) await conn.close();
    }
  }

  /** 
   * 단일 포지션 후행 캡처: 기존 캔들에 청산 후 1분 데이터 이어붙이기 
   * @private
   */
  async _doPostExitCapture(posId, symbol, exitTimeSec, existingCandles) {
    let conn;
    try {
      if (!exitTimeSec) return;

      const trades = this.ringBuffer.getTradesWindow(symbol, 90);
      const postTrades = trades.filter(t => t.ts >= exitTimeSec && t.ts <= exitTimeSec + 65);
      const postCandles = this._buildCandles1s(postTrades);

      const lastExistingTime = existingCandles.length > 0 ? existingCandles[existingCandles.length - 1].time : 0;
      const newCandles = postCandles.filter(c => c.time > lastExistingTime);
      const merged = [...existingCandles, ...newCandles];

      conn = await getPool().getConnection();
      await conn.execute(
        queries.update_candle_post_exit,
        { id: posId, data: JSON.stringify(merged) },
        { autoCommit: true }
      );
      if (newCandles.length > 0) {
        logger.info(`[Z4] Post-exit capture pos=${posId}: +${newCandles.length}s candles appended`);
      }
      this.stats.postCaptures++;
    } catch (err) {
      logger.error(`[Z4] Post-exit capture error (pos=${posId}):`, err.message);
    } finally {
      if (conn) await conn.close();
    }
  }

  /**
   * 거래 기록 메인 진입점
   */
  async record(trade) {
    try {
      if (trade.action === 'ENTRY') {
        await this._recordEntry(trade);
      } else if (trade.action === 'PARTIAL_EXIT') {
        await this._recordPartialExit(trade);
      } else if (trade.action === 'EXIT') {
        await this._recordExit(trade);
      }
    } catch (err) {
      logger.error('[Z4] record error:', err.message);
    }
  }

  /**
   * 진입 기록 (INSERT INTO z4_positions, z4_trade_log)
   * @private
   */
  async _recordEntry(trade) {
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.execute(queries.insert_position_entry, {
        id: trade.positionId,
        sym: trade.symbol,
        dir: trade.direction,
        price: trade.entryPrice,
        qty: trade.qty || null,
        target: trade.targetPrice || null,
        safety: trade.safetyStop || null,
        tsMin: trade.timeStopMin || 480,
        ts: new Date(trade.entryTime),
        reasoning: JSON.stringify(trade.entryReasoning || {}),
        planId: trade.planId || null,
      }, { autoCommit: true });

      await conn.execute(queries.insert_trade_log, {
        posId: trade.positionId,
        action: 'ENTRY',
        sym: trade.symbol,
        side: trade.direction === 'LONG' ? 'BUY' : 'SELL',
        price: trade.entryPrice,
        qty: trade.qty,
        fee: 0,
        feeRate: 0.0004
      }, { autoCommit: true });
      
      this.stats.entriesRecorded++;
      logger.info(`[Z4] Entry recorded for ${trade.symbol} pos=${trade.positionId}`);
    } catch (err) {
      this.stats.errors++;
      logger.error('[Z4] Entry record error:', err.message);
    } finally {
      if (conn) await conn.close();
    }
  }

  /**
   * 청산 기록 (UPDATE z4_positions, INSERT INTO z4_trade_log)
   * @private
   */
  async _recordPartialExit(trade) {
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.execute(queries.update_position_partial_exit, {
        id: trade.positionId,
        pnlPct: trade.cumulativePnlPct ?? trade.pnlPct ?? null,
        pnlNet: trade.cumulativePnlNet ?? trade.pnlNet ?? null,
        safety: trade.safetyStop ?? null,
      }, { autoCommit: true });

      await conn.execute(queries.insert_trade_log, {
        posId: trade.positionId,
        action: 'PARTIAL_EXIT',
        sym: trade.symbol,
        side: trade.direction === 'LONG' ? 'SELL' : 'BUY',
        price: trade.exitPrice,
        qty: trade.qty || 0,
        fee: trade.feeTotal || 0,
        feeRate: 0.0004
      }, { autoCommit: true });

      this.stats.partialExitsRecorded++;
      logger.info(`[Z4] Partial exit recorded for ${trade.symbol} pos=${trade.positionId} realized=${(trade.pnlNet || 0).toFixed(2)} total=${((trade.cumulativePnlNet ?? trade.pnlNet) || 0).toFixed(2)}`);
    } catch (err) {
      this.stats.errors++;
      logger.error('[Z4] Partial exit record error:', err.message);
    } finally {
      if (conn) await conn.close();
    }
  }

  async _recordExit(trade) {
    let conn;
    try {
      const candleJson = this._prepareExitCandles(trade);
      conn = await getPool().getConnection();
      await conn.execute(queries.update_position_exit, {
        id: trade.positionId,
        exitPrice: trade.exitPrice,
        reason: trade.exitReason,
        details: JSON.stringify(trade.exitDetails || {}),
        pnlPct: trade.cumulativePnlPct ?? trade.pnlPct,
        pnlNet: trade.cumulativePnlNet ?? trade.pnlNet,
        candleData: candleJson,
      }, { autoCommit: true });

      await conn.execute(queries.insert_trade_log, {
        posId: trade.positionId,
        action: 'EXIT',
        sym: trade.symbol,
        side: trade.direction === 'LONG' ? 'SELL' : 'BUY',
        price: trade.exitPrice,
        qty: trade.qty || 0,
        fee: trade.feeTotal || 0,
        feeRate: 0.0004
      }, { autoCommit: true });
      
      this.stats.exitsRecorded++;
      logger.info(`[Z4] Exit recorded for ${trade.symbol} pos=${trade.positionId} pnl=${trade.pnlNet.toFixed(2)}`);
    } catch (err) {
      this.stats.errors++;
      logger.error('[Z4] Exit record error:', err.message);
    } finally {
      if (conn) await conn.close();
    }
  }

  /**
   * 청산 시점의 캔들 데이터 준비
   * @private
   */
  _prepareExitCandles(trade) {
    try {
      const entryTimeSec = trade.entryTime ? trade.entryTime / 1000 : (Date.now() / 1000 - (trade.holdTimeSec || 300));
      const candles = this._captureCandles(trade.symbol, entryTimeSec);
      return candles.length > 0 ? JSON.stringify(candles) : null;
    } catch (err) {
      logger.error(`[Z4] Candle capture error:`, err.message);
      return null;
    }
  }
}
