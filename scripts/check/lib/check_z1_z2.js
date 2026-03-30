import { logger } from '../../../src/shared/logger.js';
import { query } from './utils.js';

export async function checkZ1Z2(conn) {
  logger.info('\n━━━ [Z1] PROCESSED 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // z1_market_states
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt,
             MIN(ts) as oldest, MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*60, 1) as gap_min,
             ROUND(AVG(sentiment_score), 3) as avg_sentiment,
             MAX(volatility_regime) KEEP (DENSE_RANK LAST ORDER BY ts) as latest_regime
      FROM z1_market_states
      GROUP BY symbol
      ORDER BY symbol
    `);
    logger.info('\n[z1_market_states] 시장 상태 벡터');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ⚠️  데이터 없음 — StateVectorBuilder가 Z0 데이터 부족으로 미생성 가능');
    } else {
      for (const row of r.rows) {
        const gapOk = row.GAP_MIN < 10;
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_MIN}분)`;
        logger.info(`  ${flag} ${row.SYMBOL} ${row.CNT}건 regime=${row.LATEST_REGIME} sentiment=${row.AVG_SENTIMENT} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // z1_liquidation_map, z1_volatility_regime, z1_oi_matrix
  const z1Tables = [
    { name: 'z1_liquidation_map', label: '유동성 맵' },
    { name: 'z1_volatility_regime', label: '변동성 레짐', extra: 'regime' },
    { name: 'z1_oi_matrix', label: 'OI-가격 매트릭스', extra: 'interpretation' }
  ];
  for (const t of z1Tables) {
    const extraCol = t.extra ? `, MAX(${t.extra}) KEEP (DENSE_RANK LAST ORDER BY ts) as latest_extra` : '';
    const r = await query(conn, `SELECT symbol, COUNT(*) as cnt, MAX(ts) as newest ${extraCol} FROM ${t.name} GROUP BY symbol ORDER BY symbol`);
    logger.info(`\n[${t.name}] ${t.label}`);
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ℹ️  데이터 없음');
    } else {
      for (const row of r.rows) {
        const extra = t.extra ? ` ${t.extra}=${row.LATEST_EXTRA}` : '';
        logger.info(`  ✓ ${row.SYMBOL} ${row.CNT}건${extra} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  logger.info('\n━━━ [Z2] INTELLIGENCE 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await query(conn, `
      SELECT analysis_type, llm_source, COUNT(*) as cnt, MAX(ts) as newest,
             ROUND(AVG(latency_ms)) as avg_ms
      FROM z2_llm_analysis
      GROUP BY analysis_type, llm_source
      ORDER BY newest DESC
    `);
    logger.info('\n[z2_llm_analysis] LLM 분석 결과');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ℹ️  데이터 없음');
    } else {
      for (const row of r.rows) {
        logger.info(`  ✓ [${row.ANALYSIS_TYPE}/${row.LLM_SOURCE}] ${row.CNT}건 avg=${row.AVG_MS}ms | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  {
    const r = await query(conn, `
      SELECT status, COUNT(*) as cnt
      FROM z2_execution_plan
      GROUP BY status ORDER BY cnt DESC
    `);
    logger.info('\n[z2_execution_plan] 실행 플랜');
    if (!r.ok) {
      logger.info(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      logger.info('  ℹ️  플랜 없음');
    } else {
      for (const row of r.rows) {
        logger.info(`  ✓ status=${row.STATUS} ${row.CNT}건`);
      }
    }
  }
}
