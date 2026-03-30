/**
 * @module LLM 사용량 확인
 * @description 최근 24시간 동안의 LLM 분석 호출 횟수 및 토큰 사용량을 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ LLM      │ ──→ │ Logger   │
 * │ DB       │     │ Usage    │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/check
 * @dependencies db.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { getPool, initDb } from '../../src/shared/db.js';

async function main() {
  try {
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const query = `
        SELECT 
          analysis_type, 
          COUNT(*) as calls,
          SUM(token_count) as total_tokens,
          AVG(token_count) as avg_tokens
        FROM z2_llm_analysis
        WHERE ts > SYSTIMESTAMP - INTERVAL '1' DAY
        GROUP BY analysis_type
      `;
      const result = await conn.execute(query);
      logger.info("=== LLM Usage in last 24h ===");
      logger.info("Type | Calls | Total Tokens | Avg Tokens");
      for (const row of result.rows) {
        logger.info(`${row[0]} | ${row[1]} | ${row[2]} | ${row[3]?.toFixed(0)}`);
      }

      const totalQuery = `
        SELECT SUM(token_count) FROM z2_llm_analysis
        WHERE ts > SYSTIMESTAMP - INTERVAL '1' DAY
      `;
      const totalResult = await conn.execute(totalQuery);
      logger.info("-----------------------------------");
      logger.info(`GRAND TOTAL TOKENS: ${totalResult.rows[0][0]}`);
    } finally {
      await conn.close();
    }
    process.exit(0);
  } catch (e) {
    logger.error("Query Error:", e.message);
    process.exit(1);
  }
}
main().catch(logger.error);
