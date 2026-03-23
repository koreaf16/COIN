import oracledb from 'oracledb';
import { config } from '../shared/config.js';

if (config.oracle.instantClientPath) {
  oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
}
const conn = await oracledb.getConnection({
  user: config.oracle.user, password: config.oracle.password, connectString: config.oracle.connectString,
});

const tables = [
  `CREATE TABLE z0_economic_calendar (
    id             NUMBER GENERATED ALWAYS AS IDENTITY,
    event_date     TIMESTAMP     NOT NULL,
    event_name     VARCHAR2(200) NOT NULL,
    country        VARCHAR2(10)  DEFAULT 'US',
    importance     VARCHAR2(10),
    previous       VARCHAR2(50),
    forecast       VARCHAR2(50),
    actual         VARCHAR2(50),
    source         VARCHAR2(30)  DEFAULT 'investing',
    fetched_at     TIMESTAMP     DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_z0_econ_cal PRIMARY KEY (id)
  )`,
  `CREATE INDEX idx_z0_econ_date ON z0_economic_calendar (event_date)`,

  `CREATE TABLE z0_fear_greed (
    ts             TIMESTAMP     NOT NULL,
    value          NUMBER        NOT NULL,
    classification VARCHAR2(30),
    CONSTRAINT pk_z0_fg PRIMARY KEY (ts)
  )`,

  `CREATE TABLE z0_stablecoin_supply (
    ts             TIMESTAMP     NOT NULL,
    usdt_mcap      NUMBER,
    usdc_mcap      NUMBER,
    total_mcap     NUMBER,
    usdt_change_24h NUMBER,
    usdc_change_24h NUMBER,
    CONSTRAINT pk_z0_stable PRIMARY KEY (ts)
  )`,
];

for (const sql of tables) {
  try {
    await conn.execute(sql);
    const match = sql.match(/(?:TABLE|INDEX)\s+(\S+)/i);
    console.log(`Created ${match?.[1] || '?'}`);
  } catch (err) {
    if (err.message.includes('ORA-00955')) {
      console.log(`Already exists: ${sql.substring(0, 50)}...`);
    } else {
      console.error(`Error: ${err.message.split('\n')[0]}`);
    }
  }
}

await conn.close();
console.log('Done');
