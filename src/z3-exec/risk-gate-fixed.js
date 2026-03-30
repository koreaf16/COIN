export class RiskGate {
  constructor(opts = {}) {
    this.maxPositionPct = opts.maxPositionPct || 10.0;
    this.maxRiskPct = opts.maxRiskPct || 1.0;
    this.safetyStopPct = opts.safetyStopPct || 4.0;
    this.maxDailyLossPct = opts.maxDailyLossPct || 5.0;
    this.maxOpenTrades = opts.maxOpenTrades || 5;
    this.maxLeverage = opts.maxLeverage || 3;

    this.openTrades = [];
    this.dailyPnl = 0;
  }

  check(signal, balance, currentPrice, macroRegime = 'neutral') {
    const limitCheck = this._checkLimits(signal, balance, macroRegime);
    if (!limitCheck.allowed) return limitCheck;

    const priceCheck = this._validatePrices(signal, currentPrice);
    if (!priceCheck.allowed) return priceCheck;

    const rrCheck = this._checkRR(signal, currentPrice);
    if (!rrCheck.allowed) return rrCheck;

    const safetyStop = this._resolveEffectiveStop(signal, currentPrice);
    const sizing = this._calculateSizing(balance, currentPrice, safetyStop);
    if (!sizing.allowed) return sizing;

    return {
      allowed: true,
      positionSize: sizing.qty,
      positionValue: sizing.positionValue,
      safetyStop,
      riskAmount: sizing.riskAmount,
      riskPct: sizing.riskPct,
      leverage: this.maxLeverage,
    };
  }

  _checkLimits(signal, balance, macroRegime) {
    if (this.openTrades.length >= this.maxOpenTrades) {
      return { allowed: false, reason: `max open trades exceeded (${this.maxOpenTrades})` };
    }

    if (this.dailyPnl <= -(this.maxDailyLossPct / 100) * balance) {
      return { allowed: false, reason: `daily loss limit exceeded (${this.maxDailyLossPct}%)` };
    }

    if (this.openTrades.some(trade => trade.symbol === signal.symbol)) {
      return { allowed: false, reason: `${signal.symbol} already has an open position` };
    }

    if (signal.direction === 'LONG' && macroRegime === 'risk_off') {
      return { allowed: false, reason: 'LONG blocked in risk_off macro regime' };
    }

    return { allowed: true };
  }

  _calculateSizing(balance, currentPrice, stopPrice) {
    const maxPositionValue = balance * (this.maxPositionPct / 100);
    const maxRiskAmount = balance * (this.maxRiskPct / 100);
    const minNotional = 105;
    const stopDistance = Math.abs(currentPrice - stopPrice);

    if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
      return { allowed: false, reason: 'invalid stop distance for sizing' };
    }

    const riskBasedPositionValue = (maxRiskAmount * currentPrice) / stopDistance;
    let positionValue = Math.min(riskBasedPositionValue, maxPositionValue);
    if (positionValue < minNotional) {
      return {
        allowed: false,
        reason: `risk-based position too small for minimum notional (${positionValue.toFixed(2)} < ${minNotional})`,
      };
    }

    const qty = positionValue / currentPrice;
    const riskAmount = qty * stopDistance;
    return {
      allowed: true,
      positionValue,
      qty,
      riskAmount,
      riskPct: balance > 0 ? (riskAmount / balance) * 100 : 0,
    };
  }

  _validatePrices(signal, currentPrice) {
    const isLong = signal.direction === 'LONG';

    if (signal.stopPrice) {
      const isStopValid = isLong ? signal.stopPrice < currentPrice : signal.stopPrice > currentPrice;
      if (!isStopValid) {
        return { allowed: false, reason: `stop price is invalid at current price ${currentPrice}` };
      }
      const stopDistPct = Math.abs(currentPrice - signal.stopPrice) / currentPrice * 100;
      if (stopDistPct < 1.0) {
        return { allowed: false, reason: `stop distance too tight (${stopDistPct.toFixed(2)}%)` };
      }
    }

    if (signal.targetPrice) {
      const distPct = Math.abs(signal.targetPrice - currentPrice) / currentPrice * 100;
      const isTargetValid = isLong ? signal.targetPrice > currentPrice : signal.targetPrice < currentPrice;
      if (!isTargetValid) {
        return { allowed: false, reason: `target price is invalid at current price ${currentPrice}` };
      }
      if (distPct < 0.2) {
        return { allowed: false, reason: `target distance too tight (${distPct.toFixed(3)}%)` };
      }
      if (distPct > 15.0) {
        return { allowed: false, reason: `target distance too wide (${distPct.toFixed(1)}%)` };
      }
    }

    return { allowed: true };
  }

  _checkRR(signal, currentPrice) {
    if (signal.targetPrice && signal.stopPrice) {
      const rewardDist = Math.abs(signal.targetPrice - currentPrice);
      const riskDist = Math.abs(currentPrice - signal.stopPrice);
      if (riskDist > 0) {
        const rrRatio = rewardDist / riskDist;
        if (rrRatio < 2.0) {
          return { allowed: false, reason: `R:R ${rrRatio.toFixed(2)} < 2.0` };
        }
      }
    }
    return { allowed: true };
  }

  _resolveEffectiveStop(signal, entryPrice) {
    const isLong = signal.direction === 'LONG';
    const side = isLong ? 1 : -1;
    const fallbackStop = entryPrice * (1 - side * this.safetyStopPct / 100);

    if (!signal.stopPrice) return fallbackStop;

    const llmStopValid = isLong ? signal.stopPrice < entryPrice : signal.stopPrice > entryPrice;
    if (!llmStopValid) return fallbackStop;

    const llmStopDistPct = Math.abs(entryPrice - signal.stopPrice) / entryPrice * 100;
    if (llmStopDistPct < 1.0) {
      return entryPrice * (1 - side * 0.01);
    }
    if (llmStopDistPct <= 15.0) {
      return signal.stopPrice;
    }
    return fallbackStop;
  }

  addTrade(trade) {
    this.openTrades.push(trade);
  }

  removeTrade(tradeId) {
    this.openTrades = this.openTrades.filter(trade => trade.id !== tradeId);
  }

  recordExit(pnl) {
    this.dailyPnl += pnl;
  }

  resetDaily() {
    this.dailyPnl = 0;
  }
}
