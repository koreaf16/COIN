import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'BTCUSDT';
    const query = `
      SELECT *
      FROM z0_price_ohlcv
      WHERE symbol = :symbol
        AND timeframe = '1m'
        AND ts >= TO_TIMESTAMP('2026-03-24 18:20:00', 'YYYY-MM-DD HH24:MI:SS')
        AND ts <= TO_TIMESTAMP('2026-03-24 18:40:00', 'YYYY-MM-DD HH24:MI:SS')
      ORDER BY ts ASC
    `;
    const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    console.log(JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    if (conn) await conn.close();
  }
}
main().catch(console.error);
