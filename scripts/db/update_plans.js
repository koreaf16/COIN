/**
 * @module 실행 플랜 업데이트
 * @description 모든 ACTIVE 상태의 실행 플랜 조건을 업데이트한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Plan     │ ──→ │ Oracle   │
 * │ DB (Read)│     │ Updater  │     │ DB (Write)
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/db
 * @dependencies db.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { initDb, getPool, closeDb } from '../../src/shared/db.js';

async function main() {
  try {
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      // 간단한 조건으로 모든 ACTIVE 플랜 업데이트
      const simplifiedConditions = {
        price_dir_1h: { op: '==', value: 'UP' }
      };

      await conn.execute(
        `UPDATE z2_execution_plan
         SET entry_conditions = :cond
         WHERE status = 'ACTIVE'`,
        { cond: JSON.stringify(simplifiedConditions) },
        { autoCommit: true }
      );

      logger.info('[PLAN] Updated all ACTIVE plans with simplified conditions');

      // 검증
      const result = await conn.execute(
        `SELECT symbol, entry_conditions FROM z2_execution_plan WHERE status = 'ACTIVE'`
      );

      logger.info(`[PLAN] ${result.rows.length} plans updated:`);
      for (const row of result.rows || []) {
        logger.info(`  - ${row[0]}`);
      }
    } finally {
      await conn.close();
      await closeDb();
    }
  } catch (err) {
    logger.error('Error in update_plans:', err.message);
    process.exit(1);
  }
}

main();
