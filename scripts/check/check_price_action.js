/**
 * @module 가격 액션 확인
 * @description 특정 시간대의 BRUSDT 1분봉 가격 액션을 정밀 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Price    │ ──→ │ Logger   │
 * │ DB       │     │ Action   │     │ Output   │
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
      const symbol = 'BRUSDT';
      const query = `
        SELECT symbol, TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS') as t, open_price, high_price, low_price, close_price, volume
        FROM z0_price_ohlcv
        WHERE symbol = :symbol
        AND timeframe = '1m'
        AND ts BETWEEN TO_TIMESTAMP('2026-03-23 17:50:00', 'YYYY-MM-DD HH24:MI:SS') 
                   AND TO_TIMESTAMP('2026-03-23 18:51:00', 'YYYY-MM-DD HH24:MI:SS')
        ORDER BY ts ASC
      `;
      const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(r.rows, null, 2));
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in check_price_action:", e);
  }
}
main().catch(logger.error);
