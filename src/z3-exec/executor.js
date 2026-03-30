/**
 * @module Executor
 * @description Z3 매매 실행 엔진의 메인 클래스. 룰엔진의 시그널을 받아 리스크 검증 후 
 *              실제 거래를 실행하며, 포지션 상태를 모니터링하고 동기화한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Rule     │ ──→ │ Executor │ ──→ │ Binance  │
 * │ Engine   │     │ (Main)   │     │ Futures  │
 * └──────────┘     └──────────┘     └──────────┘
 *                       │
 *                 ┌─────┴─────┐
 *                 ▼           ▼
 *             RiskGate    SmartExit
 *
 * @zone z3-exec
 * @dependencies binance-futures-client.js, risk-gate.js, smart-exit.js, condition-evaluator.js
 */

import oracledb from 'oracledb';
import { logger } from "../shared/logger.js";
import { getPool } from "../shared/db.js";
import { loadQueries } from "../shared/query-loader.js";
import { BinanceFuturesClient } from './binance-futures-client.js';
import { RiskGate } from './risk-gate-fixed.js';
import { SmartExit } from './smart-exit.js';
import { evaluateConditions } from './condition-evaluator.js';
import { ExecutorTrade } from './executor-trade.js';

const queries = loadQueries('z3-exec/executor');

export class Executor extends ExecutorTrade {
  constructor(ringBuffer, opts = {}) {
    super();
    this.ringBuffer = ringBuffer;
    this.binance = new BinanceFuturesClient({
      apiKey: opts.apiKey || '',
      apiSecret: opts.apiSecret || '',
      testnet: opts.testnetMode !== false,
    });

    this.maxSlippagePct = opts.maxSlippagePct || 0.3;
    this.entryLimitTimeoutMs = Math.max(1000, (opts.entryLimitTimeoutSec || 3) * 1000);
    this.entryLimitFallbackPct = opts.entryLimitFallbackPct || 0.15;
    this.riskGate = new RiskGate({
      maxPositionPct: opts.maxPositionPct || 10.0,
      maxRiskPct: opts.maxRiskPct || 1.0,
      safetyStopPct: opts.safetyStopPct || 4.0,
      maxDailyLossPct: opts.maxDailyLossPct || 5.0,
      maxOpenTrades: opts.maxOpenTrades || 5,
      cooldownSec: opts.cooldownSec || 7200,
      maxLeverage: opts.maxLeverage || 2,
    });

    this.smartExit = new SmartExit({
      validateIntervalSec: opts.validateIntervalSec || 600,
      ringBuffer: this.ringBuffer,
    });

    this.leverage = opts.maxLeverage || 2;
    this.balance = opts.initialCapital || 10000;
    this.walletBalance = opts.initialCapital || 10000;
    this.liveMode = false;
    this.activePositions = new Map();
    this._pendingSymbols = new Set();
    this._exchangePositionsCache = null;
    this._exchangePositionsCacheTs = 0;
    this._monitorRunning = false;
    this.stats = { signals: 0, entries: 0, exits: 0, rejected: 0 };
    this.onTrade = null;
  }

  async start() {
    await this.binance.init();
    this.liveMode = this.binance.isReady();

    if (this.liveMode) {
      await this._updateBalances();
      await this._recoverPositions();
      await this._syncPositions();
      this._syncTimer = setInterval(() => this._syncPositions(), 60000);
      this._cleanupTimer = setInterval(() => this._cleanupStalePositions(), 30 * 60 * 1000);
    } else {
      logger.info(`[Z3-Exec] SIM mode (no API key) balance=$${this.balance.toFixed(2)}`);
    }

    this._monitorTimer = setInterval(() => this._monitorPositions(), 2000);
    this._scheduleDailyReset();
    logger.info(`[Z3-Exec] Started (mode=${this.liveMode ? 'LIVE' : 'SIM'})`);
  }

  stop() {
    if (this._monitorTimer) clearInterval(this._monitorTimer);
    if (this._syncTimer) clearInterval(this._syncTimer);
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    if (this._dailyResetTimer) {
      clearTimeout(this._dailyResetTimer);
      clearInterval(this._dailyResetTimer);
    }
    this.smartExit.stopAll();
    logger.info(`[Z3-Exec] Stopped (entries=${this.stats.entries}, exits=${this.stats.exits})`);
  }

