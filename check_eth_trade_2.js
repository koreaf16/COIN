import { getPool, initDb } from './src/shared/db.js';

async function main() {
  console.log("Connecting to Oracle DB...");
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const q2 = `
      SELECT id, exit_details, entry_reasoning
      FROM z4_positions
      WHERE id = 8604232445
    `;
    const r2 = await conn.execute(q2);
    for (const row of r2.rows) {
      console.log(`ID: ${row[0]}`);
      console.log(`Exit Details: ${JSON.stringify(row[1], null, 2)}`);
      console.log(`Entry Reasoning: ${JSON.stringify(row[2], null, 2)}`);
    }
  } finally {
    await conn.close();
    // Use pool.close() instead of pool.close(0) if it's not supported, or just let node exit.
    try { await pool.close(); } catch(e) {}
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
