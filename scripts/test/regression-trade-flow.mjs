import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeConditions,
  hasValidConditions,
  evaluateConditions,
} from '../../src/z3-exec/condition-evaluator.js';
import { LLMScheduler } from '../../src/z2-intel/scheduler.js';
import { buildStructureMonitor } from '../../src/api/api-utils.js';
import { RiskGate } from '../../src/z3-exec/risk-gate-fixed.js';
import { ExecutorTrade } from '../../src/z3-exec/executor-trade.js';
import { RuleEngine } from '../../src/z3-exec/rule-engine.js';
import { TradeRecorder } from '../../src/z4-results/trade-recorder.js';
import { computeSwingFeatures } from '../../src/shared/swing-features.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..', '..');

function testNormalizeConditions() {
  assert.deepEqual(normalizeConditions({ field: { op: '<', value: 0 } }), {});
  assert.deepEqual(normalizeConditions({ field: 'price', op: '<', value: 100 }), {
    price: { op: '<', value: 100 },
  });
  assert.deepEqual(normalizeConditions([
    { field: 'price', op: '>', value: 90 },
    { field: 'cvd_direction', op: '>', value: 0.1 },
  ]), {
    price: { op: '>', value: 90 },
    cvd_direction: { op: '>', value: 0.1 },
  });
  assert.deepEqual(normalizeConditions({ price: { op: '>', value: 0 } }), {
    price: { op: '>', value: 0 },
  });
}

function testHasValidConditions() {
  assert.equal(hasValidConditions({}), false);
  assert.equal(hasValidConditions({ field: { op: '<', value: 0 } }), false);
  assert.equal(hasValidConditions({ price: { op: '<', value: 0 } }), true);
}

function testEvaluateConditions() {
  const current = {
    price: 100,
    funding_rate: 0.0002,
    price_dir_1h: 'UP',
    oi_dir_1h: 'DOWN',
    cvd_direction: 0.3,
  };

  const met = evaluateConditions(
    {
      price: { op: '>', value: 90 },
      funding_rate: { op: '<=', value: 0.0005 },
    },
    current,
    'LONG'
  );
  assert.equal(met.met, true);

  const blocked = evaluateConditions(
    {
      price_dir_1h: { op: '==', value: 'DOWN' },
      oi_dir_1h: { op: '==', value: 'UP' },
    },
    current,
    null
  );
  assert.equal(blocked.met, false);
}

