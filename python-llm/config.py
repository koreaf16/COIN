"""
@module Config
@description .env.local 파일에서 설정을 로드하고 전역 상수를 정의한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ .env     │ ──→ │ Config   │ ──→ │ Other    │
│ Local    │     │ Loader   │     │ Modules  │
└──────────┘     └──────────┘     └──────────┘

@dependencies pathlib
"""
import logging
from pathlib import Path
from typing import Dict, Any

# 로거 설정
logger = logging.getLogger(__name__)

def load_env() -> Dict[str, str]:
    """.env.local 파일에서 환경 변수를 로드한다."""
    env_path = Path(__file__).parent.parent / ".env.local"
    env = {}
    if env_path.exists():
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                eq = line.find("=")
                if eq == -1:
                    continue
                env[line[:eq].strip()] = line[eq + 1:].strip()
        except Exception as e:
            logger.error(f"[Config] Error reading .env.local: {e}")
    return env


_env = load_env()

# Oracle
ORACLE_USER = _env.get("ORACLE_USER", "")
ORACLE_PASSWORD = _env.get("ORACLE_PASSWORD", "")
ORACLE_CONNECT_STRING = _env.get("ORACLE_CONNECT_STRING", "")
ORACLE_INSTANT_CLIENT_PATH = _env.get("ORACLE_INSTANT_CLIENT_PATH", "")

# Primary local LLM via Ollama/OpenAI-compatible endpoint
LOCAL_LLM_PROVIDER = _env.get("LOCAL_LLM_PROVIDER", "ollama").strip().lower() or "ollama"
LOCAL_LLM_CLI = _env.get("CODEX_CLI_PATH", "codex").strip() or "codex"
LOCAL_LLM_MODEL = _env.get("LOCAL_LLM_MODEL", "unsloth/Qwen3.5-27B-nothink")
LOCAL_LLM_REASONING_EFFORT = _env.get("CODEX_CLI_REASONING_EFFORT", "high")
LOCAL_LLM_TIMEOUT_SEC = int(_env.get("CODEX_CLI_TIMEOUT_SEC", "300"))
LOCAL_LLM_URL = _env.get("LOCAL_LLM_URL", _env.get("OLLAMA_URL", "http://192.168.0.3:11434/v1/chat/completions"))
LOCAL_LLM_API_KEY = _env.get("LOCAL_LLM_API_KEY", "")

# Direct OpenAI API
OPENAI_API_KEY = _env.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = _env.get("OPENAI_BASE_URL", "")
USE_DIRECT_API = _env.get("USE_DIRECT_API", "auto")

# 작업별 reasoning effort 차등 적용
TASK_REASONING_EFFORT = {
    "sentiment": _env.get("REASONING_EFFORT_SENTIMENT", "low"),
    "validate_position": _env.get("REASONING_EFFORT_VALIDATE", "medium"),
    "unified_plan": _env.get("REASONING_EFFORT_UNIFIED", "medium"),
    "briefing": _env.get("REASONING_EFFORT_BRIEFING", "medium"),
    "scenario": _env.get("REASONING_EFFORT_SCENARIO", "medium"),
    "interpret_event": _env.get("REASONING_EFFORT_EVENT", "high"),
}

# Cloud fallback metadata
CLOUD_PROVIDER = _env.get("CLOUD_LLM_PROVIDER", "anthropic")
CLOUD_API_KEY = _env.get("CLOUD_LLM_API_KEY", "")
CLOUD_MODEL = _env.get("CLOUD_LLM_MODEL", "claude-opus-4-20250514-v4.6")
CLOUD_BASE_URL = _env.get("CLOUD_LLM_BASE_URL", "")

# Embeddings
_emb_base = _env.get("LLM_EMBEDDING_URL", "http://localhost:11434/v1").rstrip("/")
if not _emb_base.endswith("/v1"):
    _emb_base = _emb_base + "/v1"
EMBEDDING_URL = _emb_base + "/embeddings"
BGE_MODEL_NAME = _env.get("EMBEDDING_MODEL", "text-embedding-bge-m3")

# LLM Routing
LLM_ROUTING = {
    "sentiment": "local",
    "validate_position": "local",
    "unified_plan": "local",
    "embed": "local",
    "briefing": "local",
    "scenario": "local",
    "interpret_event": "local",
}

# Safety threshold
CONFIDENCE_THRESHOLD = float(_env.get("CONFIDENCE_THRESHOLD", "0.6"))
