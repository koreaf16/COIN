import { initDb, getConnection } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
    await initDb();
    const conn = await getConnection();
    try {
        const query = `
            SELECT id, symbol, direction, entry_price, exit_price, pnl_pct, exit_reason, 
                   entry_reasoning, exit_details,
                   TO_CHAR(entry_time, 'YYYY-MM-DD HH24:MI:SS') as entry_time
            FROM z4_positions 
            WHERE symbol IN ('SOLUSDT', 'ETHUSDT') 
              AND exit_reason = 'STOP_CONDITION'
              AND status = 'CLOSED'
            FETCH FIRST 5 ROWS ONLY
        `;
        const r = await conn.execute(query, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        const results = [];
        for (const row of r.rows) {
            let entryRes = row.ENTRY_REASONING;
            if (entryRes) {
                if (entryRes.getData) entryRes = await entryRes.getData();
            }
            
            let exitDet = row.EXIT_DETAILS;
            if (exitDet) {
                if (exitDet.getData) exitDet = await exitDet.getData();
            }

            results.push({
                id: row.ID,
                symbol: row.SYMBOL,
                dir: row.DIRECTION,
                pnl: row.PNL_PCT.toFixed(2),
                entryTime: row.ENTRY_TIME,
                entry: entryRes,
                exit: exitDet
            });
        }
        console.log(JSON.stringify(results, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        if (conn) await conn.close();
        process.exit(0);
    }
}
main().catch(console.error);
