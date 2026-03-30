"""
@module Query Loader
@description SQL 파일을 로드하고 쿼리별로 분리하여 관리한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ SQL Files│ ──→ │ Query    │ ──→ │ Database │
│ (.sql)   │     │ Loader   │     │ Modules  │
└──────────┘     └──────────┘     └──────────┘

@dependencies os, pathlib
"""
import os
from pathlib import Path
from typing import Dict

# src/schema/queries/python-llm/ 경로 설정
BASE_DIR = Path(__file__).parent.parent
QUERIES_DIR = BASE_DIR / "src" / "schema" / "queries" / "python-llm"

_cache: Dict[str, Dict[str, str]] = {}

def load_queries(name: str) -> Dict[str, str]:
    """
    SQL 파일을 로드하여 쿼리 맵을 반환한다.
    
    Args:
        name (str): SQL 파일명 (확장자 제외, 예: 'db')
        
    Returns:
        Dict[str, str]: 쿼리명(name)과 SQL 문자열의 맵
    """
    if name in _cache:
        return _cache[name]

    file_path = QUERIES_DIR / f"{name}.sql"
    if not file_path.exists():
        # 폴더가 없을 수도 있으므로 생성 시도 (실제 운영 시에는 미리 존재해야 함)
        if not QUERIES_DIR.exists():
            QUERIES_DIR.mkdir(parents=True, exist_ok=True)
        return {}

    content = file_path.read_text(encoding="utf-8")
    queries = {}
    
    # "-- name: queryName" 형식으로 분리
    blocks = [b for b in content.split("-- name: ") if b.strip()]
    
    for block in blocks:
        lines = block.splitlines()
        if not lines:
            continue
        query_name = lines[0].strip()
        query_sql = "\n".join(lines[1:]).strip()
        if query_name:
            queries[query_name] = query_sql

    _cache[name] = queries
    return queries
