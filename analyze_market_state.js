import { initDb, getConnection } from './src/shared/db.js';
import oracledb from 'oracledb';

async function main() {
    await initDb();
    const conn = await getConnection();
    try {
        console.log('--- 1. Hourly Performance Analysis (UTC) ---');
        const hourlyQuery = `
            SELECT 
                TO_CHAR(entry_time, 'HH24') as hour,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl_amount) as total_pnl
            FROM z4_positions
            WHERE symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT')
              AND status = 'CLOSED'
            GROUP BY TO_CHAR(entry_time, 'HH24')
            ORDER BY hour
        `;
        const hourlyResult = await conn.execute(hourlyQuery, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        console.table(hourlyResult.rows.map(r => ({
            Hour: r.HOUR,
            Trades: r.TOTAL_TRADES,
            WinRate: (r.WINS / r.TOTAL_TRADES * 100).toFixed(2) + '%',
            PnL: r.TOTAL_PNL.toFixed(2)
        })));

        console.log('\n--- 2. Correlation with Market State (Volatility & Trend) ---');
        // Join with closest market state (within 1 hour before entry)
        const stateQuery = `
            SELECT 
                p.symbol,
                p.pnl_pct,
                p.exit_reason,
                s.volatility_regime,
                s.trend_strength
            FROM z4_positions p
            LEFT JOIN z1_market_states s 
              ON p.symbol = s.symbol 
              AND s.ts = (
                  SELECT MAX(ts) 
                  FROM z1_market_states 
                  WHERE symbol = p.symbol AND ts <= p.entry_time
              )
            WHERE p.symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT')
              AND p.status = 'CLOSED'
        `;
        const stateResult = await conn.execute(stateQuery, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        const regimeStats = {};
        stateResult.rows.forEach(row => {
            const regime = row.VOLATILITY_REGIME || 'UNKNOWN';
            if (!regimeStats[regime]) {
                regimeStats[regime] = { trades: 0, wins: 0, pnl: 0, stop_cond: 0 };
            }
            regimeStats[regime].trades++;
            if (row.PNL_PCT > 0) regimeStats[regime].wins++;
            regimeStats[regime].pnl += row.PNL_PCT;
            if (row.EXIT_REASON === 'STOP_CONDITION') regimeStats[regime].stop_cond++;
        });

        console.log('Performance by Volatility Regime:');
        console.table(Object.keys(regimeStats).map(regime => ({
            Regime: regime,
            Trades: regimeStats[regime].trades,
            WinRate: (regimeStats[regime].wins / regimeStats[regime].trades * 100).toFixed(2) + '%',
            'Avg PnL (%)': (regimeStats[regime].pnl / regimeStats[regime].trades).toFixed(4),
            'Stop Rate (%)': (regimeStats[regime].stop_cond / regimeStats[regime].trades * 100).toFixed(2) + '%'
        })));

    } catch (e) {
        console.error(e);
    } finally {
        if (conn) await conn.close();
        process.exit(0);
    }
}
main().catch(console.error);
