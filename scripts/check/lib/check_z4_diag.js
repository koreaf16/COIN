import { logger } from '../../../src/shared/logger.js';
import { query } from './utils.js';

export async function checkZ4Diag(conn) {
  logger.info('\n━━━ [Z4] RESULTS 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await query(conn, `
      SELECT status, direction, COUNT(*) as cnt,
             ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
      FROM z4_positions
      GROUP BY status, direction
      ORDER BY status, direction
    `);
    logger.info('\n[z4_positions] 포지션');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ℹ️  포지션 없음');
    } else {
      for (const row of r.rows) {
        logger.info(`  ✓ ${row.STATUS} ${row.DIRECTION} ${row.CNT}건 avg_pnl=${row.AVG_PNL_PCT}%`);
      }
    }
  }

  logger.info('\n━━━ 이상 징후 진단 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 최근 5분간 OHLCV
  {
    const r = await query(conn, `
      SELECT symbol, timeframe, COUNT(*) as cnt
      FROM z0_price_ohlcv
      WHERE ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '5' MINUTE
      GROUP BY symbol, timeframe
      ORDER BY symbol, timeframe
    `);
    if (!r.ok) {
      logger.info(`\n최근 5분 OHLCV: ERROR - ${r.err}`);
    } else {
      logger.info(`\n[최근 5분 OHLCV 수신]: ${r.rows.length === 0 ? '⚠️  없음 (WebSocket 끊김 가능성)' : r.rows.length + '개 스트림 활성'}`);
      for (const row of r.rows) {
        logger.info(`  ${row.SYMBOL} [${row.TIMEFRAME}] ${row.CNT}건`);
      }
    }
  }

  // z0_derivatives 최근 5분
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt
      FROM z0_derivatives
      WHERE ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '5' MINUTE
      GROUP BY symbol
    `);
    if (!r.ok) {
      logger.info(`최근 5분 derivatives: ERROR`);
    } else {
      logger.info(`\n[최근 5분 Derivatives]: ${r.rows.length === 0 ? '⚠️  없음 (REST Collector 미동작)' : r.rows.map(x => x.SYMBOL + '=' + x.CNT + '건').join(', ')}`);
    }
  }

  // z1_market_states 최근 10분
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt
      FROM z1_market_states
      WHERE ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '10' MINUTE
      GROUP BY symbol
    `);
    if (!r.ok) {
      logger.info(`최근 10분 market_states: ERROR`);
    } else {
      logger.info(`\n[최근 10분 Z1 State Vector]: ${r.rows.length === 0 ? '⚠️  없음 (StateVectorBuilder 미동작)' : r.rows.map(x => x.SYMBOL + '=' + x.CNT + '건').join(', ')}`);
    }
  }

  // CVD 칼럼 null 체크
  {
    const r = await query(conn, `
      SELECT COUNT(*) as null_cvd, symbol, timeframe
      FROM z0_price_ohlcv
      WHERE cvd IS NULL OR cvd = 0
      GROUP BY symbol, timeframe
      HAVING COUNT(*) > 5
      ORDER BY null_cvd DESC
      FETCH FIRST 5 ROWS ONLY
    `);
    if (!r.ok) {
      logger.info(`CVD null 체크: ERROR`);
    } else if (r.rows.length > 0) {
      logger.info(`\n[CVD 이상] CVD=0인 행 다수 (PL/SQL 트리거 미작동 가능성)`);
      for (const row of r.rows) {
        logger.info(`  ${row.SYMBOL} [${row.TIMEFRAME}] null/zero CVD ${row.NULL_CVD}건`);
      }
    } else {
      logger.info(`\n[CVD]: 정상 (null/zero 소량)`);
    }
  }
}
