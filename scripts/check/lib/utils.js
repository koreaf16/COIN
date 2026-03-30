import oracledb from 'oracledb';

export const SEP = '─'.repeat(70);

export async function query(conn, sql, binds = {}) {
  try {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}
