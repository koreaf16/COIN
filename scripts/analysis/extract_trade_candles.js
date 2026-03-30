/**
 * @module 거래 캔들 추출
 * @description 특정 거래의 캔들 데이터를 추출하여 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Candle   │ ──→ │ Logger   │
 * │ DB       │     │ Extractor│     │ Output   │
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
        logger.info(`Total candles: ${candleData.length}`);
        logger.info("Last 20 candles:");
        logger.info(JSON.stringify(candleData.slice(-20), null, 2));
        
        // Also check if there's a big gap
        const first = candleData[0].time;
        const last = candleData[candleData.length - 1].time;
        logger.info(`Range (sec): ${last - first}`);
        logger.info(`Expected candles (if 1s): ${last - first + 1}`);
      } else {
        logger.info("No trade found");
      }
    } finally {
      if (conn) await conn.close();
    }
  } catch (e) {
    logger.error("Error in extract_trade_candles:", e);
  }
}
main().catch(logger.error);
