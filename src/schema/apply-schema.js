/**
 * v2 스키마 적용 스크립트 — Oracle에 새 테이블 생성
 * 실행: node src/schema/apply-schema.js
 */
import oracledb from 'oracledb';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../shared/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  if (config.oracle.instantClientPath) {
    oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
  }

  const conn = await oracledb.getConnection({
    user: config.oracle.user,
    password: config.oracle.password,
    connectString: config.oracle.connectString,
  });

  console.log('[Schema] Connected to Oracle');

  // 1. 기존 TB_* 테이블 DROP
  console.log('[Schema] Dropping old TB_* tables...');
  const oldTables = await conn.execute(
    "SELECT table_name FROM user_tables WHERE table_name LIKE 'TB_%' ORDER BY table_name"
  );
  for (const row of (oldTables.rows || [])) {
    const tableName = row[0];
    try {
      await conn.execute(`DROP TABLE ${tableName} CASCADE CONSTRAINTS PURGE`);
      console.log(`  DROP ${tableName}`);
    } catch (err) {
      console.warn(`  DROP ${tableName} failed: ${err.message}`);
    }
  }

  // 2. 기존 z*_ 테이블 DROP (재실행 대비)
  console.log('[Schema] Dropping existing z*_ tables...');
  const zTables = await conn.execute(
    "SELECT table_name FROM user_tables WHERE table_name LIKE 'Z%\\_%' ESCAPE '\\' OR table_name = 'SYS_CONFIG' ORDER BY table_name"
  );
  for (const row of (zTables.rows || [])) {
    const tableName = row[0];
    try {
      await conn.execute(`DROP TABLE ${tableName} CASCADE CONSTRAINTS PURGE`);
      console.log(`  DROP ${tableName}`);
    } catch (err) {
      console.warn(`  DROP ${tableName} failed: ${err.message}`);
    }
  }

  // 3. 기존 트리거/프로시저/함수 DROP
  console.log('[Schema] Dropping old triggers/procedures...');
  for (const type of ['TRIGGER', 'PROCEDURE', 'FUNCTION']) {
    const objs = await conn.execute(
      `SELECT object_name FROM user_objects WHERE object_type = :t AND (object_name LIKE 'TRG_%' OR object_name LIKE 'SP_%' OR object_name LIKE 'FN_%')`,
      { t: type }
    );
    for (const row of (objs.rows || [])) {
      try {
        await conn.execute(`DROP ${type} ${row[0]}`);
        console.log(`  DROP ${type} ${row[0]}`);
      } catch (_) {}
    }
  }

  // 4. v2-tables.sql에서 DDL 문 실행
  console.log('[Schema] Creating v2 tables...');
  const sqlFile = readFileSync(resolve(__dirname, 'v2-tables.sql'), 'utf-8');
  const statements = parseSqlStatements(sqlFile);

  for (const stmt of statements) {
    try {
      await conn.execute(stmt);
      // 테이블 생성문에서 테이블 이름 추출
      const match = stmt.match(/CREATE\s+(?:TABLE|INDEX|VECTOR\s+INDEX)\s+(\S+)/i);
      if (match) console.log(`  CREATE ${match[1]}`);
      else if (stmt.trim().startsWith('INSERT')) console.log(`  INSERT config`);
    } catch (err) {
      console.error(`  ERROR: ${err.message.split('\n')[0]}`);
      console.error(`  SQL: ${stmt.substring(0, 80)}...`);
    }
  }
  await conn.execute('COMMIT');

  // 5. v2-plsql.sql에서 PL/SQL 블록 실행
  console.log('[Schema] Creating PL/SQL triggers/procedures...');
  const plsqlFile = readFileSync(resolve(__dirname, 'v2-plsql.sql'), 'utf-8');
  const plsqlBlocks = parsePlsqlBlocks(plsqlFile);

  for (const block of plsqlBlocks) {
    try {
      await conn.execute(block);
      const match = block.match(/(?:TRIGGER|PROCEDURE|FUNCTION)\s+(\S+)/i);
      if (match) console.log(`  CREATE ${match[1]}`);
    } catch (err) {
      console.error(`  PL/SQL ERROR: ${err.message.split('\n')[0]}`);
      console.error(`  Block: ${block.substring(0, 80)}...`);
    }
  }

  // 6. 검증
  console.log('\n[Schema] Verification:');
  const tables = await conn.execute(
    "SELECT table_name FROM user_tables WHERE table_name LIKE 'Z%\\_%' ESCAPE '\\' OR table_name = 'SYS_CONFIG' ORDER BY table_name"
  );
  console.log(`  Tables created: ${tables.rows.length}`);
  for (const row of tables.rows) {
    console.log(`    ${row[0]}`);
  }

  await conn.close();
  console.log('\n[Schema] Done!');
}

function parseSqlStatements(sql) {
  // PL/SQL anonymous blocks (BEGIN...END;/) 제거 — 별도 처리
  const cleaned = sql.replace(/BEGIN[\s\S]*?END;\s*\//g, '');
  // 주석 줄 제거
  const lines = cleaned.split('\n').filter(l => !l.trim().startsWith('--'));
  const text = lines.join('\n');
  // 세미콜론으로 분할
  return text.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
}

function parsePlsqlBlocks(sql) {
  // "/" 구분자로 분할 (PL/SQL 블록 끝)
  return sql.split('\n/\n')
    .map(s => s.trim())
    .filter(s => s.length > 10 && (
      s.includes('CREATE OR REPLACE') ||
      s.includes('BEGIN') ||
      s.includes('DECLARE')
    ));
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
