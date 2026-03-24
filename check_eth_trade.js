import { getPool, initDb } from './src/shared/db.js';

async function main() {
  console.log("Connecting to Oracle DB...");
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const q = `
      SELECT id, symbol, direction, entry_price, entry_time,
             exit_price, exit_time, exit_reason, pnl_pct, pnl_amount
      FROM z4_positions
      WHERE symbol = 'ETHUSDT' AND direction = 'SHORT'
      ORDER BY entry_time DESC
      FETCH FIRST 10 ROWS ONLY
    `;
    const r = await conn.execute(q);
    console.log(r.metaData.map(m => m.name).join('\t'));
    for (const row of r.rows) {
      console.log(row.join('\t'));
    }

    console.log("\nDetails of the trailing stop trade:");
    const q2 = `
      SELECT id, exit_details, entry_reasoning
      FROM z4_positions
      WHERE symbol = 'ETHUSDT' AND direction = 'SHORT'
        AND exit_reason = 'TRAILING_STOP'
      ORDER BY entry_time DESC
      FETCH FIRST 1 ROWS ONLY
    `;
    const r2 = await conn.execute(q2);
    for (const row of r2.rows) {
      console.log(`ID: ${row[0]}`);
      console.log(`Exit Details: ${row[1]}`);
      console.log(`Entry Reasoning: ${row[2]}`);
    }

    console.log("\nLet's check execution logs or trailing stop logic logs if any:");
    const q3 = `
      SELECT id, execution_id, symbol, action_type, price, status
      FROM z3_executions
      WHERE symbol = 'ETHUSDT' AND position_id = (
        SELECT id FROM z4_positions 
        WHERE symbol = 'ETHUSDT' AND direction = 'SHORT' AND exit_reason = 'TRAILING_STOP'
        ORDER BY entry_time DESC FETCH FIRST 1 ROWS ONLY
      )
    `;
    try {
        const r3 = await conn.execute(q3);
        console.log(r3.metaData.map(m => m.name).join('\t'));
        for (const row of r3.rows) {
            console.log(row.join('\t'));
        }
    } catch(e) { console.log('z3_executions not found or error', e.message) }

  } finally {
    await conn.close();
    await pool.close(0);
  }
}
main().catch(console.error);
