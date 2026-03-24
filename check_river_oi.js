import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'RIVERUSDT';
    const query = `
      SELECT ts, price_dir, oi_dir, interpretation
      FROM z1_oi_matrix
      WHERE symbol = :symbol
        AND ts BETWEEN TIMESTAMP '2026-03-24 03:50:00' AND TIMESTAMP '2026-03-24 04:05:00'
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
