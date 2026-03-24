"""
COIN v2 LLM Server — 5-Zone 아키텍처 Z2 Intelligence
FastAPI + 하이브리드 LLM (DeepSeek + Qwen + Claude)

엔드포인트:
  POST /api/sentiment         매 5분 센티먼트 (DeepSeek)
  POST /api/briefing          매 1시간 종합 브리핑 (Cloud)
  POST /api/scenario          매 4시간 시나리오 (Cloud)
  POST /api/interpret-event   이벤트 긴급 해석 (Cloud)
  POST /api/validate-position 매 5분 논리 검증 (DeepSeek)
  POST /api/unified-plan      매 1분 통합 플랜 (DeepSeek)
  POST /api/embed             텍스트 임베딩 (BGE-M3)
"""
import asyncio
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI


class FilterHealthPolling(logging.Filter):
    """대시보드 폴링 엔드포인트의 access log를 숨긴다."""
    _quiet_paths = ("/api/llm-active", "/api/health")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(p in msg for p in self._quiet_paths)


logging.getLogger("uvicorn.access").addFilter(FilterHealthPolling())
from pydantic import BaseModel

from db import init_db, log_llm_call
from embedder import encode, load_model
from llm import generate, parse_json_response
from oracle_reader import (
    init_pool, get_market_snapshot, get_similar_states, get_recent_sentiment,
    get_recent_briefing, get_all_symbols_snapshot, get_macro_snapshot, get_recent_losses
)
from validator import validate_response
from prompts import (
    SYSTEM_PROMPT,
    DEEPSEEK_UNIFIED_PLAN_SYSTEM,
    SENTIMENT_SYSTEM,
    VALIDATE_SYSTEM,
    build_sentiment_prompt,
    build_briefing_prompt,
    build_scenario_prompt,
    build_unified_plan_prompt,
    build_event_interpret_prompt,
    build_validate_position_prompt,
)

qwen_sem = asyncio.Semaphore(4)       # Qwen 3.5 27B (Ollama) 동시 최대 4개
deepseek_sem = asyncio.Semaphore(8)   # DeepSeek API 동시 최대 8개
bge_sem = asyncio.Semaphore(4)        # BGE-M3 임베딩 동시 최대 4개
claude_semaphore = asyncio.Semaphore(5)  # Claude/Gemini CLI 동시 최대 5개


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("=== COIN v2 LLM Server ===")
    init_db()
    init_pool()
    load_model()
    print("[LLM] Ready on port 2002")
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
    provider: str = "auto"  # "deepseek", "cloud", "auto"

class EventRequest(BaseModel):
    symbol: str
    event_text: str

class ValidatePositionRequest(BaseModel):
    symbol: str
    entry_reasoning: dict = {}

class EmbedRequest(BaseModel):
    text: str


# ── Endpoints ──

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "v2", "timestamp": time.time()}


@app.get("/api/llm-active")
async def llm_active():
    """현재 활성 LLM 호출 상태 — 대시보드 실시간 스트리밍 표시용"""
    from llm import get_active_calls, _active_calls
    calls = get_active_calls()
    return {"calls": calls, "total": len(_active_calls)}


@app.post("/api/sentiment")
async def sentiment(req: SentimentRequest):
    """매 5분: 뉴스 센티먼트 분석 (DeepSeek)"""
    prompt = build_sentiment_prompt(req.news_items)
    async with deepseek_sem:
        text, ms, tokens = await generate(prompt, SENTIMENT_SYSTEM, 300, "sentiment")
    result = parse_json_response(text)
    result.setdefault("sentiment", 0)
    result.setdefault("confidence", 0)

    # Note: logged by JS (z2-intel/scheduler.js) to avoid duplicate entries
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

    # Note: logged by JS (z2-intel/scheduler.js)
    return result


@app.post("/api/scenario")
async def scenario(req: ScenarioRequest):
    """매 4시간: 시나리오 + 진입 조건 세팅 (클라우드)"""
    snapshot = await get_market_snapshot(req.symbol)
    similar = await get_similar_states(req.symbol)
    recent_losses = await get_recent_losses(req.symbol)

    # 최신 브리핑 가져오기
    briefing_data = await get_recent_briefing(req.symbol) or {}

    prompt = build_scenario_prompt(snapshot, briefing_data or {}, similar, req.event_calendar,
                                  req.fear_greed, req.stablecoin, recent_losses)
    async with claude_semaphore:
        text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, 2000, "scenario")
    result = parse_json_response(text)
    result.setdefault("confidence", 0)

    validated = validate_response(result, snapshot, "scenario")
    result["_warnings"] = validated["warnings"]
    result["_valid"] = validated["valid"]

    # Note: logged by JS (z2-intel/scheduler.js)
    return result


