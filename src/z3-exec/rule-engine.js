/**
 * @module 룰 엔진
 * @description 실행 계획(Execution Plan)의 진입 조건을 실시간으로 평가하여 매매 시그널을 생성한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Plan Cache   │ ───→ │ Rule Engine  │ ───→ │ Executor     │
 * │ (Active)     │      │ (Evaluate)   │      │ (Trade)      │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *                              ↑
 *                       ┌──────────────┐
 *                       │ Market       │
 *                       │ Guards       │
 *                       └──────────────┘
 *
 * @zone z3-exec
 * @dependencies hot-reload.js, plan-cache.js, market-guards.js, logger.js, query-loader.js
 */

import { hotReloader } from '../shared/hot-reload.js';
import { computeSwingFeatures } from '../shared/swing-features.js';
import { PlanCache } from './plan-cache.js';
import { logger } from '../shared/logger.js';
import * as Guard from './market-guards.js';
import { loadQueries } from '../shared/query-loader.js';

const queries = loadQueries('z3-exec/rule-engine');

export class RuleEngine {
  constructor(ringBuffer, macroCollector, symbols, opts = {}) {
    this.ringBuffer = ringBuffer;
    this.macroCollector = macroCollector;
    this.symbols = symbols;
    this.economicCalendar = opts.economicCalendar || null;
    this.intervalMs = (opts.intervalMs || 5000);

    this.planCache = new PlanCache({ refreshIntervalSec: opts.cacheRefreshSec || 10 });
    this._timer = null;
    this.checkCount = 0;
    this.signalCount = 0;
    this._eventPauseLogged = false;
    this._evaluating = false;
    this._guardBlockLog = new Map();

    this.onSignal = null;
  }

