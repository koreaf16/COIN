/**
 * @module 최근 캔들 데이터 확인
 * @description 특정 심볼의 최신 1분봉 OHLCV 데이터 50건을 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Candle   │ ──→ │ Logger   │
 * │ DB       │     │ Checker  │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/check
 * @dependencies db.js, oracledb, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { initDb, getPool } from '../../src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  try {
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const symbol = 'RIVERUSDT';
      const query = `
        SELECT * FROM (
          SELECT ts, open_price, high_price, low_price, close_price, volume
          FROM z0_price_ohlcv
          WHERE symbol = :symbol
            AND timeframe = '1m'
          ORDER BY ts DESC
        ) WHERE ROWNUM <= 50
      `;
      const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(r.rows, null, 2));
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in check_recent_candles:", e);
  }
}
main().catch(logger.error);
