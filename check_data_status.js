/**
 * 데이터 수집 전수조사 스크립트
 * Z0 (Raw) → Z1 (Processed) 전체 테이블 상태 점검
 */

import { initDb, getConnection, closeDb } from './src/shared/db.js';
import oracledb from 'oracledb';

const SEP = '─'.repeat(70);

async function query(conn, sql, binds = {}) {
  try {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function main() {
  console.log('\n' + SEP);
  console.log(' COIN v2 — 데이터 수집 전수조사 (UTC 기준)');
  console.log(SEP);

  await initDb();
  const conn = await getConnection();

  const now = new Date();
  console.log(`\n점검 시각: ${now.toISOString()}\n`);

  // ─── Z0: Raw 테이블 ───────────────────────────────────────────────────────

  console.log('━━━ [Z0] RAW DATA 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. z0_price_ohlcv — 심볼별 타임프레임별 현황
  {
    const r = await query(conn, `
      SELECT symbol, timeframe, COUNT(*) as cnt,
             MIN(ts) as oldest, MAX(ts) as newest,
             ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(ts) AS DATE))*24*60, 1) as gap_min
      FROM z0_price_ohlcv
      GROUP BY symbol, timeframe
      ORDER BY symbol, timeframe
    `);
    console.log('\n[z0_price_ohlcv] OHLCV 가격 데이터');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        const tfThreshold = { '1m': 5, '5m': 10, '1h': 90, '4h': 360, '1d': 1560 };
        const gapOk = row.GAP_MIN < (tfThreshold[row.TIMEFRAME] || 10);
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_MIN}분)`;
        console.log(`  ${flag} ${row.SYMBOL} [${row.TIMEFRAME}] ${row.CNT}건 | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 2. z0_derivatives — 심볼별 OI/펀딩비
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
    console.log('\n[z0_derivatives] OI / 펀딩비 / 롱숏비');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        const gapOk = row.GAP_MIN < 10;
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_MIN}분)`;
        console.log(`  ${flag} ${row.SYMBOL} ${row.CNT}건 | FR평균=${row.AVG_FR_PCT}% OI=${Number(row.LATEST_OI||0).toLocaleString()} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 3. z0_liquidation_raw — 청산 이벤트
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
    console.log('\n[z0_liquidation_raw] 강제청산 이벤트');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  데이터 없음 (정상: 청산 없을 수도 있음)');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ ${row.SYMBOL} 총${row.TOTAL}건 롱청산=${row.LONG_LIQ} 숏청산=${row.SHORT_LIQ} $${row.TOTAL_USD_M}M | 최신: ${row.NEWEST?.toISOString()}`);
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
    console.log('\n[z0_macro_data] 매크로 지표 (DXY, VIX, US10Y 등)');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        const gapOk = row.GAP_HR < 4;
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_HR}h)`;
        console.log(`  ${flag} ${row.INDICATOR.padEnd(15)} ${row.CNT}건 val=${row.LATEST_VAL} | 최신: ${row.NEWEST?.toISOString()}`);
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
    console.log('\n[z0_news_raw] 뉴스 피드');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ⚠️  데이터 없음 (0 rows)');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ [${row.SOURCE}] ${row.CNT}건 | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // 6. Coinglass 계열 테이블 확인
  {
    const coinglassTables = ['z0_fear_greed', 'z0_stablecoin_supply', 'z0_economic_calendar'];
    console.log('\n[Coinglass/Fear&Greed/Stablecoin/Economic Calendar]');
    for (const t of coinglassTables) {
      const sql = t === 'z0_economic_calendar'
        ? `SELECT COUNT(*) as cnt, MAX(fetched_at) as newest FROM z0_economic_calendar`
        : `SELECT COUNT(*) as cnt, MAX(ts) as newest FROM ${t}`;
      const r = await query(conn, sql);
      if (!r.ok) {
        if (r.err.includes('ORA-00942')) {
          console.log(`  — ${t}: 테이블 없음 (미생성)`);
        } else {
          console.log(`  ⚠️  ${t}: ERROR - ${r.err}`);
        }
      } else {
        const row = r.rows[0];
        const cnt = row.CNT;
        const newest = row.NEWEST;
        if (cnt === 0) {
          console.log(`  ⚠️  ${t}: 0건 (데이터 없음)`);
        } else {
          console.log(`  ✓ ${t}: ${cnt}건 | 최신: ${newest?.toISOString()}`);
        }
      }
    }
  }

  // ─── Z1: Processed 테이블 ────────────────────────────────────────────────

  console.log('\n━━━ [Z1] PROCESSED 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
    console.log('\n[z1_market_states] 시장 상태 벡터');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ⚠️  데이터 없음 — StateVectorBuilder가 Z0 데이터 부족으로 미생성 가능');
    } else {
      for (const row of r.rows) {
        const gapOk = row.GAP_MIN < 10;
        const flag = gapOk ? '✓' : `⚠️  (갭=${row.GAP_MIN}분)`;
        console.log(`  ${flag} ${row.SYMBOL} ${row.CNT}건 regime=${row.LATEST_REGIME} sentiment=${row.AVG_SENTIMENT} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // z1_liquidation_map
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt, MAX(ts) as newest
      FROM z1_liquidation_map
      GROUP BY symbol ORDER BY symbol
    `);
    console.log('\n[z1_liquidation_map] 유동성 맵');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  데이터 없음');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ ${row.SYMBOL} ${row.CNT}건 | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // z1_volatility_regime
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt, MAX(ts) as newest,
             MAX(regime) KEEP (DENSE_RANK LAST ORDER BY ts) as latest_regime
      FROM z1_volatility_regime
      GROUP BY symbol ORDER BY symbol
    `);
    console.log('\n[z1_volatility_regime] 변동성 레짐');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  데이터 없음');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ ${row.SYMBOL} ${row.CNT}건 regime=${row.LATEST_REGIME} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // z1_oi_matrix
  {
    const r = await query(conn, `
      SELECT symbol, COUNT(*) as cnt, MAX(ts) as newest,
             MAX(interpretation) KEEP (DENSE_RANK LAST ORDER BY ts) as latest_interp
      FROM z1_oi_matrix
      GROUP BY symbol ORDER BY symbol
    `);
    console.log('\n[z1_oi_matrix] OI-가격 매트릭스');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  데이터 없음');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ ${row.SYMBOL} ${row.CNT}건 해석=${row.LATEST_INTERP} | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  // ─── Z2: Intelligence 레이어 ─────────────────────────────────────────────

  console.log('\n━━━ [Z2] INTELLIGENCE 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await query(conn, `
      SELECT analysis_type, llm_source, COUNT(*) as cnt, MAX(ts) as newest,
             ROUND(AVG(latency_ms)) as avg_ms
      FROM z2_llm_analysis
      GROUP BY analysis_type, llm_source
      ORDER BY newest DESC
    `);
    console.log('\n[z2_llm_analysis] LLM 분석 결과');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  데이터 없음');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ [${row.ANALYSIS_TYPE}/${row.LLM_SOURCE}] ${row.CNT}건 avg=${row.AVG_MS}ms | 최신: ${row.NEWEST?.toISOString()}`);
      }
    }
  }

  {
    const r = await query(conn, `
      SELECT status, COUNT(*) as cnt
      FROM z2_execution_plan
      GROUP BY status ORDER BY cnt DESC
    `);
    console.log('\n[z2_execution_plan] 실행 플랜');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  플랜 없음');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ status=${row.STATUS} ${row.CNT}건`);
      }
    }
  }

  // ─── Z4: Results 레이어 ──────────────────────────────────────────────────

  console.log('\n━━━ [Z4] RESULTS 레이어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await query(conn, `
      SELECT status, direction, COUNT(*) as cnt,
             ROUND(AVG(pnl_pct), 2) as avg_pnl_pct
      FROM z4_positions
      GROUP BY status, direction
      ORDER BY status, direction
    `);
    console.log('\n[z4_positions] 포지션');
    if (!r.ok) {
      console.log(`  ERROR: ${r.err}`);
    } else if (r.rows.length === 0) {
      console.log('  ℹ️  포지션 없음');
    } else {
      for (const row of r.rows) {
        console.log(`  ✓ ${row.STATUS} ${row.DIRECTION} ${row.CNT}건 avg_pnl=${row.AVG_PNL_PCT}%`);
      }
    }
  }

  // ─── 이상 징후 진단 ─────────────────────────────────────────────────────

  console.log('\n━━━ 이상 징후 진단 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 최근 1분간 OHLCV 수신 체크
  {
    const r = await query(conn, `
      SELECT symbol, timeframe, COUNT(*) as cnt
      FROM z0_price_ohlcv
      WHERE ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '5' MINUTE
      GROUP BY symbol, timeframe
      ORDER BY symbol, timeframe
    `);
    if (!r.ok) {
      console.log(`\n최근 5분 OHLCV: ERROR - ${r.err}`);
    } else {
      console.log(`\n[최근 5분 OHLCV 수신]: ${r.rows.length === 0 ? '⚠️  없음 (WebSocket 끊김 가능성)' : r.rows.length + '개 스트림 활성'}`);
      for (const row of r.rows) {
        console.log(`  ${row.SYMBOL} [${row.TIMEFRAME}] ${row.CNT}건`);
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
      console.log(`최근 5분 derivatives: ERROR`);
    } else {
      console.log(`\n[최근 5분 Derivatives]: ${r.rows.length === 0 ? '⚠️  없음 (REST Collector 미동작)' : r.rows.map(x => x.SYMBOL + '=' + x.CNT + '건').join(', ')}`);
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
      console.log(`최근 10분 market_states: ERROR`);
    } else {
      console.log(`\n[최근 10분 Z1 State Vector]: ${r.rows.length === 0 ? '⚠️  없음 (StateVectorBuilder 미동작)' : r.rows.map(x => x.SYMBOL + '=' + x.CNT + '건').join(', ')}`);
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
      console.log(`CVD null 체크: ERROR`);
    } else if (r.rows.length > 0) {
      console.log(`\n[CVD 이상] CVD=0인 행 다수 (PL/SQL 트리거 미작동 가능성)`);
      for (const row of r.rows) {
        console.log(`  ${row.SYMBOL} [${row.TIMEFRAME}] null/zero CVD ${row.NULL_CVD}건`);
      }
    } else {
      console.log(`\n[CVD]: 정상 (null/zero 소량)`);
    }
  }

  console.log('\n' + SEP);
  console.log(' 점검 완료');
  console.log(SEP + '\n');

  await conn.close();
  await closeDb();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
