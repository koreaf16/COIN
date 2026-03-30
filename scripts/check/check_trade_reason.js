/**
 * @module 거래 사유 확인
 * @description 특정 심볼의 최신 포지션 정보를 조회하여 출력한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Reason   │ ──→ │ Logger   │
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
      const symbol = 'BRUSDT';
      const query = `
        SELECT *
        FROM z4_positions
        WHERE symbol = :symbol
        ORDER BY exit_time DESC
      `;
      const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(r.rows, null, 2));
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in check_trade_reason:", e);
  }
}
main().catch(logger.error);
