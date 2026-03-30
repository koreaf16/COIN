/**
 * @module Executor Sync
 * @description 거래소와 DB 간의 포지션 상태를 동기화하고 스테일 포지션을 정리한다.
 *
 * @zone z3-exec
 * @dependencies db.js, query-loader.js, oracledb
 */

import oracledb from 'oracledb';
import { logger } from "../shared/logger.js";
import { getPool } from "../shared/db.js";
import { loadQueries } from "../shared/query-loader.js";

const queries = loadQueries('z3-exec/executor');

export class ExecutorSync {
  constructor() {
    // State will be initialized in Executor's constructor
  }

  /** 서버 재시작 시 DB OPEN 포지션 → Binance 대조 후 복구 */
  async _recoverPositions() {
    try {
      const conn = await getPool().getConnection();
      let dbPositions = [];
      try {
        const result = await conn.execute(queries.getOpenPositions, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        dbPositions = result.rows || [];
      } finally { await conn.close(); }

      if (!dbPositions.length) return;
      const exchangePositions = await this.getCachedPositions();

      for (const row of dbPositions) {
        await this._processRecoverRow(row, exchangePositions);
      }
    } catch (err) {
      logger.warn(`[Z3-Exec] Position recovery failed: ${err.message}`);
    }
  }

  async _processRecoverRow(row, exchangePositions) {
    const posId = row.ID;
    if (this.activePositions.has(posId)) return;

    const exPos = exchangePositions.find(p => p.symbol === row.SYMBOL);
    if (!exPos) {
      await this._markOrphanedClosed(posId, row.SYMBOL);
      return;
    }

    const entryPrice = parseFloat(row.ENTRY_PRICE);
    const safetyStopDir = row.DIRECTION === 'LONG' ? -1 : 1;
    const safetyStop = entryPrice * (1 + safetyStopDir * this.riskGate.safetyStopPct / 100);

    const entryReasoning = this._parseReasoning(row.ENTRY_REASONING);
    const position = {
      id: posId,
      planId: row.PLAN_ID,
      symbol: row.SYMBOL,
      direction: row.DIRECTION,
      entryPrice,
      entryTime: row.ENTRY_TIME instanceof Date ? row.ENTRY_TIME.getTime() : Date.now(),
      qty: exPos.qty,
      initialQty: row.QTY ? parseFloat(row.QTY) : exPos.qty,
      realizedPnlNet: row.PNL_AMOUNT ? parseFloat(row.PNL_AMOUNT) : 0,
      realizedFeeTotal: row.REALIZED_FEE_TOTAL ? parseFloat(row.REALIZED_FEE_TOTAL) : 0,
      _partialExited: (row.PARTIAL_EXIT_COUNT || 0) > 0,
      targetPrice: row.TARGET_PRICE ? parseFloat(row.TARGET_PRICE) : null,
      safetyStop: row.SAFETY_STOP ? parseFloat(row.SAFETY_STOP) : safetyStop,
      timeStopMin: row.TIME_STOP_MIN ? parseFloat(row.TIME_STOP_MIN) : 15,
      confidence: 0.5,
      entryReasoning,
      entryConditions: entryReasoning.entryConditions || null,
    };

    this.activePositions.set(posId, position);
    this.riskGate.addTrade(position);
    this._startSmartExit(posId, position);
    logger.info(`[Z3-Exec] RECOVER: ${row.DIRECTION} ${row.SYMBOL} @ $${position.entryPrice} qty=${position.qty}`);
  }

  async _markOrphanedClosed(posId, symbol) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.markOrphanedClosed, { id: posId }, { autoCommit: true });
    } finally { await conn.close(); }
    logger.info(`[Z3-Exec] RECOVER: ${symbol} not on exchange → marked CLOSED`);
  }

  _parseReasoning(raw) {
    if (!raw) return {};
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { return {}; }
  }

  /** 거래소 포지션과 내부 상태 동기화 */
  async _syncPositions() {
    if (!this.liveMode) return;
    try {
      const exchangePositions = await this.getCachedPositions();

      for (const [posId, pos] of this.activePositions) {
        const exPos = exchangePositions.find(p => p.symbol === pos.symbol);
        if (!exPos) {
          const currentPrice = this.ringBuffer.getLastPrice(pos.symbol) || pos.entryPrice;
          logger.info(`[Z3-Exec] SYNC: ${pos.symbol} closed externally`);
          await this._exitPosition(posId, currentPrice, 'EXCHANGE_CLOSED');
        }
      }

      for (const exPos of exchangePositions) {
        await this._adoptExchangePosition(exPos);
      }
    } catch (err) { /* sync failed is non-critical */ }
  }

  async _adoptExchangePosition(exPos) {
    const alreadyTracked = [...this.activePositions.values()].some(p => p.symbol === exPos.symbol);
    if (alreadyTracked) return;

    const entryPrice = parseFloat(exPos.entryPrice);
    const direction = exPos.side === 'LONG' ? 'LONG' : 'SHORT';
    const safetyStop = entryPrice * (1 + (direction === 'LONG' ? -1 : 1) * this.riskGate.safetyStopPct / 100);
    const posId = Date.now() + Math.floor(Math.random() * 1000);

    const position = {
      id: posId, symbol: exPos.symbol, direction, entryPrice, entryTime: Date.now(),
      qty: exPos.qty, initialQty: exPos.qty, realizedPnlNet: 0, realizedFeeTotal: 0,
      targetPrice: null, safetyStop, timeStopMin: 15, confidence: 0.5,
      entryReasoning: { note: 'auto-recovered from exchange' },
      entryConditions: null,
    };

    this.activePositions.set(posId, position);
    this.riskGate.addTrade(position);
    this._startSmartExit(posId, position);
    logger.info(`[Z3-Exec] SYNC-ADOPT: ${direction} ${exPos.symbol} qty=${exPos.qty}`);
  }

  /** 스테일 포지션 정리 */
  async _cleanupStalePositions() {
    try {
      const conn = await getPool().getConnection();
      try {
        await this._handleStaleOpen(conn);
        await this._handleErrorPositions(conn);
      } finally { await conn.close(); }
    } catch (err) {
      logger.error('[Z3-Exec] cleanupStalePositions error:', err.message);
    }
  }

  async _handleStaleOpen(conn) {
    const result = await conn.execute(queries.getStalePositions, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    for (const row of (result.rows || [])) {
      if (this.activePositions.has(row.ID)) continue;
      try {
        if (this.liveMode) {
          const exPositions = await this.getCachedPositions();
          const qty = exPositions.find(p => p.symbol === row.SYMBOL)?.qty || 0;
          await this.binance.closePosition(row.SYMBOL, row.DIRECTION, qty);
        }
        await conn.execute(queries.closeStalePosition, { id: row.ID }, { autoCommit: true });
        logger.info(`[Z3-Exec] STALE pos=${row.ID} closed`);
      } catch (err) {
        await conn.execute(queries.markStaleCloseFailed, { id: row.ID }, { autoCommit: true }).catch(() => {});
      }
    }
  }

  async _handleErrorPositions(conn) {
    const result = await conn.execute(queries.getRecentErrorPositions, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    for (const row of (result.rows || [])) {
      try {
        if (this.liveMode) {
          const exPositions = await this.getCachedPositions();
          const qty = exPositions.find(p => p.symbol === row.SYMBOL)?.qty || 0;
          await this.binance.closePosition(row.SYMBOL, row.DIRECTION, qty);
        }
        await conn.execute(queries.closeErrorRetrySuccess, { id: row.ID }, { autoCommit: true });
      } catch (err) {
        await conn.execute(queries.markManualReview, { id: row.ID, reason: err.message.substring(0, 200) }, { autoCommit: true }).catch(() => {});
      }
    }
  }
}
