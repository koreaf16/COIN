/**
 * @module DB 상태 확인
 * @description 주요 테이블의 데이터 건수를 확인하여 DB 상태를 점검한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ DB       │ ──→ │ Logger   │
 * │ DB       │     │ Checker  │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/check
 * @dependencies db.js, config.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { config } from '../../src/shared/config.js';
import { getPool, initDb } from '../../src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  try {
    logger.info("Connecting to Oracle DB...");
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const tables = [
        'z0_price_ohlcv',
        'z0_derivatives',
        'z0_liquidation_raw',
        'z1_liquidation_map',
        'z0_macro_data',
        'z0_news_raw',
        'z0_onchain',
        'z1_market_states',
        'z2_llm_analysis',
        'z2_execution_plan'
      ];
      for (const t of tables) {
        try {
          const r = await conn.execute(`SELECT COUNT(*) AS cnt FROM ${t}`);
          logger.info(`${t}: ${r.rows[0][0]} rows`);
        } catch (e) {
          logger.info(`${t}: ERROR - ${e.message}`);
        }
      }
    } finally {
      await conn.close();
      try { await pool.close(); } catch(e) {}
    }
  } catch (e) {
    logger.error("Error in check_db:", e);
  }
}
main().catch(logger.error);
