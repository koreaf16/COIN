/**
 * @module 데이터 수집 전수조사 메인
 * @description Z0 → Z1 → Z2 → Z4 전체 파이프라인의 데이터 적재 상태를 점검한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Oracle   │ ──→ │ Status   │ ──→ │ Logger   │
 * │ DB       │     │ Manager  │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↓
 *             [check_z0, check_z1_z2, check_z4_diag]
 *
 * @zone scripts/check
 * @dependencies db.js, logger.js, ./lib/*
 */

import { initDb, getConnection, closeDb } from '../../src/shared/db.js';
import { logger } from '../../src/shared/logger.js';
import { SEP } from './lib/utils.js';
import { checkZ0 } from './lib/check_z0.js';
import { checkZ1Z2 } from './lib/check_z1_z2.js';
import { checkZ4Diag } from './lib/check_z4_diag.js';

async function main() {
  try {
    logger.info('\n' + SEP);
    logger.info(' COIN v2 — 데이터 수집 전수조사 (UTC 기준)');
    logger.info(SEP);

    await initDb();
    const conn = await getConnection();
    try {
      const now = new Date();
      logger.info(`\n점검 시각: ${now.toISOString()}\n`);

      await checkZ0(conn);
      await checkZ1Z2(conn);
      await checkZ4Diag(conn);

      logger.info('\n' + SEP);
      logger.info(' 점검 완료');
      logger.info(SEP + '\n');
    } finally {
      if (conn) await conn.close();
      await closeDb();
    }
  } catch (e) {
    logger.error(`FATAL in check_data_status: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => {
  logger.error('FATAL:', e.message);
  process.exit(1);
});
