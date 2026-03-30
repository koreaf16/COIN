import assert from 'node:assert/strict';

import {
  normalizeConditions,
  hasValidConditions,
  evaluateConditions,
} from '../../src/z3-exec/condition-evaluator.js';
import { RiskGate } from '../../src/z3-exec/risk-gate-fixed.js';
import { SmartExit } from '../../src/z3-exec/smart-exit.js';

function makeRingBuffer() {
  return {
    getKlines() {
      return null;
    },
    getLastPrice() {
      return 100;
    },
  };
}

function main() {
  const plan = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    entry_conditions: {
      price: { op: '>', value: 95 },
      cvd_direction: { op: '>', value: 0.2 },
      volume_surge: { op: '>', value: 1.2 },
      macro_regime: { op: 'in', value: ['neutral', 'risk_on'] },
    },
    target_price: 106,
    stop_price: 97,
    stop_conditions: {
      funding_rate: { op: '>', value: 0.001 },
      cvd_direction: { op: '<', value: -0.2 },
    },
    time_stop_min: 15,
    confidence: 0.87,
    reasoning: '4h 추세 상방, CVD 양수, 거래량 급증, 펀딩 과열 아님',
  };

  const entryMarket = {
    price: 100,
    funding_rate: 0.0002,
    open_interest: 12000,
    cvd_direction: 0.35,
    volume_surge: 1.4,
    macro_regime: 'neutral',
    price_dir_1h: 'UP',
    oi_dir_1h: 'FLAT',
  };

  const normalizedEntry = normalizeConditions(plan.entry_conditions);
  const normalizedStop = normalizeConditions(plan.stop_conditions);
  assert.equal(hasValidConditions(normalizedEntry), true);
  assert.equal(hasValidConditions(normalizedStop), true);

  const entryEval = evaluateConditions(normalizedEntry, entryMarket, plan.direction);
  assert.equal(entryEval.met, true);

  const gate = new RiskGate({
    maxPositionPct: 10,
    safetyStopPct: 3,
    maxDailyLossPct: 5,
    maxOpenTrades: 5,
    maxLeverage: 3,
  });

  const signal = {
    symbol: plan.symbol,
    direction: plan.direction,
    targetPrice: plan.target_price,
    stopPrice: plan.stop_price,
  };

  const gateCheck = gate.check(signal, 10000, entryMarket.price, entryMarket.macro_regime);
  assert.equal(gateCheck.allowed, true);

  const position = {
    id: 1,
    symbol: plan.symbol,
    direction: plan.direction,
    entryPrice: 100,
    entryTime: Date.now(),
    qty: gateCheck.positionSize,
    targetPrice: plan.target_price,
    safetyStop: gateCheck.safetyStop,
    timeStopMin: plan.time_stop_min,
  };

  const smartExit = new SmartExit({
    validateIntervalSec: 600,
    ringBuffer: makeRingBuffer(),
  });

  const targetExit = smartExit.checkPriceExit(position, 106);
  assert.equal(targetExit, 'TARGET');

  const safetyExit = smartExit.checkPriceExit(position, 96.8);
  assert.equal(safetyExit, 'SAFETY_STOP');

  const invalidationMarket = {
    ...entryMarket,
    funding_rate: 0.0015,
    cvd_direction: -0.4,
  };
  const invalidation = evaluateConditions(normalizedStop, invalidationMarket, null);
  assert.equal(invalidation.met, true);

  console.log(JSON.stringify({
    plan: plan.symbol,
    entry: entryEval.met,
    gate: gateCheck.allowed,
    targetExit,
    safetyExit,
    invalidation: invalidation.met,
  }));
  console.log('sample-plan-smoke ok');
}

main();
