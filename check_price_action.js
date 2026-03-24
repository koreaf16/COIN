import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'BRUSDT';
    const query = `
      SELECT symbol, TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS') as t, open_price, high_price, low_price, close_price, volume
      FROM z0_price_ohlcv
      WHERE symbol = :symbol
      AND timeframe = '1m'
      AND ts BETWEEN TO_TIMESTAMP('2026-03-23 17:50:00', 'YYYY-MM-DD HH24:MI:SS') 
                 AND TO_TIMESTAMP('2026-03-23 18:51:00', 'YYYY-MM-DD HH24:MI:SS')
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