  /** 전체 오픈 포지션 시장가 청산 */
  async closeAllPositions(reason = 'EMERGENCY_SHUTDOWN') {
    const positions = [...this.activePositions.values()];
    if (!positions.length) return;

    logger.info(`[Z3-Exec] closeAllPositions: closing ${positions.length} positions (reason=${reason})`);
    const results = await Promise.allSettled(
      positions.map(pos => {
        const price = this.ringBuffer.getLastPrice(pos.symbol) || pos.entryPrice;
        return this._exitPosition(pos.id, price, reason);
      })
    );

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      logger.error(`[Z3-Exec] closeAllPositions: ${failed.length} positions failed to close`);
      await this._markFailedPositions(positions);
    }
  }

  async _markFailedPositions(positions) {
    const conn = await getPool().getConnection();
    try {
      for (const pos of positions) {
        if (this.activePositions.has(pos.id)) {
          await conn.execute(queries.markPositionError, { id: pos.id }, { autoCommit: true });
        }
      }
    } catch (err) { logger.warn(`[Z3-Exec] Failed to mark error positions: ${err.message}`); }
    finally { await conn.close(); }
  }

  _scheduleDailyReset() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    
    const reset = () => {
      this.riskGate.resetDaily();
      logger.info('[Z3-Exec] Daily PnL reset');
    };

    this._dailyResetTimer = setTimeout(() => {
      reset();
      this._dailyResetTimer = setInterval(reset, 24 * 60 * 60 * 1000);
    }, nextMidnight - now);
  }

  /** 시그널 수신 */
  async onSignal(signal) {
    this.stats.signals++;
    const currentPrice = this.ringBuffer.getLastPrice(signal.symbol);
    if (!currentPrice) return;

    if (await this._isRejectedByConflict(signal)) return;

    if (this._pendingSymbols.has(signal.symbol)) {
      this.stats.rejected++;
      return;
    }

    this._pendingSymbols.add(signal.symbol);
    try {
      const macroRegime = this.macroCollector?.getRegime() || 'neutral';
      await this._doSignal(signal, currentPrice, macroRegime);
    } finally {
      this._pendingSymbols.delete(signal.symbol);
    }
  }

  async _isRejectedByConflict(signal) {
    const marketData = await this._buildMarketData(signal.symbol);
    const conflictConditions = signal.direction === 'LONG'
      ? {
          price_dir_1h: { op: '==', value: 'DOWN' },
          oi_dir_1h: { op: '==', value: 'UP' },
        }
      : {
          price_dir_1h: { op: '==', value: 'UP' },
          oi_dir_1h: { op: '==', value: 'UP' },
        };

    const finalCheck = evaluateConditions(conflictConditions, marketData, null);
    if (finalCheck.met) {
      this.stats.rejected++;
      logger.info(`[Z3-Exec] REJECTED by ConflictFilter: ${signal.symbol} ${signal.direction} ${JSON.stringify(marketData)}`);
      return true;
    }
    return false;
  }

  /** 시장 데이터 스냅샷 */
  async _buildMarketData(symbol) {
    const snapshot = this.ringBuffer.getSnapshot(symbol);
    const deriv = snapshot.derivatives || {};
    const mark = snapshot.markPrice || {};

    let price_dir_1h = 'FLAT', oi_dir_1h = 'FLAT';
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getLatestOiMatrix, { sym: symbol });
      if (result.rows?.length > 0) [price_dir_1h, oi_dir_1h] = result.rows[0];
    } catch (err) { /* ignore */ }
    finally { await conn.close(); }

    const recentTrades = this.ringBuffer.getTradesWindow(symbol, 60);
    let buyVol = 0, sellVol = 0;
    for (const t of recentTrades) {
      if (t.isBuyerMaker) sellVol += t.qty; else buyVol += t.qty;
    }
    const totalVol = buyVol + sellVol;
    const cvd_direction = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

    const trades5m = this.ringBuffer.getTradesWindow(symbol, 300);
    let vol5m = 0;
    for (const t of trades5m) vol5m += t.qty;
    const volume_surge = (vol5m / 5) > 0 ? totalVol / (vol5m / 5) : 1.0;

    return {
      price: snapshot.price, funding_rate: mark.fundingRate || deriv.funding_rate || 0,
      oi_change_pct: deriv.oi_change_pct || 0, cvd_direction, volume_surge,
      macro_regime: 'neutral', price_dir_1h, oi_dir_1h,
    };
  }

  /** 포지션 모니터링 */
  async _monitorPositions() {
    if (this._monitorRunning) return;
    this._monitorRunning = true;
    try {
      for (const [posId, position] of this.activePositions) {
        await this._checkPositionExit(posId, position);
      }
    } finally { this._monitorRunning = false; }
  }

  async _checkPositionExit(posId, position) {
    const currentPrice = this.ringBuffer.getLastPrice(position.symbol);
    if (!currentPrice) return;

    const exitReason = this.smartExit.checkPriceExit(position, currentPrice);
    if (exitReason) {
      await this._exitPosition(posId, currentPrice, exitReason);
      return;
    }

    if (position.stopConditions && Date.now() - (position._lastStopCondCheck || 0) >= 5000) {
      position._lastStopCondCheck = Date.now();
      const marketData = await this._buildMarketData(position.symbol);
      const result = evaluateConditions(position.stopConditions, marketData, null);
      if (result.met) {
        this._exitPosition(posId, currentPrice, 'STOP_CONDITION', result.details);
      }
    }
  }

  /** 캐시된 Binance 포지션 */
  async getCachedPositions() {
    if (Date.now() - this._exchangePositionsCacheTs < 5000 && this._exchangePositionsCache) {
      return this._exchangePositionsCache;
    }
    try {
      this._exchangePositionsCache = await this.binance.getPositions();
      this._exchangePositionsCacheTs = Date.now();
    } catch (err) { logger.warn(`[Z3-Exec] Position cache refresh failed: ${err.message}`); }
    return this._exchangePositionsCache || [];
  }

  getStats() {
    return {
      ...this.stats, mode: this.liveMode ? 'LIVE' : 'SIM',
      testnet: this.binance.testnet, balance: this.balance,
      walletBalance: this.walletBalance, activePositions: this.activePositions.size,
    };
  }
}
