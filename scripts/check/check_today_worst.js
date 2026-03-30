/**
 * @module 오늘 최악의 거래 확인
 * @description 최근 2일 내 손실이 큰(-4% 이하) 거래들을 조회하여 파일로 저장한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Worst    │ ──→ │ JSON     │
 * │ DB       │     │ Checker  │     │ File     │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/check
 * @dependencies db.js, fs, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { getPool, initDb } from '../../src/shared/db.js';
import fs from 'fs';

async function run() { 
  try {
    await initDb(); 
    const pool = await getPool(); 
    const conn = await pool.getConnection(); 
    try {
      const r = await conn.execute(
        "SELECT id, symbol, direction, entry_time, exit_time, exit_reason, entry_price, exit_price, pnl_pct, pnl_amount, safety_stop FROM z4_positions WHERE exit_time >= SYSTIMESTAMP - INTERVAL '2' DAY AND pnl_pct < -4 ORDER BY pnl_pct ASC", 
        [], 
        { outFormat: 4002 }
      ); 
      fs.writeFileSync('tmp_today_worst.json', JSON.stringify(r.rows, null, 2));
      logger.info('Saved to tmp_today_worst.json');
    } finally {
      await conn.close();
    }
    process.exit(0);
  } catch (e) {
    logger.error("Error in check_today_worst:", e);
    process.exit(1);
  }
} 
run().catch(logger.error);
