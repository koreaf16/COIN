/**
 * @module 로직 체크 확인
 * @description 특정 포지션 ID의 로직 체크 이력을 최신순으로 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Logic    │ ──→ │ Logger   │
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
      const positionId = 12973248674;
      const query = `
        SELECT *
        FROM z3_logic_checks
        WHERE position_id = :positionId
        ORDER BY ts DESC
      `;
      const r = await conn.execute(query, { positionId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(r.rows, null, 2));
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in check_logic_checks:", e);
  }
}
main().catch(logger.error);
