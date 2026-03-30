"""
@module App Utilities
@description FastAPI 애플리케이션의 라이프사이클 관리 및 로깅 필터를 제공한다.

@dependencies fastapi, logging, db, oracle_reader, embedder
"""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from db import init_db
from oracle_reader import init_pool
from embedder import load_model

class FilterHealthPolling(logging.Filter):
    """헬스 체크 및 활성 호출 확인 엔드포인트의 로그를 필터링한다."""
    _quiet_paths = ("/api/llm-active", "/api/health")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(path in msg for path in self._quiet_paths)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """애플리케이션 시작 및 종료 시 필요한 리소스를 관리한다."""
    logging.info("=== COIN v2 LLM Server ===")
    init_db()
    init_pool()
    load_model()
    logging.info("[LLM] Ready on port 2002")
    yield
    logging.info("[LLM] Shutting down")

def setup_logging():
    """Uvicorn 액세스 로그에 필터를 적용한다."""
    logging.getLogger("uvicorn.access").addFilter(FilterHealthPolling())
