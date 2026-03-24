import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'BTCUSDT';
    // Searching for trades closed around 05:28 or entered around that time on March 24th
    const query = `
      SELECT *
      FROM z4_positions
      WHERE symbol = :symbol
        AND entry_time >= TIMESTAMP '2026-03-23 00:00:00'
      ORDER BY entry_time DESC
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
