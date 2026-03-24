import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'RIVERUSDT';
    const query = `
      SELECT p.*, ep.reasoning, ep.entry_conditions, ep.stop_conditions, ep.time_stop_min
      FROM z4_positions p
      LEFT JOIN z2_execution_plan ep ON p.plan_id = ep.id
      WHERE p.symbol = :symbol
        AND p.entry_time >= TIMESTAMP '2026-03-23 00:00:00'
      ORDER BY p.entry_time DESC
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
