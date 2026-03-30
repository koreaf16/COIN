"""
@module Embedder
@description BGE-M3 모델을 사용하여 텍스트 임베딩을 생성한다. Ollama API를 경유한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Text     │ ──→ │ Embedder │ ──→ │ Vector   │
│ Data     │     │ (Ollama) │     │ (List)   │
└──────────┘     └──────────┘     └──────────┘

@dependencies config.py, httpx
"""
import logging
from typing import List
import httpx
from config import EMBEDDING_URL, BGE_MODEL_NAME

# 로거 설정
logger = logging.getLogger(__name__)

def load_model() -> None:
    """Ollama 방식은 별도 로드 불필요 — 연결 확인만 수행한다."""
    try:
        # /embeddings -> /models 로 변경하여 모델 존재 여부 확인 (Ollama API 기준)
        models_url = EMBEDDING_URL.replace("/embeddings", "/models")
        if "/v1" in models_url:
            # v1 API의 경우 models 엔드포인트가 다를 수 있음
            models_url = models_url.replace("/v1", "")
            
        resp = httpx.get(models_url, timeout=5)
        if resp.status_code == 200:
            logger.info(f"[BGE-M3] Ollama embedding endpoint ready: {EMBEDDING_URL} (model={BGE_MODEL_NAME})")
        else:
            logger.warning(f"[BGE-M3] Ollama models check returned status: {resp.status_code}")
    except Exception as e:
        logger.warning(f"[BGE-M3] Warning: Ollama embedding endpoint check failed: {e}")
        logger.warning(f"         (URL: {EMBEDDING_URL}, Model: {BGE_MODEL_NAME})")

def encode(text: str) -> List[float]:
    """텍스트를 벡터로 변환한다 (Ollama /v1/embeddings 호출)."""
    try:
        resp = httpx.post(
            EMBEDDING_URL, 
            json={"model": BGE_MODEL_NAME, "input": text}, 
            timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        return data["data"][0]["embedding"]
    except Exception as e:
        logger.error(f"[BGE-M3] Embedding failed for text length {len(text)}: {e}")
        raise
