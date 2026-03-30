/**
 * @module Kline Bootstrap
 * @description Binance REST API를 사용하여 신규 또는 누락된 심볼의 히스토리 Kline 데이터를 백필한다.
 *
 * ┌─────────────┐      ┌─────────────────┐      ┌─────────────┐
 * │ Binance     │ ───→ │ Kline Bootstrap │ ───→ │ Oracle DB   │
 * │ REST API    │      │ (Z0-Raw)        │      │ (z0_price)  │
 * └─────────────┘      └─────────────────┘      └─────────────┘
 *                              ↑
 *                       최소 필요 데이터 확인
 *
 * @zone z0-raw
 * @dependencies db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const FAPI_BASE = 'https://fapi.binance.com';
const queries = loadQueries('z0-raw/kline-bootstrap');

// 타임프레임별 백필 설정
const BACKFILL_CONFIG = [
  { tf: '1m',  limit: 500  },   // ~8시간
  { tf: '5m',  limit: 300  },   // ~25시간
  { tf: '1h',  limit: 300  },   // ~12일
  { tf: '4h',  limit: 200  },   // ~33일
  { tf: '1d',  limit: 100  },   // ~100일
];

// 최소 필요 kline 수 (이 미만이면 백필)
const MIN_REQUIRED = {
  '1m':  100,
  '5m':  50,
  '1h':  24,
  '4h':  14,   // ATR(14) 계산에 최소 14개 필요
  '1d':  7,
};

/**
 * 모든 심볼에 대해 필요한 데이터가 있는지 확인하고 부족한 경우 백필을 수행한다.
 * @param {string[]} symbols
 */
export async function bootstrapKlines(symbols) {
  try {
    logger.info(`[Z0-Bootstrap] Checking ${symbols.length} symbols for kline backfill...`);

    const conn = await getPool().getConnection();
    let totalInserted = 0;
    let symbolsBackfilled = 0;

    try {
      for (const symbol of symbols) {
        if (await _needsBackfill(conn, symbol)) {
          logger.info(`[Z0-Bootstrap] Backfilling ${symbol}...`);
          symbolsBackfilled++;
          totalInserted += await _backfillSymbol(conn, symbol);
        }
        await _sleep(100);
      }
    } finally {
      await conn.close();
    }

    _logCompletion(symbolsBackfilled, totalInserted);
    return { symbolsBackfilled, totalInserted };
  } catch (err) {
    logger.error(`[Z0-Bootstrap] Main error:`, err.message);
    return { symbolsBackfilled: 0, totalInserted: 0 };
  }
}

async function _needsBackfill(conn, symbol) {
  try {
    for (const { tf } of BACKFILL_CONFIG) {
      const result = await conn.execute(queries.checkKlineCount, { sym: symbol, tf });
      const count = result.rows?.[0]?.[0] || 0;
      if (count < (MIN_REQUIRED[tf] || 14)) return true;
    }
    return false;
  } catch (err) {
    logger.error(`[Z0-Bootstrap] Error checking ${symbol}:`, err.message);
    return false;
  }
}

async function _backfillSymbol(conn, symbol) {
  let insertedCount = 0;
  for (const { tf, limit } of BACKFILL_CONFIG) {
    try {
      insertedCount += await _fetchAndInsert(conn, symbol, tf, limit);
      await _sleep(50);
    } catch (err) {
      logger.error(`[Z0-Bootstrap] Error ${symbol} ${tf}:`, err.message);
    }
  }
  return insertedCount;
}

async function _fetchAndInsert(conn, symbol, tf, limit) {
  const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol} ${tf}`);

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return 0;

  let inserted = 0;
  const BATCH = 50;

  for (let i = 0; i < data.length; i += BATCH) {
    const batch = data.slice(i, i + BATCH);
    for (const k of batch) {
      if (await _insertSingleKline(conn, symbol, tf, k)) inserted++;
    }
    await conn.commit();
  }
  return inserted;
}

async function _insertSingleKline(conn, symbol, tf, k) {
  const [openTime, open, high, low, close, volume, closeTime, quoteVol, tradeCount, takerBuyBaseVol] = k;
  const sellVol = parseFloat(volume) - parseFloat(takerBuyBaseVol);

  try {
    await conn.execute(queries.insertKline, {
      symbol,
      tf,
      ts: new Date(closeTime),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      vol: parseFloat(volume),
      qvol: parseFloat(quoteVol),
      tc: tradeCount,
      bvol: parseFloat(takerBuyBaseVol),
      svol: sellVol,
    });
    return true;
  } catch (err) {
    if (!err.message?.includes('ORA-00001')) throw err;
    return false;
  }
}

function _logCompletion(symbols, klines) {
  if (symbols > 0) {
    logger.info(`[Z0-Bootstrap] Done: ${symbols} symbols, ${klines} klines inserted`);
  } else {
    logger.info(`[Z0-Bootstrap] All symbols have sufficient data — no backfill needed`);
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
