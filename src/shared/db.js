import oracledb from 'oracledb';
import { config } from './config.js';

let pool = null;

/* Oracle LOB → 문자열 자동 변환 (JSON/CLOB 컬럼이 스트림 객체로 반환되는 문제 방지) */
oracledb.fetchAsString = [oracledb.CLOB];

/**
 * 타임존 정책:
 *   - DB 저장: 모두 UTC
 *   - Oracle 세션: 매 커넥션마다 UTC 강제
 *   - SYSTIMESTAMP: 세션 TZ에 따라 반환 → UTC
 *   - UI 표시: UTC → ET 변환 (dashboard에서 처리)
 *
 * 핵심: getPool().getConnection() 대신 getConnection()을 사용할 것
 */
export async function initDb() {
  if (config.oracle.instantClientPath) {
    oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
  }

  pool = await oracledb.createPool({
    user: config.oracle.user,
    password: config.oracle.password,
    connectString: config.oracle.connectString,
    poolMin: 2,
    poolMax: 10,
    poolIncrement: 1,
  });

  // 연결 테스트 + 타임존 확인
  const conn = await getConnection();
  const result = await conn.execute("SELECT SYSTIMESTAMP, SESSIONTIMEZONE FROM DUAL");
  const [sysTs, sessionTz] = result.rows[0];
  await conn.close();
  console.log(`[DB] Oracle 연결 성공 (session TZ: ${sessionTz})`);
  return pool;
}

/** 풀에서 UTC 설정된 커넥션 반환 — 모든 DB 접근은 이것을 사용 */
export async function getConnection() {
  if (!pool) throw new Error('DB pool not initialized');
  const conn = await pool.getConnection();
  await conn.execute("ALTER SESSION SET TIME_ZONE = 'UTC'");
  return conn;
}

/** 하위 호환: 기존 getPool().getConnection() 패턴을 위한 래퍼 */
export function getPool() {
  if (!pool) throw new Error('DB pool not initialized');
  // pool 객체를 래핑하여 getConnection()에서 자동 UTC 설정
  return {
    async getConnection() {
      const conn = await pool.getConnection();
      await conn.execute("ALTER SESSION SET TIME_ZONE = 'UTC'");
      return conn;
    },
  };
}

export async function closeDb() {
  if (pool) {
    await pool.close(0);
    pool = null;
    console.log('[DB] Oracle pool closed');
  }
}
