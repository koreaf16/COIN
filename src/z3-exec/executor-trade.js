/**
 * @module Executor Trade
 * @description 매매 진입(Entry) 및 청산(Exit) 로직을 담당한다. 실제 거래소 주문 및 DB 상태 업데이트를 수행한다.
 *
 * @zone z3-exec
 * @dependencies executor-sync.js, logger.js, db.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from "../shared/db.js";
import { loadQueries } from "../shared/query-loader.js";
import { ExecutorSync } from "./executor-sync.js";

const queries = loadQueries('z3-exec/executor');

export class ExecutorTrade extends ExecutorSync {
  constructor() {
    super();
  }

  /** 실제 진입 실행 */
  async _doSignal(signal, currentPrice, macroRegime = 'neutral') {
    const check = this.riskGate.check(signal, this.balance, currentPrice, macroRegime);
    if (!check.allowed) {
      this.stats.rejected++;
      logger.info(`[Z3-Exec] REJECTED: ${check.reason}`);
      return;
    }
    
    if (await this._isSlippageTooHigh(signal, check.positionValue)) return;

    try {
      const tradeData = await this._executeEntry(signal, currentPrice, check, check.safetyStop);
      this._recordEntry(signal, tradeData, check.safetyStop);
      await this._consumeTriggeredPlan(signal);
    } catch (err) {
      await this._handleEntryError(signal, err);
    }
  }

  async _isSlippageTooHigh(signal, positionValue) {
    if (!this.liveMode || !this.binance.isReady()) return false;
    try {
      const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
      const { slippagePct } = await this.binance.estimateSlippage(signal.symbol, positionValue, side);
      if (slippagePct > this.maxSlippagePct) {
        this.stats.rejected++;
        logger.info(`[Z3-Exec] REJECTED: ${signal.symbol} slippage ${slippagePct.toFixed(2)}% > ${this.maxSlippagePct}%`);
        return true;
      }
    } catch (err) { logger.warn(`[Z3-Exec] Slippage check failed ${signal.symbol}: ${err.message}`); }
    return false;
  }

  _resolveEntryOrderPlan(signal, currentPrice) {
    const priceCondition = signal?.entryConditions?.price;
    if (!priceCondition || typeof priceCondition?.value !== 'number') {
      return { executionType: 'MARKET', label: 'MARKET', limitPrice: null, reason: 'no_price_condition' };
    }

    const threshold = priceCondition.value;
    const op = priceCondition.op;
    const distancePct = currentPrice > 0 ? Math.abs(currentPrice - threshold) / currentPrice * 100 : 0;
    const nearThreshold = distancePct <= Math.max(this.entryLimitFallbackPct || 0.15, 0.05);

    if (signal.direction === 'LONG') {
      if ((op === '<' || op === '<=') && threshold < currentPrice && !nearThreshold) {
        return { executionType: 'LIMIT', label: 'PULLBACK_LIMIT', limitPrice: threshold, reason: `${op}${threshold}` };
      }
      if (op === '>' || op === '>=') {
        return { executionType: 'MARKET', label: 'BREAKOUT_MARKET', limitPrice: null, reason: `${op}${threshold}` };
      }
    }

    if (signal.direction === 'SHORT') {
      if ((op === '>' || op === '>=') && threshold > currentPrice && !nearThreshold) {
        return { executionType: 'LIMIT', label: 'PULLBACK_LIMIT', limitPrice: threshold, reason: `${op}${threshold}` };
      }
      if (op === '<' || op === '<=') {
        return { executionType: 'MARKET', label: 'BREAKOUT_MARKET', limitPrice: null, reason: `${op}${threshold}` };
      }
    }

    return { executionType: 'MARKET', label: 'MARKET', limitPrice: null, reason: `${op}${threshold}` };
  }

  async _executeEntry(signal, currentPrice, check, effectiveStop) {
    const entryOrderPlan = this._resolveEntryOrderPlan(signal, currentPrice);
    if (this.liveMode) {
      await this.binance.setupSymbol(signal.symbol, this.leverage);
      const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
      const order = entryOrderPlan.executionType === 'LIMIT'
        ? await this._executeLiveLimitEntry(signal, side, check.positionSize, entryOrderPlan.limitPrice, currentPrice)
        : await this.binance.marketOrder(signal.symbol, side, check.positionSize);
      const entryPrice = order.avgPrice || order.price || currentPrice;
      const executedQty = order.executedQty || check.positionSize;

      const stopSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
      const stopOrder = await this.binance.stopMarketOrder(signal.symbol, stopSide, executedQty, effectiveStop);
      
      if (signal.targetPrice) {
        await this.binance.takeProfitMarketOrder(signal.symbol, stopSide, executedQty, signal.targetPrice).catch(()=>{});
      }
      await this._updateBalances();
      return {
        entryPrice,
        executedQty,
        orderId: order.orderId,
        stopOrderId: stopOrder.orderId,
        entryOrderType: entryOrderPlan.label,
      };
    }
    return this._simulateEntry(signal, currentPrice, check, entryOrderPlan);
  }

  async _executeLiveLimitEntry(signal, side, qty, limitPrice, fallbackPrice) {
    const order = await this.binance.limitOrder(signal.symbol, side, qty, limitPrice);
    const startedAt = Date.now();
    let latest = order;

    while (Date.now() - startedAt < this.entryLimitTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      latest = await this.binance.getOrder(signal.symbol, order.orderId).catch(() => latest);
      if (latest?.status === 'FILLED') {
        return {
          orderId: order.orderId,
          avgPrice: latest.avgPrice || limitPrice,
          executedQty: latest.executedQty || qty,
          status: latest.status,
        };
      }
    }

    await this.binance.cancelAllOrders(signal.symbol).catch(() => {});

    const filledQty = latest?.executedQty || 0;
    if (filledQty > 0 && filledQty < qty) {
      const remainQty = Math.max(qty - filledQty, 0);
      const marketFill = remainQty > 0
        ? await this.binance.marketOrder(signal.symbol, side, remainQty)
        : null;
      const marketQty = marketFill?.executedQty || 0;
      const totalQty = filledQty + marketQty;
      const weightedPrice = totalQty > 0
        ? (((latest.avgPrice || limitPrice) * filledQty) + ((marketFill?.avgPrice || fallbackPrice) * marketQty)) / totalQty
        : (latest.avgPrice || limitPrice);
      return {
        orderId: marketFill?.orderId || order.orderId,
        avgPrice: weightedPrice,
        executedQty: totalQty,
        status: marketFill?.status || latest.status,
      };
    }

    return await this.binance.marketOrder(signal.symbol, side, qty);
  }

  _simulateEntry(signal, currentPrice, check, entryOrderPlan) {
    if (entryOrderPlan?.executionType === 'LIMIT' && Number.isFinite(entryOrderPlan.limitPrice)) {
      return {
        entryPrice: entryOrderPlan.limitPrice,
        executedQty: check.positionSize,
        orderId: `sim_${Date.now()}`,
        stopOrderId: null,
        entryOrderType: entryOrderPlan.label,
      };
    }

    const slippageBps = Math.min(2 + (check.positionSize * currentPrice) / 50000, 8);
    const slippageDir = signal.direction === 'LONG' ? 1 : -1;
    const entryPrice = currentPrice * (1 + slippageDir * slippageBps / 10000);
    return {
      entryPrice,
      executedQty: check.positionSize,
      orderId: `sim_${Date.now()}`,
      stopOrderId: null,
      entryOrderType: entryOrderPlan?.label || 'MARKET',
    };
  }

  _recordEntry(signal, tradeData, effectiveStop) {
    const posId = this.liveMode ? (tradeData.orderId || Date.now()) : Date.now();
    const position = {
      id: posId, planId: signal.planId, symbol: signal.symbol, direction: signal.direction,
      entryPrice: tradeData.entryPrice, entryTime: Date.now(), qty: tradeData.executedQty,
      initialQty: tradeData.executedQty, realizedPnlNet: 0, realizedFeeTotal: 0,
      targetPrice: signal.targetPrice, safetyStop: effectiveStop, orderId: tradeData.orderId,
      stopOrderId: tradeData.stopOrderId, entryConditions: signal.entryConditions,
      entryOrderType: tradeData.entryOrderType || 'MARKET',
      entryReasoning: { planId: signal.planId, details: signal.evaluationDetails, reasoning: signal.reasoning, entryConditions: signal.entryConditions },
      timeStopMin: signal.timeStopMin || 480, stopConditions: signal.stopConditions, confidence: signal.confidence,
    };
    this.activePositions.set(posId, position);
    this.riskGate.addTrade(position);
    this.stats.entries++;
    this._startSmartExit(posId, position);
    if (this.onTrade) this.onTrade({ action: 'ENTRY', positionId: posId, ...position });
  }

  _startSmartExit(posId, position) {
    this.smartExit.startValidation(position, (reason, details) => {
      const price = this.ringBuffer.getLastPrice(position.symbol);
      if (reason === 'PARTIAL_EXIT') this._partialExitPosition(posId, price, reason, details);
      else this._exitPosition(posId, price, reason, details);
    });
  }

  async _handleEntryError(signal, err) {
    logger.error(`[Z3-Exec] Entry failed ${signal.symbol}: ${err.message}`);
    if (signal.planId) {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(queries.markPlanFailed, { id: signal.planId }, { autoCommit: true });
      } finally { await conn.close(); }
    }
  }

  /** 포지션 청산 실행 */
  async _consumeTriggeredPlan(signal) {
    if (typeof signal?._markTriggered !== 'function') return;
    try {
      await signal._markTriggered();
    } catch (err) {
      logger.warn(`[Z3-Exec] Failed to mark plan triggered ${signal.planId || signal.symbol}: ${err.message}`);
    }
  }

  async _exitPosition(posId, exitPrice, exitReason, exitDetails = null) {
    const position = this.activePositions.get(posId);
    if (!position || position._exiting) return;

    position._exiting = true;
    this.smartExit.stopValidation(posId);

    try {
      let finalExitPrice = exitPrice;
      if (this.liveMode) {
        finalExitPrice = await this._executeLiveExit(position, exitPrice, exitReason);
      } else {
        finalExitPrice = this._clampSimExitPrice(position, exitPrice, exitReason);
      }
      this._finalizeExit(posId, position, finalExitPrice, exitReason, exitDetails);
    } catch (err) {
      await this._handleExitError(posId, position, exitPrice, exitReason, exitDetails, err);
    }
  }

  async _executeLiveExit(position, exitPrice, exitReason) {
    try { await this.binance.cancelAllOrders(position.symbol); } catch (_) {}
    if (exitReason !== 'EXCHANGE_CLOSED') {
      const closeOrder = await this.binance.closePosition(position.symbol, position.direction, position.qty);
      await this._updateBalances();
      return closeOrder.avgPrice || exitPrice;
    }
    return exitPrice;
  }

  _clampSimExitPrice(position, exitPrice, exitReason) {
    if (exitReason === 'SAFETY_STOP' && position.safetyStop) {
      const isLong = position.direction === 'LONG';
      if (isLong && exitPrice < position.safetyStop) return position.safetyStop;
      if (!isLong && exitPrice > position.safetyStop) return position.safetyStop;
    }
    return exitPrice;
  }

  _finalizeExit(posId, position, exitPrice, exitReason, exitDetails) {
    this.activePositions.delete(posId);
    this.riskGate.removeTrade(posId);
    const legPnl = this._calculatePnl(position, exitPrice);
    const totalPnl = this._getCumulativePnl(position, legPnl);
    if (!this.liveMode) this.balance += legPnl.net;
    this.stats.exits++;
    this.riskGate.recordExit(legPnl.net, position.symbol);

    if (this.onTrade) {
      this.onTrade({
        action: 'EXIT', positionId: posId, symbol: position.symbol, direction: position.direction,
        entryPrice: position.entryPrice, entryTime: position.entryTime, exitPrice, exitReason, exitDetails,
        qty: position.qty, pnlPct: totalPnl.pct, pnlNet: totalPnl.net, feeTotal: legPnl.fee, cumulativeFeeTotal: totalPnl.fee,
        holdTimeSec: (Date.now() - position.entryTime) / 1000,
        planId: position.planId, entryReasoning: position.entryReasoning,
      });
    }
    logger.info(`[Z3-Exec] EXIT ${exitReason} ${position.symbol} PnL=${totalPnl.net.toFixed(2)} (${totalPnl.pct.toFixed(3)}%)`);
  }

  _calculatePnl(position, exitPrice) {
    const dir = position.direction === 'LONG' ? 1 : -1;
    const fee = position.qty * position.entryPrice * 0.0008;
    const gross = dir * (exitPrice - position.entryPrice) * position.qty;
    const net = gross - fee;
    const margin = position.qty * position.entryPrice / this.leverage;
    return { net, fee, pct: margin > 0 ? (net / margin) * 100 : 0 };
  }

  _getCumulativePnl(position, extraPnl = null) {
    const realizedNet = position.realizedPnlNet || 0;
    const realizedFee = position.realizedFeeTotal || 0;
    const totalNet = realizedNet + (extraPnl?.net || 0);
    const totalFee = realizedFee + (extraPnl?.fee || 0);
    const baseQty = position.initialQty || position.qty;
    const initialMargin = baseQty * position.entryPrice / this.leverage;
    return {
      net: totalNet,
      fee: totalFee,
      pct: initialMargin > 0 ? (totalNet / initialMargin) * 100 : 0,
    };
  }

  async _handleExitError(posId, position, exitPrice, exitReason, exitDetails, err) {
    logger.error(`[Z3-Exec] Exit failed ${position.symbol}: ${err.message}`);
    if (err.message.includes('ReduceOnly') || err.message.includes('already closed')) {
      this._finalizeExit(posId, position, exitPrice, 'EXCHANGE_CLOSED', exitDetails);
    } else {
      position._exiting = false;
      this._startSmartExit(posId, position);
    }
  }

  async _partialExitPosition(posId, exitPrice, reason, exitDetails = null) {
    const position = this.activePositions.get(posId);
    if (!position || position._partialExited) return;
    position._partialExited = true;
    
    const partialQty = this.liveMode ? this.binance._roundQty(position.symbol, position.qty / 2) : position.qty / 2;
    const remainQty = position.qty - partialQty;
    if (partialQty <= 0 || remainQty <= 0) {
       position._partialExited = false;
       return;
    }

    try {
      let finalExitPrice = exitPrice;
      if (this.liveMode) {
        await this.binance.cancelAllOrders(position.symbol).catch(()=>{});
        const closeOrder = await this.binance.closePosition(position.symbol, position.direction, partialQty);
        finalExitPrice = closeOrder.avgPrice || exitPrice;
        const stopSide = position.direction === 'LONG' ? 'SELL' : 'BUY';
        await this.binance.stopMarketOrder(position.symbol, stopSide, remainQty, position.entryPrice).catch(()=>{});
        await this._updateBalances();
      }
      this._finalizePartialExit(posId, position, finalExitPrice, partialQty, remainQty, reason);
    } catch (err) {
      position._partialExited = false;
      logger.error(`[Z3-Exec] Partial exit failed ${position.symbol}: ${err.message}`);
    }
  }

  _finalizePartialExit(posId, position, exitPrice, partialQty, remainQty, reason) {
    const pnl = this._calculatePnl({ ...position, qty: partialQty }, exitPrice);
    if (!this.liveMode) this.balance += pnl.net;
    this.riskGate.recordExit(pnl.net, position.symbol);
    position.realizedPnlNet = (position.realizedPnlNet || 0) + pnl.net;
    position.realizedFeeTotal = (position.realizedFeeTotal || 0) + pnl.fee;
    position.qty = remainQty;
    position.safetyStop = position.entryPrice;
    const cumulativePnl = this._getCumulativePnl(position);
    if (this.onTrade) {
      this.onTrade({
        action: 'PARTIAL_EXIT', positionId: posId, symbol: position.symbol, direction: position.direction,
        entryPrice: position.entryPrice, exitPrice, exitReason: reason, qty: partialQty, remainQty,
        pnlPct: pnl.pct, pnlNet: pnl.net, cumulativePnlPct: cumulativePnl.pct, cumulativePnlNet: cumulativePnl.net,
        feeTotal: pnl.fee, cumulativeFeeTotal: cumulativePnl.fee, safetyStop: position.safetyStop,
        planId: position.planId,
      });
    }
    logger.info(`[Z3-Exec] PARTIAL_EXIT ${position.symbol} realized=${pnl.net.toFixed(2)} total=${cumulativePnl.net.toFixed(2)} remain=${remainQty.toFixed(6)}`);
  }

  async _updateBalances() {
    try {
      const bal = await this.binance.getBalance();
      this.balance = bal.available;
      this.walletBalance = bal.total;
    } catch (_) {}
  }
}
