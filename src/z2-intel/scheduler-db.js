/**
 * @module 스케줄러 DB 핸들러
 * @description Z2-Intel 스케줄러에서 사용하는 Oracle DB 작업을 담당한다.
 *
 * @zone z2-intel
 * @dependencies db.js, query-loader.js, oracledb
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';
import { logger } from '../shared/logger.js';
import { normalizeConditions, hasValidConditions } from '../z3-exec/condition-evaluator.js';

const queries = loadQueries('z2-intel/scheduler');
const MAX_RESULT_CHARS = 32767;

function serializeAnalysisResult(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? {});
  if (text.length <= MAX_RESULT_CHARS) return text;
  logger.warn(`[Z2-Sched-DB] analysis result exceeds ${MAX_RESULT_CHARS} chars; storing truncated JSON payload`);
  let low = 0;
  let high = text.length;
  let best = JSON.stringify({ truncated: true, raw: '' });
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ truncated: true, raw: text.slice(0, mid) });
    if (candidate.length <= MAX_RESULT_CHARS) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * 활성 플랜 유효시간 연장
 */
export async function extendPlanForSymbol(symbol, validMin) {
  const conn = await getPool().getConnection();
  try {
    const result = await conn.execute(
      queries.extendPlan,
      { sym: symbol, validMin },
      { autoCommit: true }
    );
    return result.rowsAffected > 0;
  } catch (err) {
    logger.error(`[Z2-Sched-DB] Failed to extend plan for ${symbol}:`, err.message);
    return false;
  } finally {
    await conn.close();
  }
}

/**
 * 기존 활성 플랜 만료 처리 후 새 플랜 저장 (트랜잭션)
 */
export async function expireAndSavePlan(plan, validMin, overallConfidence) {
  const conn = await getPool().getConnection();
  try {
    const entryConditions = normalizeConditions(plan.entry_conditions || {});
    let stopConditions = normalizeConditions(plan.stop_conditions || {});
    if (!hasValidConditions(entryConditions)) {
      throw new Error(`Invalid entry_conditions for ${plan.symbol}`);
    }
    if (!hasValidConditions(stopConditions) && plan.stop_price != null) {
      stopConditions = plan.direction === 'LONG'
        ? { price: { op: '<=', value: plan.stop_price } }
        : { price: { op: '>=', value: plan.stop_price } };
    }

    // 1) 기존 플랜 만료
    await conn.execute(
      queries.expireActivePlan,
      { sym: plan.symbol }
    );

    // 2) 새 플랜 INSERT
    await conn.execute(
      queries.insertPlan,
      {
        validMin,
        sym: plan.symbol,
        dir: plan.direction,
        entry: { type: oracledb.DB_TYPE_JSON, val: entryConditions },
        target: plan.target_price ?? null,
        stopPrice: plan.stop_price ?? null,
        stop: { type: oracledb.DB_TYPE_JSON, val: stopConditions },
        timeStop: plan.time_stop_min || 480,
        conf: plan.confidence ?? plan.probability ?? overallConfidence,
        reasoning: plan.reasoning || '',
        scenId: plan.id || 'unified',
      }
    );

    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback().catch(() => {});
    logger.error(`[Z2-Sched-DB] Failed to expireAndSavePlan for ${plan.symbol}:`, err.message);
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * LLM 분석 결과 저장
 */
export async function saveAnalysis(symbol, type, result, llmSource, embedding = null) {
  const conn = await getPool().getConnection();
  try {
    await conn.execute(
      queries.insertAnalysis,
      {
        sym: symbol,
        type,
        src: llmSource,
        result: serializeAnalysisResult(result),
        conf: result.confidence || 0,
        emb: embedding
          ? { type: oracledb.DB_TYPE_VECTOR, val: new Float64Array(embedding) }
          : null,
      },
      { autoCommit: true }
    );
    return true;
  } catch (err) {
    logger.error(`[Z2-Sched-DB] Failed to saveAnalysis for ${symbol}:`, err.message);
    return false;
  } finally {
    await conn.close();
  }
}

/**
 * 개별 모드용 플랜 저장
 */
export async function savePlan(symbol, scenario, overallConfidence, validMin) {
  const conn = await getPool().getConnection();
  try {
    const entryConditions = normalizeConditions(scenario.entry_conditions || {});
    let stopConditions = normalizeConditions(scenario.stop_conditions || {});
    if (!hasValidConditions(entryConditions)) {
      throw new Error(`Invalid entry_conditions for ${symbol}`);
    }
    if (!hasValidConditions(stopConditions) && scenario.stop_price != null) {
      stopConditions = scenario.direction === 'LONG'
        ? { price: { op: '<=', value: scenario.stop_price } }
        : { price: { op: '>=', value: scenario.stop_price } };
    }

    await conn.execute(
      queries.insertPlan,
      {
        validMin,
        sym: symbol,
        dir: scenario.direction,
        entry: { type: oracledb.DB_TYPE_JSON, val: entryConditions },
        target: scenario.target_price ?? null,
        stopPrice: scenario.stop_price ?? null,
        stop: { type: oracledb.DB_TYPE_JSON, val: stopConditions },
        timeStop: scenario.time_stop_min || 480,
        conf: scenario.probability ?? overallConfidence,
        reasoning: scenario.reasoning || '',
        scenId: scenario.id || null,
      },
      { autoCommit: true }
    );
    return true;
  } catch (err) {
    logger.error(`[Z2-Sched-DB] Failed to savePlan for ${symbol}:`, err.message);
    return false;
  } finally {
    await conn.close();
  }
}
