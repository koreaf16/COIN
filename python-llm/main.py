"""
COIN v2 LLM Server — 5-Zone 아키텍처 Z2 Intelligence
FastAPI + 하이브리드 LLM (로컬 Qwen + 클라우드 Claude)

엔드포인트:
  POST /api/sentiment         매 5분 센티먼트 (로컬)
  POST /api/briefing          매 1시간 종합 브리핑 (클라우드)
  POST /api/scenario          매 4시간 시나리오 (클라우드)
  POST /api/interpret-event   이벤트 긴급 해석 (클라우드)
  POST /api/validate-position 매 5분 논리 검증 (로컬)
  POST /api/embed             텍스트 임베딩 (로컬 BGE-M3)
"""
import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

from db import init_db, log_llm_call
from embedder import encode, load_model
from llm import generate, parse_json_response
from oracle_reader import init_pool, get_market_snapshot, get_similar_states, get_recent_sentiment, get_recent_briefing, get_all_symbols_snapshot, get_macro_snapshot
from validator import validate_response
from prompts import (
    SYSTEM_PROMPT,
    build_sentiment_prompt,
    build_briefing_prompt,
    build_scenario_prompt,
    build_unified_plan_prompt,
    build_event_interpret_prompt,
    build_validate_position_prompt,
)

local_gpu_lock = asyncio.Lock()   # 로컬 GPU 전용 (Qwen, BGE-M3)
claude_semaphore = asyncio.Semaphore(5)  # Claude CLI 동시 최대 5개


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("=== COIN v2 LLM Server ===")
    init_db()
    init_pool()
    load_model()
    print("[LLM] Ready on port 8000")
    yield
    print("[LLM] Shutting down")


app = FastAPI(title="COIN v2 LLM Server", lifespan=lifespan)


# ── Request Models ──

class SentimentRequest(BaseModel):
    news_items: list[dict] = []

class BriefingRequest(BaseModel):
    symbol: str

class ScenarioRequest(BaseModel):
    symbol: str
    event_calendar: list[dict] | None = None
    fear_greed: dict | None = None
    stablecoin: dict | None = None

class UnifiedPlanRequest(BaseModel):
    symbols: list[str]
    event_calendar: list[dict] | None = None
    fear_greed: dict | None = None
    stablecoin: dict | None = None
    provider: str = "auto"  # "local", "cloud", "auto"

class EventRequest(BaseModel):
    symbol: str
    event_text: str

class ValidateRequest(BaseModel):
    symbol: str
    position_id: int
    entry_reasoning: dict

class EmbedRequest(BaseModel):
    text: str


# ── Endpoints ──

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "v2", "timestamp": time.time()}


@app.post("/api/sentiment")
async def sentiment(req: SentimentRequest):
    """매 5분: 뉴스 센티먼트 분석 (로컬)"""
    prompt = build_sentiment_prompt(req.news_items)
    async with local_gpu_lock:
        text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 300, "sentiment")
    result = parse_json_response(text)
    result.setdefault("sentiment", 0)
    result.setdefault("confidence", 0)

    await log_llm_call("sentiment", None, "z2_llm_analysis",
                       f"{len(req.news_items)} articles", text,
                       result.get("confidence", 0), ms, tokens)
    return result


@app.post("/api/briefing")
async def briefing(req: BriefingRequest):
    """매 1시간: 종합 시장 브리핑 (클라우드)"""
    snapshot = await get_market_snapshot(req.symbol)
    sentiment = await get_recent_sentiment(req.symbol)
    similar = await get_similar_states(req.symbol)

    prompt = build_briefing_prompt(snapshot, sentiment, similar)
    async with claude_semaphore:
        text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 1500, "briefing")
    result = parse_json_response(text)
    result.setdefault("confidence", 0)

    # 크로스체크
    validated = validate_response(result, snapshot, "briefing")
    result["_warnings"] = validated["warnings"]

    await log_llm_call("briefing", req.symbol, "z2_llm_analysis",
                       f"briefing {req.symbol}", text,
                       result.get("confidence", 0), ms, tokens)
    return result


@app.post("/api/scenario")
async def scenario(req: ScenarioRequest):
    """매 4시간: 시나리오 + 진입 조건 세팅 (클라우드)"""
    snapshot = await get_market_snapshot(req.symbol)
    similar = await get_similar_states(req.symbol)

    # 최신 브리핑 가져오기
    briefing_data = await get_recent_briefing(req.symbol) or {}

    prompt = build_scenario_prompt(snapshot, briefing_data or {}, similar, req.event_calendar,
                                  req.fear_greed, req.stablecoin)
    async with claude_semaphore:
        text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 2000, "scenario")
    result = parse_json_response(text)
    result.setdefault("confidence", 0)

    validated = validate_response(result, snapshot, "scenario")
    result["_warnings"] = validated["warnings"]
    result["_valid"] = validated["valid"]

    await log_llm_call("scenario", req.symbol, "z2_execution_plan",
                       f"scenario {req.symbol}", text,
                       result.get("confidence", 0), ms, tokens)
    return result


