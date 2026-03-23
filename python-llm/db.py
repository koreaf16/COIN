"""Oracle DB 연결 + z2_llm_analysis 로깅"""
import json
import oracledb
from config import ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING, ORACLE_INSTANT_CLIENT_PATH

_pool = None

def init_db():
    global _pool
    if ORACLE_INSTANT_CLIENT_PATH:
        oracledb.init_oracle_client(lib_dir=ORACLE_INSTANT_CLIENT_PATH)

    def _session_cb(conn, requested_tag):
        cursor = conn.cursor()
        cursor.execute("ALTER SESSION SET TIME_ZONE = 'UTC'")

    _pool = oracledb.create_pool(
        user=ORACLE_USER,
        password=ORACLE_PASSWORD,
        dsn=ORACLE_CONNECT_STRING,
        min=1, max=3, increment=1,
        session_callback=_session_cb,
    )
    print("[DB] Oracle pool created (session TZ=UTC)")

def get_pool():
    return _pool

def _to_json_str(text: str) -> str:
    """JSON 컬럼에 삽입 가능한 문자열 반환. 유효한 JSON이 아니면 객체로 래핑."""
    raw = (text or "")[:4000]
    try:
        json.loads(raw)
        return raw
    except (json.JSONDecodeError, ValueError):
        return json.dumps({"raw": raw})

async def log_llm_call(task_type, symbol, ref_table, prompt_summary, response_text, confidence, inference_ms, tokens_used):
    """z2_llm_analysis INSERT로 LLM 호출 로깅"""
    if not _pool:
        return
    try:
        with _pool.acquire() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO z2_llm_analysis
                       (symbol, ts, analysis_type, llm_source, result, confidence, latency_ms, token_count)
                       VALUES (:sym, SYSTIMESTAMP, :atype, 'system', :result, :conf, :ms, :tokens)""",
                    {
                        "sym": symbol,
                        "atype": task_type,
                        "result": _to_json_str(response_text),
                        "conf": confidence or 0,
                        "ms": inference_ms or 0,
                        "tokens": tokens_used or 0,
                    },
                )
                conn.commit()
    except Exception as e:
        print(f"[DB] LLM log error: {e}")
