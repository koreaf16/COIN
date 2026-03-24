/**
 * Z3 Risk Gate — 진입 전 리스크 체크
 * 기존 L3 RiskGate 확장: 지능형 청산 지원
 */

export class RiskGate {
  constructor(opts = {}) {
    this.maxPositionPct = opts.maxPositionPct || 10.0;   // 1회 투자 최대 자본비율
    this.safetyStopPct = opts.safetyStopPct || 2.0;      // 고정 안전망 손절 (%)
    this.maxDailyLossPct = opts.maxDailyLossPct || 5.0;  // 일일 최대 손실 (%)
    this.maxOpenTrades = opts.maxOpenTrades || 3;
    this.cooldownSec = opts.cooldownSec || 60;
    this.maxLeverage = opts.maxLeverage || 3;
    this.symbolLossCooldownSec = opts.symbolLossCooldownSec || 300; // 심볼별 손절 후 쿨다운 (5분)

    this.openTrades = [];
    this.dailyPnl = 0;
    this.lastExitTime = 0;
    this._symbolLossTime = new Map(); // symbol → 마지막 손절 시각
  }

  check(signal, balance, currentPrice) {
    if (this.openTrades.length >= this.maxOpenTrades) {
      return { allowed: false, reason: `동시 포지션 ${this.maxOpenTrades}개 초과` };
    }

    if (this.dailyPnl <= -(this.maxDailyLossPct / 100) * balance) {
      return { allowed: false, reason: `일일 최대 손실 ${this.maxDailyLossPct}% 초과` };
    }

    const elapsed = (Date.now() - this.lastExitTime) / 1000;
    if (elapsed < this.cooldownSec && this.lastExitTime > 0) {
      return { allowed: false, reason: `쿨다운 ${Math.ceil(this.cooldownSec - elapsed)}초` };
    }

    if (this.openTrades.some(t => t.symbol === signal.symbol)) {
      return { allowed: false, reason: `${signal.symbol} 이미 포지션 보유` };
    }

    // 심볼별 손절 후 쿨다운 (같은 심볼 연속 손절 방지)
    const symbolLossTs = this._symbolLossTime.get(signal.symbol) || 0;
    const symbolElapsed = (Date.now() - symbolLossTs) / 1000;
    if (symbolElapsed < this.symbolLossCooldownSec && symbolLossTs > 0) {
      return { allowed: false, reason: `${signal.symbol} 손절 후 쿨다운 ${Math.ceil(this.symbolLossCooldownSec - symbolElapsed)}초` };
    }

    // 포지션 사이징 (Binance minNotional=$100 + stepSize floor 보상)
    const rawPositionValue = balance * (this.maxPositionPct / 100);
    // BTC처럼 stepSize가 큰 심볼은 floor 시 notional이 크게 줄어들 수 있으므로 2배 버퍼
    const positionValue = Math.max(rawPositionValue, 210);
    const qty = positionValue / currentPrice;

    // 안전망 손절 (고정)
    const side = signal.direction === 'LONG' ? 1 : -1;
    const safetyStop = currentPrice * (1 - side * this.safetyStopPct / 100);

    // [사전 차단] 진입 전 LLM 손절가와 현재가 논리 모순 검증
    if (signal.stopPrice) {
      const isLong = signal.direction === 'LONG';
      const isStopValid = isLong 
        ? signal.stopPrice < currentPrice  // 롱: 손절가가 현재가 아래여야 함
        : signal.stopPrice > currentPrice; // 숏: 손절가가 현재가 위여야 함
        
      if (!isStopValid) {
        return { 
          allowed: false, 
          reason: `가격 역전 오류: 현재가($${currentPrice})가 LLM 손절가($${signal.stopPrice})를 이미 돌파함` 
        };
      }
    }

    return {
      allowed: true,
      positionSize: qty,
      positionValue,
      safetyStop,
      leverage: this.maxLeverage,
    };
  }

  addTrade(trade) { this.openTrades.push(trade); }
  removeTrade(tradeId) { this.openTrades = this.openTrades.filter(t => t.id !== tradeId); }
  recordExit(pnl, symbol) {
    this.dailyPnl += pnl;
    this.lastExitTime = Date.now();
    // 손실 시 해당 심볼 쿨다운 기록
    if (pnl < 0 && symbol) {
      this._symbolLossTime.set(symbol, Date.now());
    }
  }
  resetDaily() { this.dailyPnl = 0; }
}