function testPromptSchema() {
  const prompt = readFileSync(resolve(rootDir, 'python-llm', 'prompts.py'), 'utf8');
  assert.match(prompt, /"funding_rate":\s*<actual from data>/);
  assert.match(prompt, /"open_interest":\s*<actual from data>/);
  assert.match(prompt, /"entry_conditions": \{\{"price":/);
  assert.match(prompt, /"stop_conditions": \{\{"cvd_direction":/);
  assert.match(prompt, /daily_bias/);
  assert.match(prompt, /trend_bias_4h/);
  assert.match(prompt, /trigger_bias_1h/);
  assert.match(prompt, /Output ONLY one minified JSON object\./);
  assert.match(prompt, /If the market looks contradictory or low quality, return \{\{"selected_id": ""\}\}\./);
}

function testUnifiedPlanValidation() {
  const bullish1h = buildTrendKlines(60, 80, 1);
  const bullish4h = buildTrendKlines(60, 20, 2);
  const bullish1d = buildTrendKlines(60, 80, 1);
  const scheduler = new LLMScheduler(null, ['BTCUSDT'], {
    ringBuffer: {
      getLastPrice() {
        return bullish1h.at(-1).close;
      },
      getKlines(symbol, timeframe) {
        if (timeframe === '1h') return bullish1h;
        if (timeframe === '4h') return bullish4h;
        if (timeframe === '1d') return bullish1d;
        return [];
      },
    },
  });

  const validPlan = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    confidence: 0.82,
    entry_conditions: {
      daily_bias: { op: '==', value: 'BULLISH' },
      trend_bias_4h: { op: '==', value: 'BULLISH' },
      trigger_bias_1h: { op: '==', value: 'BULLISH' },
      breakout_long_setup: { op: '>=', value: 1 },
      price: { op: '>', value: 100 },
    },
    target_price: 106,
    stop_price: 97,
    stop_conditions: { cvd_direction: { op: '<', value: -0.2 } },
    time_stop_min: 240,
  };
  assert.equal(scheduler._normalizeAndValidatePlan(validPlan), true);

  const missingStructurePlan = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    confidence: 0.82,
    entry_conditions: { price: { op: '>', value: 100 } },
    target_price: 106,
    stop_price: 97,
    stop_conditions: { cvd_direction: { op: '<', value: -0.2 } },
    time_stop_min: 240,
  };
  assert.equal(scheduler._normalizeAndValidatePlan(missingStructurePlan), false);

  const lowRrPlan = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    confidence: 0.82,
    entry_conditions: validPlan.entry_conditions,
    target_price: 101.5,
    stop_price: 99,
    stop_conditions: { cvd_direction: { op: '<', value: -0.2 } },
    time_stop_min: 240,
  };
  assert.equal(scheduler._normalizeAndValidatePlan(lowRrPlan), false);

  const shortTimePlan = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    confidence: 0.82,
    entry_conditions: validPlan.entry_conditions,
    target_price: 106,
    stop_price: 97,
    stop_conditions: { cvd_direction: { op: '<', value: -0.2 } },
    time_stop_min: 60,
  };
  assert.equal(scheduler._normalizeAndValidatePlan(shortTimePlan), false);

  const bearish1h = buildTrendKlines(60, 140, -1);
  const bearish4h = buildTrendKlines(60, 260, -2);
  const bearish1d = buildTrendKlines(60, 140, -1);
  const counterTrendScheduler = new LLMScheduler(null, ['BTCUSDT'], {
    ringBuffer: {
      getLastPrice() {
        return bearish1h.at(-1).close;
      },
      getKlines(symbol, timeframe) {
        if (timeframe === '1h') return bearish1h;
        if (timeframe === '4h') return bearish4h;
        if (timeframe === '1d') return bearish1d;
        return [];
      },
    },
  });
  assert.equal(counterTrendScheduler._normalizeAndValidatePlan(validPlan), false);
}

function testRiskBasedSizing() {
  const gate = new RiskGate({
    maxPositionPct: 50,
    maxRiskPct: 1,
    safetyStopPct: 4,
    maxDailyLossPct: 5,
    maxOpenTrades: 5,
    maxLeverage: 2,
  });

  const sized = gate.check({
    symbol: 'BTCUSDT',
    direction: 'LONG',
    targetPrice: 110,
    stopPrice: 95,
  }, 10000, 100, 'neutral');

  assert.equal(sized.allowed, true);
  assert.equal(Number(sized.positionValue.toFixed(2)), 2000);
  assert.equal(Number(sized.positionSize.toFixed(6)), 20);
  assert.equal(Number(sized.riskAmount.toFixed(2)), 100);
  assert.equal(Number(sized.riskPct.toFixed(2)), 1);

  const capped = gate.check({
    symbol: 'ETHUSDT',
    direction: 'LONG',
    targetPrice: 102.5,
    stopPrice: 99,
  }, 10000, 100, 'neutral');

  assert.equal(capped.allowed, true);
  assert.equal(Number(capped.positionValue.toFixed(2)), 5000);
  assert.equal(Number(capped.riskPct.toFixed(2)), 0.5);
}

async function testTriggeredPlanConsumption() {
  const executor = new ExecutorTrade();
  let calls = 0;

  await executor._consumeTriggeredPlan({
    symbol: 'BTCUSDT',
    planId: 42,
    _markTriggered: async () => {
      calls += 1;
    },
  });

  assert.equal(calls, 1);
}

