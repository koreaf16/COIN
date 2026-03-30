/**
 * +---------------------------------------------------------+
 * | MODULE: truncate-trades.js                               |
 * +---------------------------------------------------------+
 */
import { logger } from "../shared/logger.js";
/** 거래 관련 테이블만 초기화 (z2 플랜 + z3 검증 + z4 거래/성과) */
import oracledb from 'oracledb';
import { config } from '../shared/config.js';

if (config.oracle.instantClientPath) {
  oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
}
const conn = await oracledb.getConnection({
  user: config.oracle.user, password: config.oracle.password, connectString: config.oracle.connectString,
});

const tables = [
  'z3_logic_checks',
  'z4_trade_log',
  'z4_positions',
  'z4_performance',
  'z2_execution_plan',
];

for (const t of tables) {
  try {
    await conn.execute(`TRUNCATE TABLE ${t}`);
    logger.info(`TRUNCATED ${t}`);
  } catch (err) {
    logger.warn(`SKIP ${t}: ${err.message.split('\n')[0]}`);
  }
}

logger.info('\nTrade data cleared (plans + executions + positions + performance).');
await conn.close();
