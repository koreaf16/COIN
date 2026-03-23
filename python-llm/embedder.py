"""BGE-M3 임베딩 — Ollama /v1/embeddings API"""
import httpx
from config import EMBEDDING_URL, BGE_MODEL_NAME

def load_model():
    """Ollama 방식은 별도 로드 불필요 — 연결 확인만"""
    resp = httpx.get(EMBEDDING_URL.replace("/embeddings", "/models"), timeout=5)
    resp.raise_for_status()
    print(f"[BGE-M3] Ollama embedding endpoint ready: {EMBEDDING_URL} (model={BGE_MODEL_NAME})")

def encode(text: str) -> list[float]:
    """텍스트 → 벡터 (Ollama /v1/embeddings 호출)"""
    resp = httpx.post(EMBEDDING_URL, json={"model": BGE_MODEL_NAME, "input": text}, timeout=30)
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]