function testPartialExitAggregation() {
  const executor = new ExecutorTrade();
  const posId = 9001;
  const recordedPnls = [];
  const events = [];

  executor.liveMode = false;
  executor.leverage = 2;
  executor.balance = 10000;
  executor.stats = { signals: 0, entries: 0, exits: 0, rejected: 0 };
  executor.activePositions = new Map();
  executor.riskGate = {
    addTrade() {},
    removeTrade(id) { assert.equal(id, posId); },
    recordExit(pnl) { recordedPnls.push(Number(pnl.toFixed(2))); },
  };
  executor.onTrade = (trade) => events.push(trade);

  const position = {
    id: posId,
    planId: 77,
    symbol: 'BTCUSDT',
    direction: 'LONG',
    entryPrice: 100,
    entryTime: Date.now() - 60000,
    qty: 20,
    initialQty: 20,
    realizedPnlNet: 0,
    realizedFeeTotal: 0,
    safetyStop: 95,
    entryReasoning: {},
  };
  executor.activePositions.set(posId, position);

  executor._finalizePartialExit(posId, position, 105, 10, 10, 'PARTIAL_EXIT');
  assert.equal(position.qty, 10);
  assert.equal(position.safetyStop, 100);
  assert.equal(Number(position.realizedPnlNet.toFixed(2)), 49.2);
  assert.equal(Number(position.realizedFeeTotal.toFixed(2)), 0.8);
  assert.equal(Number(executor.balance.toFixed(2)), 10049.2);
  assert.deepEqual(recordedPnls, [49.2]);
  assert.equal(events[0].action, 'PARTIAL_EXIT');
  assert.equal(Number(events[0].pnlNet.toFixed(2)), 49.2);
  assert.equal(Number(events[0].cumulativePnlNet.toFixed(2)), 49.2);
  assert.equal(Number(events[0].cumulativePnlPct.toFixed(2)), 4.92);

  executor._finalizeExit(posId, position, 110, 'TARGET', {});
  assert.equal(executor.activePositions.has(posId), false);
  assert.equal(Number(executor.balance.toFixed(2)), 10148.4);
  assert.deepEqual(recordedPnls, [49.2, 99.2]);
  assert.equal(events[1].action, 'EXIT');
  assert.equal(Number(events[1].pnlNet.toFixed(2)), 148.4);
  assert.equal(Number(events[1].pnlPct.toFixed(2)), 14.84);
  assert.equal(Number(events[1].feeTotal.toFixed(2)), 0.8);
  assert.equal(Number(events[1].cumulativeFeeTotal.toFixed(2)), 1.6);
}

async function testTradeRecorderPartialExitRouting() {
  const recorder = new TradeRecorder();
  const calls = [];

  recorder._recordEntry = async () => { calls.push('ENTRY'); };
  recorder._recordPartialExit = async () => { calls.push('PARTIAL_EXIT'); };
  recorder._recordExit = async () => { calls.push('EXIT'); };

  await recorder.record({ action: 'ENTRY' });
  await recorder.record({ action: 'PARTIAL_EXIT' });
  await recorder.record({ action: 'EXIT' });

  assert.deepEqual(calls, ['ENTRY', 'PARTIAL_EXIT', 'EXIT']);
}

function buildTrendKlines(count, start, step) {
  return Array.from({ length: count }, (_, index) => {
    const base = start + index * step;
    const magnitude = Math.max(Math.abs(step), 1);
    const close = base + step;
    return {
      open: base,
      high: Math.max(base, close) + magnitude * 0.5,
      low: Math.min(base, close) - magnitude * 0.5,
      close,
      volume: 100 + index,
    };
  });
}

function testSwingHierarchyFeatures() {
  const klines1h = buildTrendKlines(60, 80, 1);
  const klines4h = buildTrendKlines(60, 20, 2);
  const klines1d = buildTrendKlines(60, 80, 1);
  const btc1h = buildTrendKlines(60, 44000, 100);
  const btc1d = buildTrendKlines(60, 44000, 100);
  const currentPrice = klines1h.at(-1).close;

  const features = computeSwingFeatures({
    currentPrice,
    klines1h,
    klines4h,
    klines1d,
    btcKlines1h: btc1h,
    btcKlines1d: btc1d,
  });

  assert.equal(features.daily_bias, 'BULLISH');
  assert.equal(features.trend_bias_4h, 'BULLISH');
  assert.equal(features.trigger_bias_1h, 'BULLISH');
  assert.equal(features.ema_fast_above_slow_1d, 1);
  assert.equal(features.breakout_long_setup, 1);
  assert.equal(features.breakout_short_setup, 0);
}