  async start() {
    try {
      const ceAbsPath = new URL('./condition-evaluator.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
      await hotReloader.register('condition-evaluator', ceAbsPath);

      this.planCache.start();
      this._timer = setInterval(() => this._evaluate(), this.intervalMs);
      logger.info(`[Z3-Rule] Engine started (interval=${this.intervalMs}ms, hot-reload=ON)`);
    } catch (err) {
      logger.error(`[Z3-Rule] Start failed: ${err.message}`);
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this.planCache.stop();
    logger.info(`[Z3-Rule] Stopped (checks=${this.checkCount}, signals=${this.signalCount})`);
  }

  async _evaluate() {
    if (this._evaluating) return;
    this._evaluating = true;
    this.checkCount++;

    try {
      if (this._isEventWindow()) return;

      for (const symbol of this.symbols) {
        const plans = this.planCache.getActivePlans(symbol);
        if (plans.length === 0) continue;

        const currentData = await this._getCurrentData(symbol);
        if (!currentData.price) continue;

        for (const plan of plans) {
          const { evaluateConditions } = hotReloader.get('condition-evaluator');
          const result = evaluateConditions(plan.entryConditions, currentData, plan.direction);
          if (result.met) {
            await this._emitSignal(plan, currentData, result.details);
            break;
          }
        }
      }
    } catch (err) {
      logger.error(`[Z3-Rule] Evaluate error: ${err.message}`);
    } finally {
      this._evaluating = false;
    }
  }

  async _getCurrentData(symbol) {
    const snapshot = this.ringBuffer.getSnapshot(symbol);
    const deriv = snapshot.derivatives || {};
    const mark = snapshot.markPrice || {};

    let price_dir_1h = 'FLAT', oi_dir_1h = 'FLAT', volatility_acceleration = 1.0;
    try {
      const { getPool } = await import('../shared/db.js');
      const conn = await getPool().getConnection();
      try {
        const oiR = await conn.execute(queries.getOiMatrix, { sym: symbol });
        if (oiR.rows?.length) [price_dir_1h, oi_dir_1h] = oiR.rows[0];
        const vaR = await conn.execute(queries.getMarketState, { sym: symbol });
        if (vaR.rows?.length) volatility_acceleration = vaR.rows[0][0] ?? 1.0;
      } finally { await conn.close(); }
    } catch (err) {
      logger.warn(`[Z3-Rule] DB fetch error for ${symbol}: ${err.message}`);
    }

    const recentTrades = this.ringBuffer.getTradesWindow(symbol, 300);
    let buyVol = 0, sellVol = 0;
    for (const t of recentTrades) { if (t.isBuyerMaker) sellVol += t.qty; else buyVol += t.qty; }
    const totalVol = buyVol + sellVol;
    const cvdDirection = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

    const trades1h = this.ringBuffer.getTradesWindow(symbol, 3600);
    let vol1h = 0;
    for (const t of trades1h) vol1h += t.qty;
    const avgVol5m = trades1h.length > 0 ? (vol1h / 12) : 1;
    const volumeSurge = Math.min(avgVol5m > 0 ? totalVol / avgVol5m : 1.0, 5.0);
    const swing = this._buildSwingContext(symbol, snapshot.price);

    return {
      price: snapshot.price,
      funding_rate: mark.fundingRate || deriv.funding_rate || 0,
      predicted_funding: deriv.predicted_rate || 0,
      oi_change_pct: deriv.oi_change_pct || 0,
      open_interest: deriv.open_interest || 0,
      long_ratio: deriv.long_ratio || 0,
      short_ratio: deriv.short_ratio || 0,
      liq_long_24h: deriv.liq_long_24h || 0,
      liq_short_24h: deriv.liq_short_24h || 0,
      cvd_direction: cvdDirection,
      macro_regime: this.macroCollector?.getRegime() || 'neutral',
      volume_surge: volumeSurge,
      price_dir_1h, oi_dir_1h, volatility_acceleration,
      ...swing,
    };
  }

  _buildSwingContext(symbol, currentPrice) {
    if (!this.ringBuffer || !Number.isFinite(currentPrice)) return {};
    return computeSwingFeatures({
      currentPrice,
      klines1h: this.ringBuffer.getKlines(symbol, '1h'),
      klines4h: this.ringBuffer.getKlines(symbol, '4h'),
      klines1d: this.ringBuffer.getKlines(symbol, '1d'),
      btcKlines1h: this.ringBuffer.getKlines('BTCUSDT', '1h'),
      btcKlines1d: this.ringBuffer.getKlines('BTCUSDT', '1d'),
    });
  }

  _isEventWindow() {
    if (!this.economicCalendar) return false;
    const events = this.economicCalendar.getNext24h?.() || [];
    const now = Date.now();
    for (const evt of events) {
      const evtTime = new Date(evt.datetime || evt.date).getTime();
      const impact = (evt.impact || evt.importance || '').toLowerCase();
      if ((impact === 'high' || impact === '높음') && Math.abs(now - evtTime) <= 30 * 60 * 1000) {
        if (!this._eventPauseLogged) { logger.info(`[Z3-Rule] EVENT PAUSE: ${evt.title || evt.event}`); this._eventPauseLogged = true; }
        return true;
      }
    }
    this._eventPauseLogged = false;
    return false;
  }

  async _emitSignal(plan, currentData, details) {
    try {
      const guard = await Guard.checkMarketGuard(plan.symbol, plan.direction, this.ringBuffer);
      if (guard.blocked) {
        this._logGuardBlock(plan.id, `GUARD BLOCKED: ${plan.symbol} ${plan.direction} — ${guard.reason}`);
        return;
      }

      const counterTrend = await Guard.detectCounterTrend(plan.symbol, plan.direction);
      if (counterTrend.isCounterTrend && plan.confidence < 0.75) {
        this._logGuardBlock(plan.id, `COUNTER-TREND BLOCKED: ${plan.symbol} ${plan.direction} conf=${plan.confidence} < 0.75 (${counterTrend.reason})`);
        return;
      }

      const structureBlock = this._checkStructureGuard(plan, currentData);
      if (structureBlock) {
        this._logGuardBlock(plan.id, `STRUCTURE BLOCKED: ${plan.symbol} ${plan.direction} ${structureBlock}`);
        return;
      }

      if (currentData.volume_surge > 3.0) {
        if ((plan.direction === 'LONG' && currentData.price_dir_1h === 'DOWN') || (plan.direction === 'SHORT' && currentData.price_dir_1h === 'UP')) {
          this._logGuardBlock(plan.id, `PANIC_MOVE BLOCKED: ${plan.symbol} ${plan.direction} — volume_surge=${currentData.volume_surge.toFixed(1)}x`);
          return;
        }
      }

      this.signalCount++;
      const signal = {
        type: 'PLAN_TRIGGERED', planId: plan.id, symbol: plan.symbol, direction: plan.direction,
        targetPrice: plan.targetPrice, stopPrice: plan.stopPrice, stopConditions: plan.stopConditions,
        entryConditions: plan.entryConditions, timeStopMin: plan.timeStopMin, confidence: plan.confidence,
        reasoning: plan.reasoning, currentPrice: currentData.price, evaluationDetails: details,
        counterTrend: counterTrend.isCounterTrend, ts: Date.now(),
        _markTriggered: () => this.planCache.markTriggered(plan.id),
      };

      logger.info(`[Z3-Rule] SIGNAL: ${plan.direction} ${plan.symbol} @ $${currentData.price} (plan=${plan.id}, conf=${plan.confidence}${counterTrend.isCounterTrend ? ', COUNTER-TREND' : ''})`);
      if (this.onSignal) this.onSignal(signal);
    } catch (err) {
      logger.error(`[Z3-Rule] EmitSignal error: ${err.message}`);
    }
  }

  _checkStructureGuard(plan, currentData) {
    const allowAggressiveCounterTrend = plan.confidence >= 0.9;
    if (plan.direction === 'LONG') {
      if (currentData.daily_bias === 'BEARISH' && !allowAggressiveCounterTrend) return 'daily_bias=BEARISH';
      if (currentData.trend_bias_4h === 'BEARISH' && !allowAggressiveCounterTrend) return 'trend_bias_4h=BEARISH';
    }
    if (plan.direction === 'SHORT') {
      if (currentData.daily_bias === 'BULLISH' && !allowAggressiveCounterTrend) return 'daily_bias=BULLISH';
      if (currentData.trend_bias_4h === 'BULLISH' && !allowAggressiveCounterTrend) return 'trend_bias_4h=BULLISH';
    }
    return null;
  }

  _logGuardBlock(planId, message) {
    if (Date.now() - (this._guardBlockLog.get(planId) || 0) > 300000) {
      logger.info(`[Z3-Rule] ${message}`);
      this._guardBlockLog.set(planId, Date.now());
    }
  }

  getStats() { return { checkCount: this.checkCount, signalCount: this.signalCount, activePlans: this.planCache.totalActive }; }
}
