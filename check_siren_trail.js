import { getPool, initDb } from './src/shared/db.js';
import fs from 'fs';

async function run() { 
  await initDb(); 
  const pool = await getPool(); 
  const conn = await pool.getConnection(); 
  const r = await conn.execute("SELECT id, symbol, entry_time, exit_time, exit_reason, entry_price, exit_price, pnl_amount, exit_details FROM z4_positions WHERE symbol = 'SIRENUSDT' AND exit_reason = 'TRAILING_STOP' ORDER BY entry_time DESC FETCH FIRST 1 ROWS ONLY", [], { outFormat: 4002 /* oracledb.OUT_FORMAT_OBJECT */ }); 
  fs.writeFileSync('tmp_siren_trail.json', JSON.stringify(r.rows, null, 2));
  console.log('Saved to tmp_siren_trail.json'); 
  await conn.close(); 
  process.exit(0); 
} 
run().catch(console.error);