function testStructureGuard() {
  const engine = new RuleEngine({
    getSnapshot() { return { price: 100, derivatives: {}, markPrice: {} }; },
    getTradesWindow() { return []; },
    getKlines() { return []; },
  }, null, ['BTCUSDT']);

  assert.equal(
    engine._checkStructureGuard({ direction: 'LONG', confidence: 0.8 }, { daily_bias: 'BEARISH', trend_bias_4h: 'BULLISH' }),
    'daily_bias=BEARISH'
  );
  assert.equal(
    engine._checkStructureGuard({ direction: 'SHORT', confidence: 0.8 }, { daily_bias: 'NEUTRAL', trend_bias_4h: 'BULLISH' }),
    'trend_bias_4h=BULLISH'
  );
  assert.equal(
    engine._checkStructureGuard({ direction: 'LONG', confidence: 0.92 }, { daily_bias: 'BEARISH', trend_bias_4h: 'BEARISH' }),
    null
  );
}

function testStructureMonitor() {
  const monitor = buildStructureMonitor({
    direction: 'LONG',
    confidence: 0.82,
    entryConditions: {
      daily_bias: { op: '==', value: 'BULLISH' },
      trend_bias_4h: { op: '==', value: 'BULLISH' },
      breakout_long_setup: { op: '>=', value: 1 },
    },
    currentData: {
      daily_bias: 'BULLISH',
      trend_bias_4h: 'BULLISH',
      trigger_bias_1h: 'BULLISH',
      breakout_long_setup: 1,
    },
  });

  assert.equal(monitor.hasHigherTimeframePlan, true);
  assert.equal(monitor.hasTriggerPlan, true);
  assert.equal(monitor.aligned, true);
  assert.equal(monitor.plan.higherTimeframe.daily_bias.value, 'BULLISH');
  assert.equal(monitor.current.trigger_bias_1h, 'BULLISH');

  const blocked = buildStructureMonitor({
    direction: 'SHORT',
    confidence: 0.8,
    currentData: {
      daily_bias: 'BULLISH',
      trend_bias_4h: 'BULLISH',
    },
  });
  assert.equal(blocked.aligned, false);
  assert.equal(blocked.blockReason, 'daily_bias=BULLISH');
}

function testEntryOrderPlan() {
  const executor = new ExecutorTrade();
  executor.entryLimitFallbackPct = 0.15;

  const pullbackLong = executor._resolveEntryOrderPlan({
    direction: 'LONG',
    entryConditions: {
      price: { op: '<=', value: 98 },
    },
  }, 100);
  assert.equal(pullbackLong.executionType, 'LIMIT');
  assert.equal(pullbackLong.label, 'PULLBACK_LIMIT');
  assert.equal(pullbackLong.limitPrice, 98);

  const breakoutLong = executor._resolveEntryOrderPlan({
    direction: 'LONG',
    entryConditions: {
      price: { op: '>=', value: 100 },
    },
  }, 100.2);
  assert.equal(breakoutLong.executionType, 'MARKET');
  assert.equal(breakoutLong.label, 'BREAKOUT_MARKET');

  const pullbackShort = executor._resolveEntryOrderPlan({
    direction: 'SHORT',
    entryConditions: {
      price: { op: '>=', value: 102 },
    },
  }, 100);
  assert.equal(pullbackShort.executionType, 'LIMIT');
  assert.equal(pullbackShort.limitPrice, 102);
}

async function main() {
  testNormalizeConditions();
  testHasValidConditions();
  testEvaluateConditions();
  testPromptSchema();
  testUnifiedPlanValidation();
  testRiskBasedSizing();
  await testTriggeredPlanConsumption();
  testPartialExitAggregation();
  await testTradeRecorderPartialExitRouting();
  testSwingHierarchyFeatures();
  testStructureGuard();
  testStructureMonitor();
  testEntryOrderPlan();
  console.log('regression-trade-flow ok');
}

await main();