@app.post("/api/unified-plan")
async def unified_plan(req: UnifiedPlanRequest):
    """매 1분: 전체 심볼 통합 분석 → 최적 플랜 생성"""
    all_snapshots = await get_all_symbols_snapshot(req.symbols)
    macro = await get_macro_snapshot()

    # 각 심볼별 최근 손실 사례 수집
    recent_losses = {}
    for sym in req.symbols:
        losses = await get_recent_losses(sym, limit=2)
        if losses:
            recent_losses[sym] = losses

    prompt = build_unified_plan_prompt(
        all_snapshots, macro, req.event_calendar, req.fear_greed, req.stablecoin, recent_losses
    )


    # provider 선택: deepseek(기본) 또는 cloud(Claude)
    route = req.provider
    if route == "auto":
        route = "deepseek"  # 1분 주기 기본은 DeepSeek (빠름)

    # 심볼 1개 기준: 구조 ~150 + reasoning 100자 = ~250토큰
    sym_count = len(all_snapshots)
    max_tok_deepseek = 150 + sym_count * 250
    max_tok_cloud = 150 + sym_count * 300

    if route == "cloud":
        async with claude_semaphore:
            text, ms, tokens = await generate(prompt, SYSTEM_PROMPT, max_tok_cloud, "unified_plan_cloud")
    else:
        async with deepseek_sem:
            text, ms, tokens = await generate(prompt, DEEPSEEK_UNIFIED_PLAN_SYSTEM, max_tok_deepseek, "unified_plan")

    result = parse_json_response(text)
    result.setdefault("confidence", 0)
    result.setdefault("plans", [])

    # Note: logged by JS (z2-intel/scheduler.js)
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

    # Note: logged by JS (z2-intel/event-monitor.js)
    return result


@app.post("/api/validate-position")
async def validate_position(req: ValidatePositionRequest):
    """스윙 포지션 논리 검증 (10분 주기, DeepSeek)"""
    snapshot = await get_market_snapshot(req.symbol)
    prompt = build_validate_position_prompt(req.entry_reasoning, snapshot)
    async with deepseek_sem:
        text, ms, tokens = await generate(prompt, VALIDATE_SYSTEM, 500, "validate_position")
    result = parse_json_response(text)
    result.setdefault("recommendation", "HOLD")
    result.setdefault("confidence", 0)
    print(f"[LLM] Validate {req.symbol}: {result.get('recommendation')} (conf={result.get('confidence')}, {ms}ms)")
    return result

@app.post("/api/embed")
async def embed_text(req: EmbedRequest):
    """텍스트 임베딩 (BGE-M3)"""
    async with bge_sem:
        vector = encode(req.text)
    return {"vector": vector, "dimensions": len(vector)}


# ── LLM 테스트 엔드포인트 ──

class TestRequest(BaseModel):
    prompt: str = "Say hello and tell me what model you are."
    provider: str = "auto"  # 'qwen', 'deepseek', 'claude_cli', 'gemini_cli', 'auto'

@app.post("/api/test-llm")
async def test_llm(req: TestRequest):
    """LLM 개별 테스트"""
    from llm import _generate_qwen, _generate_deepseek, _generate_cli, _claude_cli, _gemini_cli

    system = "You are a helpful assistant. Respond concisely in 1-2 sentences."
    result = {"provider": req.provider, "prompt": req.prompt}

    try:
        if req.provider == "qwen":
            text, ms, tokens = await _generate_qwen(req.prompt, system, 200)
        elif req.provider == "deepseek":
            text, ms, tokens = await _generate_deepseek(req.prompt, system, 200)
        elif req.provider == "claude_cli":
            if not _claude_cli:
                result.update({"status": "not_found", "response": "claude CLI not installed"})
                return result
            text, ms, tokens = await _generate_cli("claude", req.prompt, system)
        elif req.provider == "gemini_cli":
            if not _gemini_cli:
                result.update({"status": "not_found", "response": "gemini CLI not installed"})
                return result
            text, ms, tokens = await _generate_cli("gemini", req.prompt, system)
        else:
            text, ms, tokens = await generate(req.prompt, system, 200, "briefing")

        # _generate_api가 에러 시 (None, ms, 0) 반환 → active_calls에서 에러 메시지 추출
        if text is None:
            from llm import _active_calls
            err_detail = "응답 없음 (서버 로그 확인)"
            for call in list(_active_calls.values()):
                if call.get("task_type") == req.provider and "[ERROR]" in call.get("output", ""):
                    err_detail = call["output"]
                    break
            result.update({"response": err_detail, "latency_ms": ms, "tokens": 0, "status": "error"})
        else:
            result.update({"response": text, "latency_ms": ms, "tokens": tokens, "status": "ok"})

    except Exception as e:
        import traceback
        traceback.print_exc()
        result.update({"status": "error", "response": str(e), "latency_ms": 0})

    return result


@app.get("/api/llm-status")
async def llm_status():
    """LLM 프로바이더 상태 조회"""
    from llm import _claude_cli, _gemini_cli
    from config import DEEPSEEK_URL, DEEPSEEK_MODEL, DEEPSEEK_API_KEY, QWEN_URL, QWEN_MODEL, LLM_ROUTING

    return {
        "qwen": {
            "available": True,
            "model": QWEN_MODEL,
            "url": QWEN_URL,
            "role": "센티먼트, 검증",
        },
        "deepseek": {
            "available": bool(DEEPSEEK_API_KEY),
            "model": DEEPSEEK_MODEL,
            "url": DEEPSEEK_URL,
            "has_key": bool(DEEPSEEK_API_KEY),
            "role": "unified_plan 전용",
        },
        "claude_cli": {
            "available": bool(_claude_cli),
            "path": _claude_cli or "not found",
            "model": "Claude Opus 4.6",
            "role": "브리핑, 시나리오, 이벤트 해석",
        },
        "gemini_cli": {
            "available": bool(_gemini_cli),
            "path": _gemini_cli or "not found",
            "model": "Gemini 3.1 Pro Preview",
            "role": "Cloud 폴백",
        },
        "routing": LLM_ROUTING,
    }
