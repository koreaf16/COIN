/**
 * @module DB 쿼리 실행기
 * @description 명령행 인자로 받은 SQL 쿼리를 실행하고 결과를 출력한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ CLI      │ ──→ │ Query    │ ──→ │ Oracle   │
 * │ Args     │     │ Runner   │     │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/db
 * @dependencies db.js, oracledb, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { initDb, getPool, closeDb } from '../../src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  try {
    const sql = process.argv[2];
    if (!sql) {
      logger.error("SQL query required");
      process.exit(1);
    }

    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      logger.info(JSON.stringify(result.rows, null, 2));
    } finally {
      await conn.close();
      await closeDb();
    }
  } catch (err) {
    logger.error("Error executing query:", err.message);
    process.exit(1);
  }
}

main();
