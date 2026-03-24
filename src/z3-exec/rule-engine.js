/**
 * Z3 Rule Engine — execution_plan 조건 실시간 평가
 * L2 Strategy Engine을 완전 대체
 *
 * 1초마다: ACTIVE 플랜의 entry_conditions를 현재 데이터와 대조
 * 모든 조건 충족 → 시그널 발행 → executor로 전달
 */

import { evaluateConditions } from './condition-evaluator.js';
import { PlanCache } from './plan-cache.js';

export class RuleEngine {
  constructor(ringBuffer, macroCollector, symbols, opts = {}) {
    this.ringBuffer = ringBuffer;
    this.macroCollector = macroCollector;
    this.symbols = symbols;
    this.economicCalendar = opts.economicCalendar || null;
    this.intervalMs = (opts.intervalMs || 1000); // 1초

    this.planCache = new PlanCache({ refreshIntervalSec: opts.cacheRefreshSec || 10 });
    this._timer = null;
    this.checkCount = 0;
    this.signalCount = 0;
    this._eventPauseLogged = false;
    this._evaluating = false; // 중복 실행 방지

    this.onSignal = null; // 콜백: (signal) => void
  }

  start() {
    this.planCache.start();
    this._timer = setInterval(() => this._evaluate(), this.intervalMs);
    console.log(`[Z3-Rule] Engine started (interval=${this.intervalMs}ms)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this.planCache.stop();
    console.log(`[Z3-Rule] Stopped (checks=${this.checkCount}, signals=${this.signalCount})`);
  }

  async _evaluate() {
    if (this._evaluating) return; // 이전 평가 아직 진행 중 → 스킵
    this._evaluating = true;
    this.checkCount++;

    try {
      // 고임팩트 경제 이벤트 ±15분 이내 → 진입 일시정지
      if (this._isEventWindow()) return;

      for (const symbol of this.symbols) {
        const plans = this.planCache.getActivePlans(symbol);
        if (plans.length === 0) continue;

        const currentData = await this._getCurrentData(symbol);
        if (!currentData.price) continue;

        for (const plan of plans) {
          const result = evaluateConditions(plan.entryConditions, currentData, plan.direction);
          if (result.met) {
            await this._emitSignal(plan, currentData, result.details);
            break; // 심볼당 1개 시그널만 (이중 진입 방지)
          }
        }
      }
    } finally {
      this._evaluating = false;
    }
  }

  async _getCurrentData(symbol) {
    const snapshot = this.ringBuffer.getSnapshot(symbol);
    const deriv = snapshot.derivatives || {};
    const mark = snapshot.markPrice || {};

    // DB에서 최신 OI Matrix + Volatility Acceleration 가져오기 (Conflict Filter / 조건 평가용)
    let price_dir_1h = 'FLAT';
    let oi_dir_1h = 'FLAT';
    let volatility_acceleration = 1.0;
    try {
      const { getPool: getDbPool } = await import('../shared/db.js');
      const conn = await getDbPool().getConnection();
      try {
        const oiResult = await conn.execute(
          `SELECT price_dir, oi_dir FROM z1_oi_matrix WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
          { sym: symbol }
        );
        if (oiResult.rows && oiResult.rows.length > 0) {
          [price_dir_1h, oi_dir_1h] = oiResult.rows[0];
        }
        const vaResult = await conn.execute(
          `SELECT volatility_acceleration FROM z1_market_states WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
          { sym: symbol }
        );
        if (vaResult.rows && vaResult.rows.length > 0) {
          volatility_acceleration = vaResult.rows[0][0] ?? 1.0;
        }
      } finally { await conn.close(); }
    } catch {}

    // CVD 방향: 최근 60초 체결에서 매수/매도 비율
    const recentTrades = this.ringBuffer.getTradesWindow(symbol, 60);
    let buyVol = 0, sellVol = 0;
    for (const t of recentTrades) {
      if (t.isBuyerMaker) sellVol += t.qty;
      else buyVol += t.qty;
    }
    const totalVol = buyVol + sellVol;
    const cvdDirection = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

    // 볼륨 서지: 최근 60초 vs 최근 300초 평균
    const trades5m = this.ringBuffer.getTradesWindow(symbol, 300);
    let vol5m = 0;
    for (const t of trades5m) vol5m += t.qty;
    const avgVol1m = trades5m.length > 0 ? (vol5m / 5) : 1;
    const volumeSurge = avgVol1m > 0 ? totalVol / avgVol1m : 1.0;

    return {
      price: snapshot.price,
      funding_rate: mark.fundingRate || deriv.funding_rate || 0,
      predicted_funding: deriv.predicted_rate || 0,
      oi_change_pct: deriv.oi_change_pct || 0,
      open_interest: deriv.open_interest || 0,
      long_ratio: deriv.long_ratio || 0,
      short_ratio: deriv.short_ratio || 0,
      cvd_direction: cvdDirection,
      macro_regime: this.macroCollector?.getRegime() || 'neutral',
      volume_surge: volumeSurge,
      price_dir_1h,
      oi_dir_1h,
      volatility_acceleration,
    };
  }

  /** 고임팩트 경제 이벤트 ±15분 내 → true (진입 일시정지) */
  _isEventWindow() {
    if (!this.economicCalendar) return false;
    const events = this.economicCalendar.getNext24h?.() || [];
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;

    for (const evt of events) {
      const evtTime = new Date(evt.datetime || evt.date).getTime();
      if (isNaN(evtTime)) continue;
      const impact = (evt.impact || evt.importance || '').toLowerCase();
      if (impact !== 'high' && impact !== '높음') continue;
      if (Math.abs(now - evtTime) <= windowMs) {
        if (!this._eventPauseLogged) {
          console.log(`[Z3-Rule] EVENT PAUSE: ${evt.title || evt.event} (±15min window)`);
          this._eventPauseLogged = true;
        }
        return true;
      }
    }
    this._eventPauseLogged = false;
    return false;
  }

  async _emitSignal(plan, currentData, details) {
    this.signalCount++;

    const signal = {
      type: 'PLAN_TRIGGERED',
      planId: plan.id,
      symbol: plan.symbol,
      direction: plan.direction,
      targetPrice: plan.targetPrice,
      stopPrice: plan.stopPrice,
      stopConditions: plan.stopConditions,
      entryConditions: plan.entryConditions,
      timeStopMin: plan.timeStopMin,
      confidence: plan.confidence,
      reasoning: plan.reasoning,
      currentPrice: currentData.price,
      evaluationDetails: details,
      ts: Date.now(),
    };

    console.log(`[Z3-Rule] SIGNAL: ${plan.direction} ${plan.symbol} @ $${currentData.price} (plan=${plan.id}, conf=${plan.confidence})`);

    // 플랜 상태 업데이트
    await this.planCache.markTriggered(plan.id);

    if (this.onSignal) {
      this.onSignal(signal);
    }
  }

  getStats() {
    return {
      checkCount: this.checkCount,
      signalCount: this.signalCount,
      activePlans: this.planCache.totalActive,
    };
  }
}
