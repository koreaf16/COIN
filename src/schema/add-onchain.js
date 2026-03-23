import oracledb from 'oracledb';
import { config } from '../shared/config.js';

if (config.oracle.instantClientPath) {
  oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
}
const conn = await oracledb.getConnection({
  user: config.oracle.user, password: config.oracle.password, connectString: config.oracle.connectString,
});
try { await conn.execute('DROP TABLE z0_onchain PURGE'); } catch(e) {}
await conn.execute(`CREATE TABLE z0_onchain (
  symbol VARCHAR2(20) NOT NULL, ts TIMESTAMP NOT NULL,
  exchange_inflow NUMBER, exchange_outflow NUMBER, net_flow NUMBER,
  exchange_reserve NUMBER, whale_ratio NUMBER, stablecoin_supply NUMBER,
  mpi NUMBER, source VARCHAR2(20) DEFAULT 'cryptoquant',
  CONSTRAINT pk_z0_onchain PRIMARY KEY (symbol, ts))`);
await conn.execute('COMMIT');
console.log('z0_onchain created');
await conn.close();
