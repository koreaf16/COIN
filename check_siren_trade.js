import { getPool, initDb } from './src/shared/db.js';
import fs from 'fs';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const q = `
      SELECT id, symbol, direction, entry_price, entry_time,
             exit_price, exit_time, exit_reason, pnl_pct, pnl_amount,
             entry_reasoning, exit_details
      FROM z4_positions
      WHERE symbol = 'SIRENUSDT' AND direction = 'SHORT'
        AND exit_reason = 'INVALIDATION'
      ORDER BY entry_time DESC
      FETCH FIRST 1 ROWS ONLY
    `;
    const r = await conn.execute(q);
    
    if (r.rows.length > 0) {
      const row = r.rows[0];
      const data = {
        id: row[0],
        symbol: row[1],
        direction: row[2],
        entry_price: row[3],
        entry_time: row[4],
        exit_price: row[5],
        exit_time: row[6],
        exit_reason: row[7],
        pnl_pct: row[8],
        pnl_amount: row[9],
        entry_reasoning: row[10],
        exit_details: row[11]
      };
      
      fs.writeFileSync('C:\\COIN\\tmp_siren_trade.json', JSON.stringify(data, null, 2), 'utf8');
      console.log('Saved trade details to tmp_siren_trade.json');
    } else {
      console.log('Trade not found.');
    }
  } finally {
    await conn.close();
    try { await pool.close(); } catch(e) {}
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
