/**
 * @module API 유틸리티
 * @description API 서버에서 공통으로 사용하는 유틸리티 함수들을 정의한다.
 *
 * @zone api
 */

import { logger } from "../shared/logger.js";

const HIGHER_TIMEFRAME_FIELDS = [
  'daily_bias',
  'trend_bias_4h',
  'btc_daily_bias',
];

const TRIGGER_FIELDS = [
  'trigger_bias_1h',
  'pullback_long_setup',
  'pullback_short_setup',
  'breakout_long_setup',
  'breakout_short_setup',
  'retest_support_ready',
  'retest_resistance_ready',
  'support_distance_pct',
  'resistance_distance_pct',
  'range_position_20',
  'donchian_break_20',
  'relative_strength_btc_12h',
  'pullback_atr_ratio',
  'ema_gap_4h',
  'ema_gap_1d',
  'ema_fast_above_slow_4h',
  'ema_fast_above_slow_1d',
];

const CURRENT_STRUCTURE_FIELDS = [
  'daily_bias',
  'trend_bias_4h',
  'trigger_bias_1h',
  'btc_daily_bias',
  'support_distance_pct',
  'resistance_distance_pct',
  'range_position_20',
  'donchian_break_20',
  'pullback_long_setup',
  'pullback_short_setup',
  'breakout_long_setup',
  'breakout_short_setup',
  'retest_support_ready',
  'retest_resistance_ready',
  'relative_strength_btc_12h',
  'pullback_atr_ratio',
  'ema_gap_4h',
  'ema_gap_1d',
  'ema_fast_above_slow_4h',
  'ema_fast_above_slow_1d',
];

/**
 * Oracle DB 결과 로우를 소문자 키의 객체로 변환하고 LOB 데이터를 읽는다.
 * @param {Object} row Oracle DB row object
 * @returns {Promise<Object>} Transformed row
 */
export const toRow = async (row) => {
  if (!row) return null;
  const entries = [];
  for (const [k, v] of Object.entries(row)) {
    let val = v;
    if (v instanceof Date) {
      val = v.toISOString();
    } else if (v && typeof v === 'object' && typeof v.getData === 'function') {
      try {
        val = await v.getData();
      } catch (err) {
        logger.error(`[API-Utils] Error getting LOB data for ${k}: ${err.message}`);
        val = null;
      }
    } else if (v && typeof v === 'object' && v._autoCloseLob !== undefined) {
      try {
        if (typeof v.getData === 'function') {
          val = await v.getData();
        } else {
          val = null;
        }
      } catch (err) {
        logger.error(`[API-Utils] Error getting autoCloseLob data for ${k}: ${err.message}`);
        val = null;
      }
    }
    entries.push([k.toLowerCase(), val]);
  }
  return Object.fromEntries(entries);
};

export function parseJsonField(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeConditionMap(raw) {
  const parsed = parseJsonField(raw);
  if (!parsed || typeof parsed !== 'object') return {};

  if (Array.isArray(parsed)) {
    const result = {};
    for (const item of parsed) {
      if (item && typeof item === 'object' && item.field && item.op && 'value' in item) {
        result[item.field] = { op: item.op, value: item.value };
      }
    }
    return result;
  }

  const keys = Object.keys(parsed);
  if (keys.includes('field') && keys.includes('op') && 'value' in parsed && typeof parsed.field === 'string') {
    return { [parsed.field]: { op: parsed.op, value: parsed.value } };
  }

  return parsed;
}

function pickDefined(source, fields) {
  const result = {};
  if (!source || typeof source !== 'object') return result;
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      result[field] = source[field];
    }
  }
  return result;
}

function getStructureBlockReason(direction, confidence = 0, current = {}) {
  const allowAggressiveCounterTrend = Number(confidence || 0) >= 0.9;
  if (direction === 'LONG') {
    if (current.daily_bias === 'BEARISH' && !allowAggressiveCounterTrend) return 'daily_bias=BEARISH';
    if (current.trend_bias_4h === 'BEARISH' && !allowAggressiveCounterTrend) return 'trend_bias_4h=BEARISH';
  }
  if (direction === 'SHORT') {
    if (current.daily_bias === 'BULLISH' && !allowAggressiveCounterTrend) return 'daily_bias=BULLISH';
    if (current.trend_bias_4h === 'BULLISH' && !allowAggressiveCounterTrend) return 'trend_bias_4h=BULLISH';
  }
  return null;
}

export function extractPlanStructure(entryConditions) {
  const normalized = normalizeConditionMap(entryConditions);
  return {
    higherTimeframe: pickDefined(normalized, HIGHER_TIMEFRAME_FIELDS),
    trigger: pickDefined(normalized, TRIGGER_FIELDS),
  };
}

export function extractCurrentStructure(currentData) {
  return pickDefined(currentData, CURRENT_STRUCTURE_FIELDS);
}

export function buildStructureMonitor({ direction = null, confidence = 0, entryConditions = null, currentData = null } = {}) {
  const plan = extractPlanStructure(entryConditions);
  const current = extractCurrentStructure(currentData);
  const blockReason = getStructureBlockReason(direction, confidence, current);

  return {
    current,
    plan,
    hasHigherTimeframePlan: Object.keys(plan.higherTimeframe).length > 0,
    hasTriggerPlan: Object.keys(plan.trigger).length > 0,
    aligned: !blockReason,
    blockReason,
  };
}
