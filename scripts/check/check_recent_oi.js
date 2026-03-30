/**
 * @module 최근 OI 매트릭스 확인
 * @description 특정 심볼의 최신 OI 매트릭스 20건을 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ OI       │ ──→ │ Logger   │
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
          SELECT ts, price_dir, oi_dir, interpretation
          FROM z1_oi_matrix
          WHERE symbol = :symbol
          ORDER BY ts DESC
        ) WHERE ROWNUM <= 20
      `;
      const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(r.rows, null, 2));
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in check_recent_oi:", e);
  }
}
main().catch(logger.error);
