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
      console.log("Total candles:", candleData.length);
      console.log("Last 20 candles:");
      console.log(JSON.stringify(candleData.slice(-20), null, 2));
      
      // Also check if there's a big gap
      const first = candleData[0].time;
      const last = candleData[candleData.length - 1].time;
      console.log("Range (sec):", last - first);
      console.log("Expected candles (if 1s):", last - first + 1);
    } else {
      console.log("No trade found");
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (conn) await conn.close();
  }
}
main().catch(console.error);
