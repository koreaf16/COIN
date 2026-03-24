import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const positionId = 342643446;
    const query = `
      SELECT ts, action, price, qty, fee_amount
      FROM z4_trade_log
      WHERE position_id = :positionId
      ORDER BY ts ASC
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
