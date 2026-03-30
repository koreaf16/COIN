import { logger } from '../../../src/shared/logger.js';
import { query } from './utils.js';

export async function checkZ0(conn) {
  logger.info('━━━ [Z0] RAW DATA 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. z0_price_ohlcv
  {
    const r = await query(conn, `
      SELECT symbol, timeframe, COUNT(*) as cnt,
             MIN(ts) as oldest, MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*24*60, 1) as gap_min
      FROM z0_price_ohlcv
      GROUP BY symbol, timeframe
      ORDER BY symbol, timeframe
    `);
    logger.info('\n[z0_price_ohlcv] OHLCV 가격 데이터');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        const tfThreshold = { '1m': 5, '5m': 10, '1h': 90, '4h': 360, '1d': 1560 };
        const gapOk = row.GAP_MIN < (tfThreshold[row.TIMEFRAME] || 10);
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_MIN}분)`;
        logger.info(`  ${flag} ${row.SYMBOL} [${row.TIMEFRAME}] ${row.CNT}건 | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 2. z0_derivatives
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt,
             MIN(ts) as oldest, MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*24*60, 1) as gap_min,
             ROUND(AVG(funding_rate)*100, 4) as avg_fr_pct,
             MAX(open_interest) as latest_oi
      FROM z0_derivatives
      GROUP BY symbol
      ORDER BY symbol
    `);
    logger.info('\n[z0_derivatives] OI / 펀딩비 / 롱숏비');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        const gapOk = row.GAP_MIN < 10;
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_MIN}분)`;
        logger.info(`  ${flag} ${row.SYMBOL} ${row.CNT}건 | FR평균=${row.AVG_FR_PCT}% OI=${Number(row.LATEST_OI||0).toLocaleString()} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 3. z0_liquidation_raw
  {
    const r = await query(conn, `
      SELECT symbol,
             COUNT(*) as total,
             SUM(CASE WHEN side='BUY' THEN 1 ELSE 0 END) as long_liq,
             SUM(CASE WHEN side='SELL' THEN 1 ELSE 0 END) as short_liq,
             ROUND(SUM(usd_value)/1e6, 2) as total_usd_m,
             MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*24*60, 1) as gap_min
      FROM z0_liquidation_raw
      GROUP BY symbol
      ORDER BY total DESC
    `);
    logger.info('\n[z0_liquidation_raw] 강제청산 이벤트');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ℹ️  데이터 없음 (정상: 청산 없을 수도 있음)');
    } else {
      for (const row of r.rows) {
        logger.info(`  ✓ ${row.SYMBOL} 총${row.TOTAL}건 롱청산=${row.LONG_LIQ} 숏청산=${row.SHORT_LIQ} $${row.TOTAL_USD_M}M | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 4. z0_macro_data
  {
    const r = await query(conn, `
      SELECT indicator, COUNT(*) as cnt, MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*24, 1) as gap_hr,
             ROUND(MAX(value), 4) as latest_val
      FROM z0_macro_data
      GROUP BY indicator
      ORDER BY indicator
    `);
    logger.info('\n[z0_macro_data] 매크로 지표 (DXY, VIX, US10Y 등)');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        const gapOk = row.GAP_HR < 4;
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_HR}h)`;
        logger.info(`  ${flag} ${row.INDICATOR.padEnd(15)} ${row.CNT}건 val=${row.LATEST_VAL} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 5. z0_news_raw
  {
    const r = await query(conn, `
      SELECT source, COUNT(*) as cnt,
             MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*60, 1) as gap_min
      FROM z0_news_raw
      GROUP BY source
      ORDER BY newest DESC
    `);
    logger.info('\n[z0_news_raw] 뉴스 피드');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        logger.info(`  ✓ [${row.SOURCE}] ${row.CNT}건 | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 6. Coinglass 계열
  {
    const coinglassTables = ['z0_fear_greed', 'z0_stablecoin_supply', 'z0_economic_calendar'];
    logger.info('\n[Coinglass/Fear&Greed/Stablecoin/Economic Calendar]');
    for (const t of coinglassTables) {
      const sql = t === 'z0_economic_calendar'
        ? `SELECT COUNT(*) as cnt, MAX(fetched_at) as newest FROM z0_economic_calendar`
        : `SELECT COUNT(*) as cnt, MAX(ts) as newest FROM ${t}`;
      const r = await query(conn, sql);
      if (!r.ok) {
        if (r.err.includes('ORA-00942')) {
          logger.info(`  — ${t}: 테이블 없음 (미생성)`);
        } else {
          logger.info(`  ⚠️  ${t}: ERROR - ${r.err}`);
        }
      } else {
        const row = r.rows[0];
        const cnt = row.CNT;
        const newest = row.NEWEST;
        if (cnt === 0) {
          logger.info(`  ⚠️  ${t}: 0건 (데이터 없음)`);
        } else {
          logger.info(`  ✓ ${t}: ${cnt}건 | 최신: ${newest?.toISOString()}`);
        }
      }
    }
  }
}
