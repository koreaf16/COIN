/**
 * @module 현재 시간 확인
 * @description Oracle DB의 CURRENT_TIMESTAMP 및 SYSTIMESTAMP를 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Time     │ ──→ │ Logger   │
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
      const r = await conn.execute(`SELECT CURRENT_TIMESTAMP, SYSTIMESTAMP FROM DUAL`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(r.rows, null, 2));
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in check_now:", e);
  }
}
main().catch(logger.error);
