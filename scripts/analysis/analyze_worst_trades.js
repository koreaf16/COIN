/**
 * @module 최악의 거래 분석
 * @description 손실이 큰 거래들을 추출하여 진입 근거 및 로직 체크 결과를 분석한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Worst    │ ──→ │ Logger   │
 * │ DB       │     │ Trades   │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/analysis
 * @dependencies db.js, oracledb, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { initDb, getPool } from '../../src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
  try {
    await initDb();
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const query = `
        SELECT id, symbol, direction, entry_price, exit_price, pnl_pct, pnl_amount, exit_reason,
               entry_reasoning, exit_details,
               TO_CHAR(entry_time, 'YYYY-MM-DD HH24:MI:SS') AS entry_time,
               TO_CHAR(exit_time, 'YYYY-MM-DD HH24:MI:SS') AS exit_time
        FROM z4_positions
        WHERE status = 'CLOSED' AND pnl_pct < 0
        ORDER BY pnl_pct ASC
        FETCH FIRST 15 ROWS ONLY
      `;
      const r = await conn.execute(query, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      
      const results = [];
      for (const row of r.rows) {
        const p = await conn.execute(`
          SELECT check_result, recommendation,
                 TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS') AS check_time
          FROM z3_logic_checks
          WHERE position_id = :id
          ORDER BY ts DESC
          FETCH FIRST 3 ROWS ONLY
        `, { id: row.ID }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        let entryReasoningStr = null;
        if (row.ENTRY_REASONING) {
            if (row.ENTRY_REASONING.getData) {
                entryReasoningStr = await row.ENTRY_REASONING.getData();
            } else {
                entryReasoningStr = row.ENTRY_REASONING;
            }
        }
        
        let exitDetailsStr = null;
        if (row.EXIT_DETAILS) {
            if (row.EXIT_DETAILS.getData) {
                exitDetailsStr = await row.EXIT_DETAILS.getData();
            } else {
                exitDetailsStr = row.EXIT_DETAILS;
            }
        }

        results.push({
          id: row.ID,
          symbol: row.SYMBOL,
          direction: row.DIRECTION,
          entryTime: row.ENTRY_TIME,
          exitTime: row.EXIT_TIME,
          pnlPct: row.PNL_PCT,
          exitReason: row.EXIT_REASON,
          entryReasoning: entryReasoningStr,
          exitDetails: exitDetailsStr,
          lastLogicChecks: await Promise.all(p.rows.map(async checkRow => {
              let resStr = null;
              if (checkRow.CHECK_RESULT) {
                  if (checkRow.CHECK_RESULT.getData) resStr = await checkRow.CHECK_RESULT.getData();
                  else resStr = checkRow.CHECK_RESULT;
              }
              return {
                  time: checkRow.CHECK_TIME,
                  recommendation: checkRow.RECOMMENDATION,
                  result: resStr
              };
          }))
        });
      }
      logger.info(JSON.stringify(results, null, 2));

    } finally {
      if (conn) await conn.close();
      process.exit(0);
    }
  } catch (e) {
    logger.error("Error in analyze_worst_trades:", e);
    process.exit(1);
  }
}
main().catch(logger.error);