@app.post("/api/unified-plan")
async def unified_plan(req: UnifiedPlanRequest):
    """매 1분: 전체 심볼 통합 분석 → 최적 플랜 생성"""
    all_snapshots = await get_all_symbols_snapshot(req.symbols)
    macro = await get_macro_snapshot()

    prompt = build_unified_plan_prompt(
        all_snapshots, macro, req.event_calendar, req.fear_greed, req.stablecoin
    )

    # provider 선택: local(Qwen) 또는 cloud(Claude)
    route = req.provider
    if route == "auto":
        route = "local"  # 1분 주기 기본은 로컬 (빠름)

    if route == "local":
        async with local_gpu_lock:
            text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 3000, "local")
    else:
        async with claude_semaphore:
            text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 3000, "briefing")

    result = parse_json_response(text)
    result.setdefault("confidence", 0)
    result.setdefault("plans", [])

    await log_llm_call("unified_plan", None, "z2_execution_plan",
                       f"unified {len(req.symbols)} symbols", text,
                       result.get("confidence", 0), ms, tokens)

    print(f"[LLM] Unified plan: {len(result.get('plans', []))} plans in {ms}ms ({route})")
    return result


@app.post("/api/interpret-event")
async def interpret_event(req: EventRequest):
    """이벤트 발생 시: 3-5초 긴급 해석 (클라우드)"""
    snapshot = await get_market_snapshot(req.symbol)
    prompt = build_event_interpret_prompt(req.event_text, snapshot)

    async with claude_semaphore:
        text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 800, "interpret_event")
    result = parse_json_response(text)
    result.setdefault("confidence", 0)

    await log_llm_call("event_interpret", req.symbol, "z2_execution_plan",
                       req.event_text[:200], text,
                       result.get("confidence", 0), ms, tokens)
    return result


@app.post("/api/validate-position")
async def validate_position(req: ValidateRequest):
    """매 5분: 포지션 논리 검증 (로컬)"""
    snapshot = await get_market_snapshot(req.symbol)
    prompt = build_validate_position_prompt(req.entry_reasoning, snapshot)

    async with local_gpu_lock:
        text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 800, "validate_position")
    result = parse_json_response(text)
    result.setdefault("recommendation", "HOLD")
    result.setdefault("confidence", 0)

    await log_llm_call("validate_position", req.symbol, "z3_logic_checks",
                       f"position {req.position_id}", text,
                       result.get("confidence", 0), ms, tokens)
    return result


@app.post("/api/embed")
async def embed_text(req: EmbedRequest):
    """텍스트 임베딩 (BGE-M3)"""
    async with local_gpu_lock:
        vector = encode(req.text)
    return {"vector": vector, "dimensions": len(vector)}


# ── LLM 테스트 엔드포인트 ──

class TestRequest(BaseModel):
    prompt: str = "Say hello and tell me what model you are."
    provider: str = "auto"  # 'local', 'claude_cli', 'auto'

@app.post("/api/test-llm")
async def test_llm(req: TestRequest):
    """LLM 개별 테스트"""
    from llm import _generate_local, _generate_cli, _claude_cli, _gemini_cli

    system = "You are a helpful assistant. Respond concisely in 1-2 sentences."
    result = {"provider": req.provider, "prompt": req.prompt}

    try:
        if req.provider == "local":
            text, ms, tokens = await _generate_local(req.prompt, system, 200)
            result.update({"response": text, "latency_ms": ms, "tokens": tokens, "status": "ok" if text else "error"})

        elif req.provider == "claude_cli":
            if not _claude_cli:
                result.update({"status": "not_found", "response": "claude CLI not installed"})
            else:
                text, ms, tokens = await _generate_cli("claude", req.prompt, system)
                result.update({"response": text, "latency_ms": ms, "tokens": tokens, "status": "ok" if text else "error"})

        elif req.provider == "gemini_cli":
            if not _gemini_cli:
                result.update({"status": "not_found", "response": "gemini CLI not installed"})
            else:
                text, ms, tokens = await _generate_cli("gemini", req.prompt, system)
                result.update({"response": text, "latency_ms": ms, "tokens": tokens, "status": "ok" if text else "error"})

        else:
            text, ms, tokens = await generate(req.prompt, system, 200, "briefing")
            result.update({"response": text, "latency_ms": ms, "tokens": tokens, "status": "ok" if text else "error"})

    except Exception as e:
        result.update({"status": "error", "response": str(e), "latency_ms": 0})

    return result


@app.get("/api/llm-status")
async def llm_status():
    """LLM 프로바이더 상태 조회"""
    from llm import _claude_cli, _gemini_cli
    from config import OLLAMA_URL, LLM_MODEL, LLM_ROUTING

    return {
        "local": {
            "available": True,
            "model": LLM_MODEL,
            "url": OLLAMA_URL,
        },
        "claude_cli": {
            "available": bool(_claude_cli),
            "path": _claude_cli or "not found",
            "model": "Claude Opus 4.6",
        },
        "gemini_cli": {
            "available": bool(_gemini_cli),
            "path": _gemini_cli or "not found",
            "model": "Gemini 3.1 Pro Preview",
        },
        "routing": LLM_ROUTING,
    }
