import { getPool, initDb } from './src/shared/db.js';

async function run() { 
  await initDb(); 
  const pool = await getPool(); 
  const conn = await pool.getConnection(); 
  const r = await conn.execute("SELECT id, symbol, entry_time, exit_time, exit_reason FROM z4_positions WHERE symbol = 'SIRENUSDT' ORDER BY entry_time DESC FETCH FIRST 5 ROWS ONLY"); 
  console.log(r.rows); 
  await conn.close(); 
  process.exit(0); 
} 
run().catch(console.error);