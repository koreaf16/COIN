import { config } from './src/shared/config.js';
import { getPool, initDb } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  console.log("Connecting to Oracle DB...");
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
        console.log(`${t}: ${r.rows[0][0]} rows`);
      } catch (e) {
        console.log(`${t}: ERROR - ${e.message}`);
      }
    }
  } finally {
    await conn.close();
    await pool.close(0);
  }
}
main().catch(console.error);