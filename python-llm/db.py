"""
@module Oracle DB
@description Oracle DB 연결을 관리하고 LLM 분석 결과를 로깅한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Python   │ ──→ │ oracledb │ ──→ │ Oracle   │
│ Services │     │ Pool     │     │ DB       │
└──────────┘     └──────────┘     └──────────┘
                      ↓
               z2_llm_analysis
               (LLM 호출 로그 저장)

@dependencies config.py, query_loader.py, oracledb
"""
import json
import logging
from typing import Optional, Any
import oracledb
from config import ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING, ORACLE_INSTANT_CLIENT_PATH
from query_loader import load_queries

# 로거 설정
logger = logging.getLogger(__name__)

_pool: Optional[oracledb.ConnectionPool] = None
_queries = load_queries("db")
MAX_RESULT_CHARS = 32767

def init_db() -> None:
    """Oracle 연결 풀을 초기화한다."""
    global _pool
    try:
        if ORACLE_INSTANT_CLIENT_PATH:
            oracledb.init_oracle_client(lib_dir=ORACLE_INSTANT_CLIENT_PATH)

        def _session_cb(conn: Any, requested_tag: Any) -> None:
            cursor = conn.cursor()
            cursor.execute("ALTER SESSION SET TIME_ZONE = 'UTC'")

        _pool = oracledb.create_pool(
            user=ORACLE_USER,
            password=ORACLE_PASSWORD,
            dsn=ORACLE_CONNECT_STRING,
            min=1, max=3, increment=1,
            session_callback=_session_cb,
        )
        logger.info("[DB] Oracle pool created (session TZ=UTC)")
    except Exception as e:
        logger.error(f"[DB] Failed to initialize Oracle pool: {e}")

def get_pool() -> Optional[oracledb.ConnectionPool]:
    """현재 활성화된 연결 풀을 반환한다."""
    return _pool

def _to_json_str(text: str) -> str:
    """JSON 컬럼에 삽입 가능한 문자열 반환. 유효한 JSON이 아니면 객체로 래핑."""
    raw = text or ""
    try:
        json.loads(raw)
        candidate = raw
    except (json.JSONDecodeError, ValueError):
        candidate = json.dumps({"truncated": False, "raw": raw}, ensure_ascii=False, separators=(",", ":"))

    if len(candidate) <= MAX_RESULT_CHARS:
        return candidate

    logger.warning(f"[DB] LLM result exceeds {MAX_RESULT_CHARS} chars; storing truncated JSON payload")
    wrapped = {"truncated": True, "raw": ""}
    low, high = 0, len(raw)
    best = json.dumps(wrapped, ensure_ascii=False, separators=(",", ":"))
    while low <= high:
        mid = (low + high) // 2
        wrapped["raw"] = raw[:mid]
        candidate = json.dumps(wrapped, ensure_ascii=False, separators=(",", ":"))
        if len(candidate) <= MAX_RESULT_CHARS:
            best = candidate
            low = mid + 1
        else:
            high = mid - 1
    return best

async def log_llm_call(
    task_type: str,
    symbol: str,
    ref_table: str,
    prompt_summary: str,
    response_text: str,
    confidence: Optional[float],
    inference_ms: Optional[int],
    tokens_used: Optional[int]
) -> None:
    """z2_llm_analysis 테이블에 LLM 호출 정보를 기록한다."""
    if not _pool:
        return
    
    query = _queries.get("insertLlmAnalysis")
    if not query:
        logger.error("[DB] Query 'insertLlmAnalysis' not found")
        return

    try:
        with _pool.acquire() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    query,
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
        logger.error(f"[DB] LLM log error: {e}")
