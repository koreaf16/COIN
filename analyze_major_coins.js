import { initDb, getConnection } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
    await initDb();
    const conn = await getConnection();
    try {
        const majorCoins = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
        const placeholders = majorCoins.map((_, i) => `:${i}`).join(',');
        
        const query = `
            SELECT 
                symbol, 
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN pnl_pct < 0 THEN 1 ELSE 0 END) as losses,
                SUM(pnl_amount) as total_pnl_usd,
                AVG(pnl_pct) as avg_pnl_pct,
                MIN(entry_time) as first_trade,
                MAX(exit_time) as last_trade
            FROM z4_positions
            WHERE status = 'CLOSED' 
              AND symbol IN (${placeholders})
            GROUP BY symbol
            ORDER BY total_pnl_usd DESC
        `;

        const r = await conn.execute(query, majorCoins, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        console.log('--- Performance Analysis for Major Coins ---');
        let totalAllTrades = 0;
        let totalAllWins = 0;
        let totalAllPnl = 0;
        let overallFirstTrade = null;
        let overallLastTrade = null;

        const results = r.rows.map(row => {
            const winRate = row.TOTAL_TRADES > 0 ? (row.WINS / row.TOTAL_TRADES * 100).toFixed(2) : 0;
            totalAllTrades += row.TOTAL_TRADES;
            totalAllWins += row.WINS;
            totalAllPnl += row.TOTAL_PNL_USD;

            if (!overallFirstTrade || row.FIRST_TRADE < overallFirstTrade) overallFirstTrade = row.FIRST_TRADE;
            if (!overallLastTrade || row.LAST_TRADE > overallLastTrade) overallLastTrade = row.LAST_TRADE;

            return {
                Symbol: row.SYMBOL,
                Trades: row.TOTAL_TRADES,
                Wins: row.WINS,
                Losses: row.LOSSES,
                'Win Rate (%)': winRate,
                'PnL (USD)': row.TOTAL_PNL_USD.toFixed(2),
                'Avg PnL (%)': row.AVG_PNL_PCT.toFixed(4)
            };
        });

        console.table(results);

        if (totalAllTrades > 0) {
            console.log('\n--- Overall Major Coins Summary ---');
            console.log(`Period: ${overallFirstTrade.toISOString().split('T')[0]} ~ ${overallLastTrade.toISOString().split('T')[0]}`);
            console.log(`Total Trades: ${totalAllTrades}`);
            console.log(`Overall Win Rate: ${(totalAllWins / totalAllTrades * 100).toFixed(2)}%`);
            console.log(`Total PnL: ${totalAllPnl.toFixed(2)} USDT`);
        } else {
            console.log('No trades found for major coins.');
        }

    } catch (e) {
        console.error(e);
    } finally {
        if (conn) await conn.close();
        process.exit(0);
    }
}

main().catch(console.error);
