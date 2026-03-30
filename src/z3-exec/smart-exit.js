/**
 * @module Smart Exit
 * @description 다경로 지능형 청산을 관리한다. ATR 타겟, 모멘텀 반전, 트레일링 스탑, 
 *              고정 손절, 시간 손절 및 LLM 기반 논리 무효화를 수행한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Ring     │ ──→ │ Smart    │ ──→ │ Executor │
 * │ Buffer   │     │ Exit     │     │ (Exit)   │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↑
 *                 LLM Client
 *                (Z2 유효성 검증)
 *
 * @zone z3-exec
 * @dependencies llm-client.js, logger.js
 */

import oracledb from 'oracledb';
import { logger } from "../shared/logger.js";
import { getPool } from "../shared/db.js";
import { loadQueries } from "../shared/query-loader.js";

const queries = loadQueries('z3-exec/logic-checks');

/**
 * Z3 Smart Exit — 다경로 지능형 청산
 */
export class SmartExit {
  constructor(opts = {}) {
    this.validateIntervalMs = (opts.validateIntervalSec || 600) * 1000;
    this.roundTripFeePct = opts.roundTripFeePct || 0.08;
    this.trailRetraceRatio = opts.trailRetraceRatio || 0.4;
    this.atrMultiplier = opts.atrMultiplier || 2.0;     
    this.minTargetPct = opts.minTargetPct || 0.5;
    this.momentumBars = opts.momentumBars || 3;          
    this.ringBuffer = opts.ringBuffer || null;            
    this._validateTimers = new Map();
    this._bestPnlPct = new Map();
    this._atrCache = new Map();       
    this._priceHistory = new Map();   
  }

  /** 포지션 열릴 때 모니터링 시작 — 10분 주기 LLM 논리 검증 */
  startValidation(position, onExit) {
    this._bestPnlPct.set(position.id, 0);
    this._priceHistory.set(position.id, []);

    const intervalMs = this.validateIntervalMs + Math.floor(Math.random() * Math.min(60000, this.validateIntervalMs * 0.1));
    const timer = setInterval(async () => {
      try {
        const { validatePosition } = await import('../z2-intel/llm-client.js');
        const result = await validatePosition(position.symbol, position.entryReasoning || {});

        if (!result || result.confidence < 0.5) return;

        await this._recordLogicCheck(position.id, result).catch(() => {});

        if (result.recommendation === 'FULL_EXIT') {
          logger.info(`[Z3-Exit] INVALIDATION: FULL_EXIT ${position.symbol} - "${result.reasoning || ''}"`);
          if (onExit) onExit('INVALIDATION', result);
        } else if (result.recommendation === 'PARTIAL_EXIT') {
          logger.info(`[Z3-Exit] INVALIDATION: PARTIAL_EXIT ${position.symbol}`);
          if (onExit) onExit('PARTIAL_EXIT', result);
        }
      } catch (err) {
        logger.warn(`[Z3-Exit] Validate error ${position.symbol}: ${err.message}`);
      }
    }, intervalMs);

    this._validateTimers.set(position.id, timer);
  }

