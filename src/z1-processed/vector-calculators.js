/**
 * @module 벡터 계산기
 * @description 시장 상태 벡터의 각 차원([0]~[8])을 계산하기 위한 데이터 집계 및 수학적 로직을 제공한다.
 *
 * ┌──────────┐     ┌──────────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Vector       │ ──→ │ Numeric  │
 * │ DB       │     │ Calculators  │     │ Vector   │
 * └──────────┘     └──────────────┘     └──────────┘
 *
 * @zone z1-processed
 * @dependencies oracledb, query-loader.js, logger.js
 */

import { loadQueries } from '../shared/query-loader.js';
import { logger } from '../shared/logger.js';

const queries = loadQueries('z1-processed/vector-calculators');

/** 변동성 레짐 및 가속도 계산 */
export async function computeVolatilityRegime(conn, symbol) {
  try {
    const result = await conn.execute(queries.getVolatilityCandles, { sym: symbol });
    const candles = result.rows || [];
    if (candles.length < 2) return { regime: 'MED', atr: 0, bbw: 0, volAcc: 1.0 };

    const atrs = _calculateATRs(candles);
    const atr14 = atrs[atrs.length - 1];
    const volAcc = _calculateVolAcceleration(atrs, atr14);

    const closes = candles.map(c => c[2]);
    const bbWidth = _calculateBBWidth(closes);

    const lastClose = closes[closes.length - 1];
    const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;
    const regime = atrPct > 2.0 ? 'HIGH' : atrPct < 0.8 ? 'LOW' : 'MED';

    return { regime, atr: atr14, bbw: bbWidth, volAcc };
  } catch (err) {
    logger.error(`[Z1-Calc] computeVolatilityRegime error ${symbol}: ${err.message}`);
    return { regime: 'MED', atr: 0, bbw: 0, volAcc: 1.0 };
  }
}

function _calculateATRs(candles) {
  const atrs = [];
  for (let j = Math.max(0, candles.length - 25); j <= candles.length - 15; j++) {
    const slice = candles.slice(j, j + 15);
    const trueRanges = [];
    for (let i = 1; i < slice.length; i++) {
      const high = slice[i][0];
      const low = slice[i][1];
      const prevClose = slice[i - 1][2];
      trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    atrs.push(trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length);
  }
  return atrs;
}

function _calculateVolAcceleration(atrs, currentAtr) {
  if (atrs.length <= 1) return 1.0;
  const avgAtr = atrs.slice(0, -1).reduce((s, v) => s + v, 0) / (atrs.length - 1);
  return avgAtr > 0 ? currentAtr / avgAtr : 1.0;
}

function _calculateBBWidth(closes) {
  const bbPeriod = Math.min(20, closes.length);
  const recentCloses = closes.slice(-bbPeriod);
  const sma = recentCloses.reduce((s, v) => s + v, 0) / bbPeriod;
  if (sma <= 0) return 0;
  const std = Math.sqrt(recentCloses.reduce((s, v) => s + (v - sma) ** 2, 0) / bbPeriod);
  return (4 * std / sma) * 100;
}

/** OI 방향 + 가격 방향 해석 */
export async function interpretOIMatrix(conn, symbol) {
  try {
    const priceResult = await conn.execute(queries.getPriceForOI, { sym: symbol });
    const prices = priceResult.rows?.map(r => r[0]) || [];
    if (prices.length < 2) return null;

    const priceChangePct = ((prices[1] - prices[0]) / prices[0]) * 100;
    const price_dir = priceChangePct > 0.1 ? 'UP' : priceChangePct < -0.1 ? 'DOWN' : 'FLAT';

    const oiResult = await conn.execute(queries.getOIDerivatives, { sym: symbol });
    const oiChangePct = oiResult.rows?.[0]?.[0] || 0;
    const oi_dir = oiChangePct > 0.5 ? 'UP' : oiChangePct < -0.5 ? 'DOWN' : 'FLAT';

    const interpretation = _getOIInterpretation(price_dir, oi_dir);
    return { price_dir, oi_dir, interpretation };
  } catch (err) {
    logger.warn(`[Z1-Calc] interpretOIMatrix error ${symbol}: ${err.message}`);
    return null;
  }
}

function _getOIInterpretation(price_dir, oi_dir) {
  if (price_dir === 'UP' && oi_dir === 'UP') return 'NEW_LONG';
  if (price_dir === 'UP' && oi_dir === 'DOWN') return 'SHORT_COVER';
  if (price_dir === 'DOWN' && oi_dir === 'UP') return 'NEW_SHORT';
  if (price_dir === 'DOWN' && oi_dir === 'DOWN') return 'LONG_LIQUIDATION';
  return 'FLAT';
}

/** 추세 강도 계산 (EMA 기반) */
export async function getTrendStrength(conn, symbol) {
  try {
    for (const tf of ['4h', '1h', '15m']) {
      const result = await conn.execute(queries.getTrendCandles, { sym: symbol, tf });
      const closes = (result.rows?.map(r => r[0]) || []).reverse();
      if (closes.length < 12) continue;

      const ema12 = calculateEMA(closes, 12);
      const ema26 = calculateEMA(closes, Math.min(26, closes.length));
      const diff = (ema12 - ema26) / ema26;
      return Math.max(-1, Math.min(1, diff / 0.05));
    }
    return 0;
  } catch (err) {
    logger.warn(`[Z1-Calc] getTrendStrength error ${symbol}: ${err.message}`);
    return 0;
  }
}

function calculateEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/** 펀딩비 z-score 계산 */
export async function getFundingZscore(conn, symbol) {
  try {
    const statsResult = await conn.execute(queries.getFundingStats, { sym: symbol });
    const statsRow = statsResult.rows?.[0];
    if (!statsRow) return 0;

    const currentResult = await conn.execute(queries.getCurrentFunding, { sym: symbol });
    const current = currentResult.rows?.[0]?.[0];
    if (current == null) return 0;

    const [avg, std] = statsRow;
    if (!std || std === 0) return 0;
    return Math.max(-3, Math.min(3, (current - avg) / std));
  } catch (err) {
    logger.warn(`[Z1-Calc] getFundingZscore error ${symbol}: ${err.message}`);
    return 0;
  }
}

/** CVD 방향성 계산 */
export async function getCVDDirection(conn, symbol) {
  try {
    const result = await conn.execute(queries.getCVD, { sym: symbol });
    const rows = result.rows?.map(r => r[0]) || [];
    if (rows.length < 2) return 0;

    const diff = rows[0] - rows[1];
    const scale = Math.max(Math.abs(rows[0]), Math.abs(rows[1])) || 1;
    return diff > 0 ? Math.min(1, diff / scale) :
           diff < 0 ? Math.max(-1, diff / scale) : 0;
  } catch (err) {
    logger.warn(`[Z1-Calc] getCVDDirection error ${symbol}: ${err.message}`);
    return 0;
  }
}

/** 청산 비대칭성 계산 */
export async function getLiqAsymmetry(conn, symbol) {
  try {
    const priceResult = await conn.execute(queries.getLatestPrice, { sym: symbol });
    const price = priceResult.rows?.[0]?.[0];
    if (!price) return 0;

    const result = await conn.execute(queries.getLiquidationMap, { sym: symbol, price });
    const [above, below] = result.rows?.[0] || [0, 0];
    const total = (above || 0) + (below || 0);
    if (total === 0) return 0;

    return ((above || 0) - (below || 0)) / total;
  } catch (err) {
    logger.warn(`[Z1-Calc] getLiqAsymmetry error ${symbol}: ${err.message}`);
    return 0;
  }
}
