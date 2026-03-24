import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const positionId = 12973248674;
    const query = `
      SELECT *
      FROM z3_logic_checks
      WHERE position_id = :positionId
      ORDER BY ts DESC
    `;
    const r = await conn.execute(query, { positionId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    console.log(JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    if (conn) await conn.close();
  }
}
main().catch(console.error);