  async _recordLogicCheck(positionId, result) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.insertLogicCheck, {
        posId: positionId,
        result: { type: oracledb.DB_TYPE_JSON, val: result },
        validCount: result.valid_count ?? null,
        invalidCount: result.invalid_count ?? null,
        recommendation: result.recommendation ?? null,
      }, { autoCommit: true });
    } finally {
      await conn.close();
    }
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
  }

  resetBestPnl(positionId) {
    this._bestPnlPct.set(positionId, 0);
  }

  /** 매 2초 호출: 가격 기반 체크 — LLM 불필요, 즉시 판단 */
  checkPriceExit(position, currentPrice) {
    const isLong = position.direction === 'LONG';
    const netPnlPct = this._calculateNetPnl(position, currentPrice);

    // 1. 안전망 (최우선)
    if (this._isSafetyStopHit(position, currentPrice, isLong)) return 'SAFETY_STOP';

    // 2. ATR 및 원본 타겟
    const targetReason = this._checkTargets(position, currentPrice, isLong, netPnlPct);
    if (targetReason) return targetReason;

    // 3. 트레일링 및 모멘텀
    const momentumReason = this._checkMomentumAndTrail(position, isLong, netPnlPct);
    if (momentumReason) return momentumReason;

    // 4. 시간 기반 손절
    const timeReason = this._checkTimeExit(position, isLong, netPnlPct);
    if (timeReason) return timeReason;

    return null;
  }

  _calculateNetPnl(position, currentPrice) {
    const isLong = position.direction === 'LONG';
    const entry = position.entryPrice;
    const rawPnlPct = isLong ? ((currentPrice - entry) / entry) * 100 : ((entry - currentPrice) / entry) * 100;
    return rawPnlPct - this.roundTripFeePct;
  }

  _isSafetyStopHit(position, currentPrice, isLong) {
    if (!position.safetyStop) return false;
    return isLong ? currentPrice < position.safetyStop : currentPrice > position.safetyStop;
  }

  _checkTargets(position, currentPrice, isLong, netPnlPct) {
    const atr = this._getATR(position.symbol);
    if (atr && atr > 0) {
      const targetDist = Math.max(atr * this.atrMultiplier, position.entryPrice * this.minTargetPct / 100);
      const atrTarget = isLong ? position.entryPrice + targetDist : position.entryPrice - targetDist;
      const atrReached = isLong ? currentPrice >= atrTarget : currentPrice <= atrTarget;
      if (atrReached && netPnlPct >= this.roundTripFeePct * 1.5) {
        return 'ATR_TARGET';
      }
    }
    if (position.targetPrice) {
      const targetReached = isLong ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice;
      if (targetReached) return 'TARGET';
    }
    return null;
  }

  _checkMomentumAndTrail(position, isLong, netPnlPct) {
    const currentBest = Math.max(this._bestPnlPct.get(position.id) || 0, netPnlPct);
    this._bestPnlPct.set(position.id, currentBest);
    const minTrailActivation = 1.5;

    if (currentBest > minTrailActivation) {
      const retracement = currentBest - netPnlPct;
      if (retracement >= currentBest * this.trailRetraceRatio) return 'TRAILING_STOP';
    }

    if (netPnlPct > minTrailActivation && this._checkMomentumReversal(position.symbol, isLong)) {
      return 'MOMENTUM_REVERSAL';
    }
    return null;
  }

  _checkTimeExit(position, isLong, netPnlPct) {
    const atr = this._getATR(position.symbol);
    let dynamicTimeStopMin = position.timeStopMin || 480;
    
    if (atr && position.entryPrice > 0) {
      const volRatio = (atr / position.entryPrice) * 100;
      if (volRatio > 5.0) dynamicTimeStopMin = Math.max(60, Math.round(dynamicTimeStopMin * 0.5));
      else if (volRatio > 3.0) dynamicTimeStopMin = Math.max(120, Math.round(dynamicTimeStopMin * 0.7));
    }

    const holdMin = (Date.now() - position.entryTime) / 60000;
    if (holdMin >= dynamicTimeStopMin) return 'TIME_STOP';

    if (holdMin > dynamicTimeStopMin * 0.5 && netPnlPct < -1.0) {
      if (this._checkMomentumReversal(position.symbol, isLong)) return 'EMERGENCY_EXIT';
    }
    return null;
  }

  _getATR(symbol) {
    const cached = this._atrCache.get(symbol);
    if (cached && Date.now() - cached.ts < 300000) return cached.atr;

    if (!this.ringBuffer) return null;
    let klines = this.ringBuffer.getKlines(symbol, '4h') || this.ringBuffer.getKlines(symbol, '1h');
    if (!klines || klines.length < 5) return null;

    const recent = klines.slice(-20);
    let atrSum = 0;
    for (let i = 0; i < recent.length; i++) {
      const high = recent[i].high || recent[i].h;
      const low = recent[i].low || recent[i].l;
      const prevClose = i > 0 ? (recent[i-1].close || recent[i-1].c) : null;
      const tr = prevClose ? Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose)) : high-low;
      atrSum += tr;
    }
    const atr = atrSum / recent.length;
    this._atrCache.set(symbol, { atr, ts: Date.now() });
    return atr;
  }

  _checkMomentumReversal(symbol, isLong) {
    if (!this.ringBuffer) return false;
    let klines = this.ringBuffer.getKlines(symbol, '4h') || this.ringBuffer.getKlines(symbol, '1h');
    if (!klines || klines.length < this.momentumBars) return false;

    const recent = klines.slice(-this.momentumBars);
    let reverseCount = 0;
    for (const k of recent) {
      const open = k.open || k.o;
      const close = k.close || k.c;
      if ((isLong && close < open) || (!isLong && close > open)) reverseCount++;
    }
    return reverseCount >= this.momentumBars;
  }

  stopAll() {
    for (const timer of this._validateTimers.values()) clearInterval(timer);
    this._validateTimers.clear();
    this._bestPnlPct.clear();
    this._priceHistory.clear();
    this._atrCache.clear();
  }
}
