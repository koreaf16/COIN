/**
 * @module 거래 근거 추출
 * @description 특정 거래의 진입 근거(reasoning)를 추출하여 파일로 저장한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Reasoning│ ──→ │ JSON     │
 * │ DB       │     │ Extractor│     │ File     │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/analysis
 * @dependencies db.js, fs, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { getPool, initDb } from '../../src/shared/db.js';
import fs from 'fs';

async function main() {
  try {
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const q = `SELECT entry_reasoning FROM z4_positions WHERE id = 8604232445`;
      const r = await conn.execute(q);
      if (r.rows.length > 0) {
        fs.writeFileSync('C:\\COIN\\tmp_reasoning.json', JSON.stringify(r.rows[0][0], null, 2), 'utf8');
        logger.info('Saved to tmp_reasoning.json');
      }
    } finally {
      await conn.close();
      try { await pool.close(); } catch(e) {}
    }
  } catch (e) {
    logger.error("Error in get_reasoning:", e);
  }
}
main().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
