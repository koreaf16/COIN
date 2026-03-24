import { initDb, getPool } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const symbol = 'BRUSDT';
    const query = `
      SELECT CANDLE_DATA
      FROM z4_positions
      WHERE symbol = :symbol
      ORDER BY exit_time DESC
      FETCH FIRST 1 ROWS ONLY
    `;
    const r = await conn.execute(query, { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    if (r.rows.length > 0) {
      const candleData = JSON.parse(r.rows[0].CANDLE_DATA);
      let maxHigh = 0;
      let maxTime = 0;
      for (const c of candleData) {
        if (c.high > maxHigh) {
          maxHigh = c.high;
          maxTime = c.time;
        }
      }
      console.log("Max High:", maxHigh, "at", new Date(maxTime * 1000).toISOString());
      
      // Check 18:12 specifically
      const time1812 = 1774289520; // roughly
      const candle1812 = candleData.find(c => c.time >= time1812 && c.time < time1812 + 60);
      console.log("Example candle around 18:12:", candle1812);
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (conn) await conn.close();
  }
}
main().catch(console.error);
