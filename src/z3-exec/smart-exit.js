/**
 * Z3 Smart Exit — 7경로 지능형 청산
 *
 * [즉시 — 100ms 가격 체크]
 * 경로 1: ATR 동적 타겟 (진입가 ± 1×ATR → 현실적 목표)
 * 경로 2: 모멘텀 반전 (3연속 반대 봉 → 추세 꺾임)
 * 경로 3: 트레일링 스탑 (수수료 차감 순이익 되돌림)
 * 경로 4: 안전망 손절 (고정 2%)
 * 경로 5: 시간 손절 (15분)
 *
 * [보조 — 30초 LLM]
 * 경로 6: LLM 논리 무효화 (INVALIDATION)
 *
 * [원본]
 * 경로 7: LLM 타겟 도달 (비현실적이면 ATR 타겟이 먼저 발동)
 */

import { validatePosition } from '../z2-intel/llm-client.js';

export class SmartExit {
  constructor(opts = {}) {
    this.validateIntervalMs = (opts.validateIntervalSec || 30) * 1000;
    this.roundTripFeePct = opts.roundTripFeePct || 0.08;
    this.trailRetraceRatio = opts.trailRetraceRatio || 0.4;
    this.atrMultiplier = opts.atrMultiplier || 1.0;     // ATR 타겟 = 진입가 ± 1×ATR
    this.momentumBars = opts.momentumBars || 3;          // 반전 감지 봉 수
    this.ringBuffer = opts.ringBuffer || null;            // Z0 RingBuffer 참조
    this._validateTimers = new Map();
    this._bestPnlPct = new Map();
    this._atrCache = new Map();       // symbol → { atr, ts }
    this._priceHistory = new Map();   // positionId → [prices...] (100ms 샘플)
  }

  /** 포지션 열릴 때 검증 스케줄 시작 */
  startValidation(position, onExit) {
    this._bestPnlPct.set(position.id, 0);
    this._priceHistory.set(position.id, []);

    const timer = setInterval(async () => {
      try {
        const result = await validatePosition(
          position.symbol,
          position.id,
          position.entryReasoning || {}
        );

        if (result.recommendation === 'FULL_EXIT') {
          console.log(`[Z3-Exit] INVALIDATION: ${position.symbol} — ${result.reasoning}`);
          onExit('INVALIDATION', result);
          this.stopValidation(position.id);
        }
      } catch (err) {
        // 검증 실패 시 포지션 유지 (보수적)
      }
    }, this.validateIntervalMs);

    this._validateTimers.set(position.id, timer);
  }

  /** 포지션 닫힐 때 검증 중단 */
  stopValidation(positionId) {
    const timer = this._validateTimers.get(positionId);
    if (timer) {
      clearInterval(timer);
      this._validateTimers.delete(positionId);
    }
    this._bestPnlPct.delete(positionId);
    this._priceHistory.delete(positionId);
    this._atrCache.delete(positionId);
  }

  /** ATR 계산 (1분봉 기준, 20봉 평균) — 5초 캐시 */
  _getATR(symbol) {
    const cached = this._atrCache.get(symbol);
    if (cached && Date.now() - cached.ts < 5000) return cached.atr;

    if (!this.ringBuffer) return null;
    const klines = this.ringBuffer.getKlines(symbol, '1m');
    if (!klines || klines.length < 5) return null;

    const recent = klines.slice(-20);
    let atrSum = 0;
    for (const k of recent) {
      atrSum += (k.high || k.h) - (k.low || k.l);
    }
    const atr = atrSum / recent.length;
    this._atrCache.set(symbol, { atr, ts: Date.now() });
    return atr;
  }

