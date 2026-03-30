/**
 * @module 마켓 가드 (최종 필터)
 * @description 매매 시그널 발생 전, 시장의 급격한 변화나 역추세 여부를 최종적으로 검증한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Rule Engine  │ ───→ │ Market       │ ───→ │ Final        │
 * │ (Signal)     │      │ Guards       │      │ Validation   │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *                              ↑
 *                       ┌──────┴──────┐
 *                       │ Ring Buffer  │
 *                       │ & Oracle DB  │
 *                       └──────────────┘
 *
 * @zone z3-exec
 * @dependencies db.js, query-loader.js, logger.js
 */

import { getPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { loadQueries } from '../shared/query-loader.js';

const queries = loadQueries('z3-exec/market-guards');

/**
 * 역추세 매매 감지 (최근 6시간봉 기준)
 * @param {string} symbol
 * @param {string} direction - 'LONG' or 'SHORT'
 * @returns {Promise<{isCounterTrend: boolean, reason?: string}>}
 */
export async function detectCounterTrend(symbol, direction) {
  const conn = await getPool().getConnection();
  try {
    const result = await conn.execute(queries.getRecentCandles, { sym: symbol });
    const candles = (result.rows || []).map(r => ({ close: r[0], open: r[1] }));
    if (candles.length < 4) return { isCounterTrend: false };

    let bearish = 0, bullish = 0;
    for (const c of candles) {
      if (c.close < c.open) bearish++;
      else if (c.close > c.open) bullish++;
    }

    if (bearish >= 4 && direction === 'LONG') {
      return { isCounterTrend: true, reason: `최근 6h 중 ${bearish}봉 하락 → LONG은 역추세` };
    }
    if (bullish >= 4 && direction === 'SHORT') {
      return { isCounterTrend: true, reason: `최근 6h 중 ${bullish}봉 상승 → SHORT은 역추세` };
    }
    return { isCounterTrend: false };
  } catch (err) {
    logger.warn(`[Z3-Guard] detectCounterTrend error: ${err.message}`);
    return { isCounterTrend: false };
  } finally {
    if (conn) await conn.close();
  }
}

/**
 * 실시간 시장 급변 가드 (BTC 동조화 등)
 * @param {string} symbol
 * @param {string} direction - 'LONG' or 'SHORT'
 * @param {object} ringBuffer
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
export async function checkMarketGuard(symbol, direction, ringBuffer) {
  if (symbol === 'BTCUSDT') return { blocked: false };

  const conn = await getPool().getConnection();
  try {
    const btcResult = await conn.execute(queries.getBtcClose, {});
    const btcCloses = (btcResult.rows || []).map(r => r[0]);
    if (btcCloses.length >= 1) {
      const btcLive = ringBuffer.getLastPrice('BTCUSDT');
      if (btcLive) {
        const btcLiveMom = (btcLive - btcCloses[0]) / btcCloses[0] * 100;
        if (direction === 'SHORT' && btcLiveMom > 2.0) {
          return { blocked: true, reason: `BTC_BOUNCE: BTC 실시간 +${btcLiveMom.toFixed(2)}% 급반등 → 알트 SHORT 차단` };
        }
        if (direction === 'LONG' && btcLiveMom < -2.0) {
          return { blocked: true, reason: `BTC_DROP: BTC 실시간 ${btcLiveMom.toFixed(2)}% 급락 → 알트 LONG 차단` };
        }
      }
    }
    return { blocked: false };
  } catch (err) {
    logger.warn(`[Z3-Guard] checkMarketGuard error: ${err.message}`);
    return { blocked: false };
  } finally {
    if (conn) await conn.close();
  }
}
