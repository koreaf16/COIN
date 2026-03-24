/**
 * Z3 Smart Exit — 7경로 지능형 청산
 *
 * [즉시 — 100ms 가격 체크]
 * 경로 1: ATR 동적 타겟 (진입가 ± 2×ATR, 최소 수수료×2.5 보장)
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


export class SmartExit {
  constructor(opts = {}) {
    this.validateIntervalMs = (opts.validateIntervalSec || 180) * 1000;
    this.roundTripFeePct = opts.roundTripFeePct || 0.08;
    this.trailRetraceRatio = opts.trailRetraceRatio || 0.4;
    this.atrMultiplier = opts.atrMultiplier || 2.0;     // ATR 타겟 = 진입가 ± 2×ATR
    this.minTargetPct = opts.minTargetPct || this.roundTripFeePct * 5; // ATR 타겟 최소 수익률 (수수료×5 = 0.40%)
    this.momentumBars = opts.momentumBars || 3;          // 반전 감지 봉 수
    this.ringBuffer = opts.ringBuffer || null;            // Z0 RingBuffer 참조
    this._validateTimers = new Map();
    this._bestPnlPct = new Map();
    this._atrCache = new Map();       // symbol → { atr, ts }
    this._priceHistory = new Map();   // positionId → [prices...] (100ms 샘플)
  }

  /** 포지션 열릴 때 모니터링 시작 (LLM 검증 제거 — stop_conditions/SL/TP로 대체) */
  startValidation(position, onExit) {
    this._bestPnlPct.set(position.id, 0);
    this._priceHistory.set(position.id, []);
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
    // ATR 캐시는 symbol 키로 저장 (포지션 간 공유) → positionId로 삭제하지 않음
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

    // ── 경로 1: ATR 동적 타겟 (최소 수수료×2.5 보장 + 순이익 검증) ──
    const atr = this._getATR(position.symbol);
    if (atr && atr > 0) {
      // ATR 기반 거리와 최소 수익률 거리 중 큰 쪽 사용
      const atrDist = atr * this.atrMultiplier;
      const minDist = entry * this.minTargetPct / 100;
      const targetDist = Math.max(atrDist, minDist);
      const atrTarget = isLong ? entry + targetDist : entry - targetDist;
      const atrReached = isLong ? currentPrice >= atrTarget : currentPrice <= atrTarget;
      if (atrReached) {
        // 순이익이 수수료의 1.5배 이상일 때만 ATR_TARGET 발동
        // (가격이 도달했어도 슬리피지/수수료로 순손실이면 청산 안 함)
        if (netPnlPct >= this.roundTripFeePct * 1.5) {
          console.log(`[Z3-Exit] ATR_TARGET: ${position.symbol} price=$${currentPrice.toFixed(4)} target=$${atrTarget.toFixed(4)} netPnl=${netPnlPct.toFixed(3)}% (ATR=${atr.toFixed(4)})`);
          return 'ATR_TARGET';
        }
        // 가격 도달했지만 수수료 미달 → 트레일링으로 위임 (로그만)
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

    // ── 경로 3: 트레일링 스탑 (최소 순이익 확보 후 활성화) ──
    const bestPnl = this._bestPnlPct.get(position.id) || 0;
    if (netPnlPct > bestPnl) {
      this._bestPnlPct.set(position.id, netPnlPct);
    }
    const currentBest = this._bestPnlPct.get(position.id) || 0;
    const minTrailActivation = this.roundTripFeePct * 5; // 수수료×5 (0.40%) 이상에서만 트레일링
    if (currentBest > minTrailActivation) {
      const retracement = currentBest - netPnlPct;
      if (retracement >= currentBest * this.trailRetraceRatio) {
        console.log(`[Z3-Exit] TRAILING_STOP: ${position.symbol} best=${currentBest.toFixed(3)}% now=${netPnlPct.toFixed(3)}% (minActivation=${minTrailActivation.toFixed(3)}%)`);
        return 'TRAILING_STOP';
      }
    }

    // ── 경로 2: 모멘텀 반전 (수수료 커버 수익 구간에서만) ──
    if (netPnlPct > minTrailActivation && this._checkMomentumReversal(position.symbol, isLong)) {
      console.log(`[Z3-Exit] MOMENTUM_REVERSAL: ${position.symbol} ${this.momentumBars}연속 반대봉, netPnl=${netPnlPct.toFixed(3)}%`);
      return 'MOMENTUM_REVERSAL';
    }

    // ── 경로 5: 동적 시간 손절 (Dynamic Time Stop) ──
    // 변동성이 크면 승부가 빨리 나야 함. ATR이 높을수록 시간을 단축.
    let dynamicTimeStopMin = position.timeStopMin || 15;
    if (atr && entry > 0) {
      const volRatio = (atr / entry) * 100; // 1m ATR %
      if (volRatio > 0.5) dynamicTimeStopMin = Math.max(3, Math.round(dynamicTimeStopMin * 0.5));
      else if (volRatio > 0.3) dynamicTimeStopMin = Math.max(5, Math.round(dynamicTimeStopMin * 0.7));
    }

    const holdMin = (Date.now() - position.entryTime) / 60000;
    if (holdMin >= dynamicTimeStopMin) {
      console.log(`[Z3-Exit] DYNAMIC_TIME_STOP: ${position.symbol} ${holdMin.toFixed(1)}min exceeded (dynamic limit=${dynamicTimeStopMin}min, volRatio=${((atr/entry)*100).toFixed(3)}%)`);
      return 'TIME_STOP';
    }

    // ── [신규] 경로 8: 긴급 탈출 (Emergency Exit — RIVERUSDT 교훈) ──
    // 1. 진입 후 절반의 시간이 지났는데도 마이너스 수익권이며 반등 기미가 없을 때
    if (holdMin > dynamicTimeStopMin * 0.5 && netPnlPct < -0.3) {
      const isOppositeCandle = this._checkMomentumReversal(position.symbol, isLong);
      if (isOppositeCandle) {
        console.log(`[Z3-Exit] EMERGENCY_EXIT: No bounce detected after half-time. Market is too heavy.`);
        return 'EMERGENCY_EXIT';
      }
    }

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
