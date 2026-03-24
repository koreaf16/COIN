import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'BRUSDT';
    const query = `
      SELECT *
      FROM z4_positions
      WHERE symbol = :symbol
      ORDER BY exit_time DESC
    `;
    const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    console.log(JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    if (conn) await conn.close();
    // if (pool) await pool.close(0); // oracledb pool close can be tricky if others are using it
  }
}
main().catch(console.error);
