"""설정 로더 — .env.local에서 읽기 (v2: 하이브리드 LLM)"""
import os
from pathlib import Path


def load_env():
    env_path = Path(__file__).parent.parent / ".env.local"
    env = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq == -1:
                continue
            env[line[:eq].strip()] = line[eq + 1:].strip()
    return env


_env = load_env()

# Oracle
ORACLE_USER = _env.get("ORACLE_USER", "")
ORACLE_PASSWORD = _env.get("ORACLE_PASSWORD", "")
ORACLE_CONNECT_STRING = _env.get("ORACLE_CONNECT_STRING", "")
ORACLE_INSTANT_CLIENT_PATH = _env.get("ORACLE_INSTANT_CLIENT_PATH", "")

# ── DeepSeek API (메인 분석 엔진) ──
_ds_base = _env.get("VLLM_URL", "https://api.deepseek.com").rstrip("/")
if _ds_base.endswith("/v1"):
    _ds_base = _ds_base[:-3]
DEEPSEEK_URL = _ds_base + "/v1/chat/completions"
DEEPSEEK_MODEL = _env.get("VLLM_MODEL", "deepseek-chat")
DEEPSEEK_API_KEY = _env.get("VLLM_API_KEY", "")

# ── Qwen 3.5 27B (폴백용) ──
_qwen_base = _env.get("QWEN_URL", "http://192.168.0.3:1234/v1").rstrip("/")
if not _qwen_base.endswith("/v1"):
    _qwen_base = _qwen_base + "/v1"
QWEN_URL = _qwen_base + "/chat/completions"
QWEN_MODEL = _env.get("QWEN_MODEL", "qwen3.5:27b")

# ── Cloud LLM ──
CLOUD_PROVIDER = _env.get("CLOUD_LLM_PROVIDER", "anthropic")  # 'anthropic' or 'openai'
CLOUD_API_KEY = _env.get("CLOUD_LLM_API_KEY", "")
CLOUD_MODEL = _env.get("CLOUD_LLM_MODEL", "claude-opus-4-20250514-v4.6")
CLOUD_BASE_URL = _env.get("CLOUD_LLM_BASE_URL", "")

# ── BGE-M3 Embedding ──
_emb_base = _env.get("LLM_EMBEDDING_URL", "http://localhost:11434/v1").rstrip("/")
if not _emb_base.endswith("/v1"):
    _emb_base = _emb_base + "/v1"
EMBEDDING_URL = _emb_base + "/embeddings"
BGE_MODEL_NAME = _env.get("EMBEDDING_MODEL", "text-embedding-bge-m3")

# ── LLM 라우팅 규칙 ──
# DeepSeek: 모든 분석 작업 (통합 플랜, 센티먼트, 검증)
# Cloud: 중요 판단 (브리핑, 시나리오, 이벤트 해석)
LLM_ROUTING = {
    "sentiment": "deepseek",
    "validate_position": "deepseek",
    "embed": "local",
    "briefing": "cloud",
    "scenario": "cloud",
    "interpret_event": "cloud",
}

# ── 안전장치 ──
CONFIDENCE_THRESHOLD = float(_env.get("CONFIDENCE_THRESHOLD", "0.6"))
