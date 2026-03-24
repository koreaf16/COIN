import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'RIVERUSDT';
    const query = `
      SELECT * FROM (
        SELECT ts, open_price, high_price, low_price, close_price, volume
        FROM z0_price_ohlcv
        WHERE symbol = :symbol
          AND timeframe = '1m'
        ORDER BY ts DESC
      ) WHERE ROWNUM <= 50
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
