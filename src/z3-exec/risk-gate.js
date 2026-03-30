/**
 * @module Risk Gate
 * @description 매매 진입 전 리스크를 검증한다. 계좌 잔고, 동시 포지션 수, 일일 손실 한도, 
 *              R:R 비율 및 타겟/손절가의 논리적 타당성을 체크한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Rule     │ ──→ │ Risk     │ ──→ │ Executor │
 * │ Engine   │     │ Gate     │     │ (Entry)  │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone z3-exec
 * @dependencies None
 */

/**
 * Z3 Risk Gate — 진입 전 리스크 체크
 */
export class RiskGate {
  /**
   * @param {Object} opts 리스크 설정
   */
  constructor(opts = {}) {
    this.maxPositionPct = opts.maxPositionPct || 10.0;   // 1회 투자 최대 자본비율
    this.safetyStopPct = opts.safetyStopPct || 4.0;
    this.maxDailyLossPct = opts.maxDailyLossPct || 5.0;  // 일일 최대 손실 (%)
    this.maxOpenTrades = opts.maxOpenTrades || 5;
    this.maxLeverage = opts.maxLeverage || 3;

    this.openTrades = [];
    this.dailyPnl = 0;
  }

  /**
   * 진입 가능 여부를 체크한다.
   * @param {Object} signal 진입 시그널
   * @param {number} balance 현재 잔고
   * @param {number} currentPrice 현재가
   * @param {string} macroRegime 매크로 상태
   * @returns {Object} { allowed, reason, positionSize, ... }
   */
  check(signal, balance, currentPrice, macroRegime = 'neutral') {
    // 1. 기본 수량적 한도 체크
    const limitCheck = this._checkLimits(signal, balance, macroRegime);
    if (!limitCheck.allowed) return limitCheck;

    // 2. 포지션 사이징 계산
    const sizing = this._calculateSizing(balance, currentPrice);
    if (!sizing.allowed) return sizing;

    // 3. 가격(타겟/손절) 논리 검증
    const priceCheck = this._validatePrices(signal, currentPrice);
    if (!priceCheck.allowed) return priceCheck;

    // 4. R:R (Risk/Reward) 비율 검증
    const rrCheck = this._checkRR(signal, currentPrice);
    if (!rrCheck.allowed) return rrCheck;

    const side = signal.direction === 'LONG' ? 1 : -1;
    const safetyStop = currentPrice * (1 - side * this.safetyStopPct / 100);

    return {
      allowed: true,
      positionSize: sizing.qty,
      positionValue: sizing.positionValue,
      safetyStop,
      leverage: this.maxLeverage,
    };
  }

  /** 기본 한도 체크 (동시 포지션, 일일 손실, 중복 진입, 매크로) */
  _checkLimits(signal, balance, macroRegime) {
    if (this.openTrades.length >= this.maxOpenTrades) {
      return { allowed: false, reason: `동시 포지션 ${this.maxOpenTrades}개 초과` };
    }

    if (this.dailyPnl <= -(this.maxDailyLossPct / 100) * balance) {
      return { allowed: false, reason: `일일 최대 손실 ${this.maxDailyLossPct}% 초과` };
    }

    if (this.openTrades.some(t => t.symbol === signal.symbol)) {
      return { allowed: false, reason: `${signal.symbol} 이미 포지션 보유` };
    }

    if (signal.direction === 'LONG' && macroRegime === 'risk_off') {
      return { allowed: false, reason: `매크로 위험 감지 (risk_off): 롱 진입 금지` };
    }

    return { allowed: true };
  }

  /** 포지션 사이징 및 최소 주문 금액 체크 */
  _calculateSizing(balance, currentPrice) {
    const rawPositionValue = balance * (this.maxPositionPct / 100);
    const minNotional = 105; // 바이낸스 최소 $100 + 안전 버퍼 $5
    
    let positionValue = rawPositionValue;
    if (positionValue < minNotional) {
      if (minNotional > balance * 0.15) {
        return { allowed: false, reason: `계좌 자산 대비 최소 주문 금액($${minNotional})이 너무 큼` };
      }
      positionValue = minNotional;
    }

    return { 
      allowed: true, 
      positionValue, 
      qty: positionValue / currentPrice 
    };
  }

  /** 타겟 및 손절가 논리적 타당성 검증 */
  _validatePrices(signal, currentPrice) {
    const isLong = signal.direction === 'LONG';

    // 손절가 검증
    if (signal.stopPrice) {
      const isStopValid = isLong ? signal.stopPrice < currentPrice : signal.stopPrice > currentPrice;
      if (!isStopValid) {
        return { allowed: false, reason: `손절가 역전: 현재가($${currentPrice})가 손절가($${signal.stopPrice}) 돌파` };
      }
      const stopDistPct = Math.abs(currentPrice - signal.stopPrice) / currentPrice * 100;
      if (stopDistPct < 1.0) {
        return { allowed: false, reason: `손절가 너무 가까움: ${stopDistPct.toFixed(2)}% < 1.0%` };
      }
    }

    // 타겟가 검증
    if (signal.targetPrice) {
      const distPct = Math.abs(signal.targetPrice - currentPrice) / currentPrice * 100;
      const isTargetValid = isLong ? signal.targetPrice > currentPrice : signal.targetPrice < currentPrice;
      if (!isTargetValid) {
        return { allowed: false, reason: `타겟가 역전: 현재가($${currentPrice})가 타겟 도달` };
      }
      if (distPct < 0.2) {
        return { allowed: false, reason: `타겟가 너무 가까움: ${distPct.toFixed(3)}% < 0.2%` };
      }
      if (distPct > 15.0) {
        return { allowed: false, reason: `타겟가 비현실적: ${distPct.toFixed(1)}% > 15%` };
      }
    }

    return { allowed: true };
  }

  /** R:R (Risk/Reward) 비율 체크 */
  _checkRR(signal, currentPrice) {
    if (signal.targetPrice && signal.stopPrice) {
      const rewardDist = Math.abs(signal.targetPrice - currentPrice);
      const riskDist = Math.abs(currentPrice - signal.stopPrice);
      if (riskDist > 0) {
        const rrRatio = rewardDist / riskDist;
        if (rrRatio < 2.0) {
          return { allowed: false, reason: `R:R 부족: ${rrRatio.toFixed(2)} < 1.5` };
        }
      }
    }
    return { allowed: true };
  }

  addTrade(trade) { this.openTrades.push(trade); }
  removeTrade(tradeId) { this.openTrades = this.openTrades.filter(t => t.id !== tradeId); }
  recordExit(pnl) { this.dailyPnl += pnl; }
  resetDaily() { this.dailyPnl = 0; }
}
