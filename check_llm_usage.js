
import { getPool, initDb } from './src/shared/db.js';

async function main() {
  await initDb();
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const query = `
      SELECT 
        analysis_type, 
        COUNT(*) as calls,
        SUM(token_count) as total_tokens,
        AVG(token_count) as avg_tokens
      FROM z2_llm_analysis
      WHERE ts > SYSTIMESTAMP - INTERVAL '1' DAY
      GROUP BY analysis_type
    `;
    const result = await conn.execute(query);
    console.log("=== LLM Usage in last 24h ===");
    console.log("Type | Calls | Total Tokens | Avg Tokens");
    for (const row of result.rows) {
      console.log(`${row[0]} | ${row[1]} | ${row[2]} | ${row[3]?.toFixed(0)}`);
    }

    const totalQuery = `
      SELECT SUM(token_count) FROM z2_llm_analysis
      WHERE ts > SYSTIMESTAMP - INTERVAL '1' DAY
    `;
    const totalResult = await conn.execute(totalQuery);
    console.log("-----------------------------------");
    console.log(`GRAND TOTAL TOKENS: ${totalResult.rows[0][0]}`);

  } catch (e) {
    console.error("Query Error:", e.message);
  } finally {
    await conn.close();
    process.exit(0);
  }
}
main().catch(console.error);
