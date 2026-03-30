/**
 * +---------------------------------------------------------+
 * | MODULE: truncate-all.js                                  |
 * +---------------------------------------------------------+
 */
import { logger } from "../shared/logger.js";
/** 모든 z0~z4 테이블 데이터 초기화 (테이블 구조 유지) */
import oracledb from 'oracledb';
import { config } from '../shared/config.js';

if (config.oracle.instantClientPath) {
  oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
}
const conn = await oracledb.getConnection({
  user: config.oracle.user, password: config.oracle.password, connectString: config.oracle.connectString,
});

const tables = [
  'z0_price_ohlcv', 'z0_derivatives', 'z0_liquidation_raw', 'z0_macro_data', 'z0_news_raw', 'z0_onchain',
  'z1_market_states', 'z1_liquidation_map', 'z1_volatility_regime', 'z1_oi_matrix',
  'z2_llm_analysis', 'z2_execution_plan',
  'z3_logic_checks',
  'z4_positions', 'z4_trade_log', 'z4_performance',
];

for (const t of tables) {
  try {
    await conn.execute(`TRUNCATE TABLE ${t}`);
    logger.info(`TRUNCATED ${t}`);
  } catch (err) {
    logger.warn(`SKIP ${t}: ${err.message.split('\n')[0]}`);
  }
}

logger.info('\nAll data cleared. Fresh start with UTC timestamps.');
await conn.close();
