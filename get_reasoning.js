import { getPool, initDb } from './src/shared/db.js';
import fs from 'fs';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const q = `SELECT entry_reasoning FROM z4_positions WHERE id = 8604232445`;
    const r = await conn.execute(q);
    if (r.rows.length > 0) {
      fs.writeFileSync('C:\\COIN\\tmp_reasoning.json', JSON.stringify(r.rows[0][0], null, 2), 'utf8');
      console.log('Saved to tmp_reasoning.json');
    }
  } finally {
    await conn.close();
    try { await pool.close(); } catch(e) {}
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });