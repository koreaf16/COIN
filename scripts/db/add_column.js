/**
 * @module 컬럼 추가 스크립트
 * @description z1_market_states 테이블에 새로운 컬럼을 추가한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ DB       │ ──→ │ Logger   │
 * │ DB       │     │ Migrator │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/db
 * @dependencies db.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { initDb, getPool } from '../../src/shared/db.js';

async function main() {
  try {
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      await conn.execute('ALTER TABLE z1_market_states ADD volatility_acceleration NUMBER');
      logger.info('Added volatility_acceleration column');
    } catch (e) {
      if (e.message.includes('ORA-01430')) {
        logger.info('Column already exists');
      } else {
        logger.error(e);
      }
    } finally {
      await conn.close();
    }
  } catch (e) {
    logger.error("Error in add_column:", e);
  }
}
main().catch(logger.error);
