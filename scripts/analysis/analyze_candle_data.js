/**
 * @module 캔들 데이터 분석
 * @description z4_positions 테이블의 CANDLE_DATA를 파싱하여 최대 고점 및 특정 시점의 가격을 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Candle   │ ──→ │ Logger   │
 * │ DB       │     │ Analyzer │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/analysis
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
        SELECT CANDLE_DATA
        FROM z4_positions
        WHERE symbol = :symbol
        ORDER BY exit_time DESC
        FETCH FIRST 1 ROWS ONLY
      `;
      const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (r.rows.length > 0) {
        const candleData = JSON.parse(r.rows[0].CANDLE_DATA);
        let maxHigh = 0;
        let maxTime = 0;
        for (const c of candleData) {
          if (c.high > maxHigh) {
            maxHigh = c.high;
            maxTime = c.time;
          }
        }
        logger.info(`Max High: ${maxHigh} at ${new Date(maxTime * 1000).toISOString()}`);
        
        // Check 18:12 specifically
        const time1812 = 1774289520; // roughly
        const candle1812 = candleData.find(c => c.time >= time1812 && c.time < time1812 + 60);
        logger.info("Example candle around 18:12:", candle1812);
      }
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in analyze_candle_data:", e);
  }
}
main().catch(logger.error);