  /** 모멘텀 반전 감지 (최근 N개 봉이 연속으로 반대 방향) */
  _checkMomentumReversal(symbol, isLong) {
    if (!this.ringBuffer) return false;
    const klines = this.ringBuffer.getKlines(symbol, '1m');
    if (!klines || klines.length < this.momentumBars) return false;

    const recent = klines.slice(-this.momentumBars);
    let reverseCount = 0;
    for (const k of recent) {
      const open = k.open || k.o;
      const close = k.close || k.c;
      if (isLong && close < open) reverseCount++;     // LONG인데 음봉
      if (!isLong && close > open) reverseCount++;    // SHORT인데 양봉
    }

    return reverseCount >= this.momentumBars; // N개 전부 반대 방향
  }

  /** 매 100ms 호출: 가격 기반 체크 — LLM 불필요, 즉시 판단 */
  checkPriceExit(position, currentPrice) {
    const isLong = position.direction === 'LONG';
    const entry = position.entryPrice;

    // 현재 수익률 (수수료 차감)
    const rawPnlPct = isLong
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100;
    const netPnlPct = rawPnlPct - this.roundTripFeePct;

    // ── 경로 1: ATR 동적 타겟 (현실적 목표) ──
    const atr = this._getATR(position.symbol);
    if (atr && atr > 0) {
      const atrTarget = isLong
        ? entry + atr * this.atrMultiplier
        : entry - atr * this.atrMultiplier;
      if (isLong && currentPrice >= atrTarget) {
        console.log(`[Z3-Exit] ATR_TARGET: ${position.symbol} price=$${currentPrice.toFixed(4)} >= atrTarget=$${atrTarget.toFixed(4)} (ATR=${atr.toFixed(4)})`);
        return 'ATR_TARGET';
      }
      if (!isLong && currentPrice <= atrTarget) {
        console.log(`[Z3-Exit] ATR_TARGET: ${position.symbol} price=$${currentPrice.toFixed(4)} <= atrTarget=$${atrTarget.toFixed(4)} (ATR=${atr.toFixed(4)})`);
        return 'ATR_TARGET';
      }
    }

    // ── 경로 7: LLM 타겟 (원본 — ATR보다 멀면 거의 안 맞음) ──
    if (position.targetPrice) {
      if (isLong && currentPrice >= position.targetPrice) return 'TARGET';
      if (!isLong && currentPrice <= position.targetPrice) return 'TARGET';
    }

    // ── 안전망: 고정 손절 ──
    if (position.safetyStop) {
      if (isLong && currentPrice <= position.safetyStop) return 'SAFETY_STOP';
      if (!isLong && currentPrice >= position.safetyStop) return 'SAFETY_STOP';
    }

    // ── 경로 3: 트레일링 스탑 ──
    const bestPnl = this._bestPnlPct.get(position.id) || 0;
    if (netPnlPct > bestPnl) {
      this._bestPnlPct.set(position.id, netPnlPct);
    }
    const currentBest = this._bestPnlPct.get(position.id) || 0;
    if (currentBest > 0 && netPnlPct > 0) {
      const retracement = currentBest - netPnlPct;
      if (retracement >= currentBest * this.trailRetraceRatio) {
        console.log(`[Z3-Exit] TRAILING_STOP: ${position.symbol} best=${currentBest.toFixed(3)}% now=${netPnlPct.toFixed(3)}%`);
        return 'TRAILING_STOP';
      }
    }

    // ── 경로 2: 모멘텀 반전 (수익 구간에서만) ──
    if (netPnlPct > 0 && this._checkMomentumReversal(position.symbol, isLong)) {
      console.log(`[Z3-Exit] MOMENTUM_REVERSAL: ${position.symbol} ${this.momentumBars}연속 반대봉, netPnl=${netPnlPct.toFixed(3)}%`);
      return 'MOMENTUM_REVERSAL';
    }

    // ── 경로 5: 시간 손절 ──
    const holdMin = (Date.now() - position.entryTime) / 60000;
    if (position.timeStopMin && holdMin >= position.timeStopMin) return 'TIME_STOP';

    return null;
  }

  stopAll() {
    for (const [id, timer] of this._validateTimers) {
      clearInterval(timer);
    }
    this._validateTimers.clear();
    this._bestPnlPct.clear();
    this._priceHistory.clear();
    this._atrCache.clear();
  }
}
