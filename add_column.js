import { initDb, getPool } from './src/shared/db.js';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.execute('ALTER TABLE z1_market_states ADD volatility_acceleration NUMBER');
    console.log('Added volatility_acceleration column');
  } catch (e) {
    if (e.message.includes('ORA-01430')) {
      console.log('Column already exists');
    } else {
      console.error(e);
    }
  } finally {
    await conn.close();
  }
}
main().catch(console.error);
