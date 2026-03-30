"""
@module LLM 서버 메인
@description FastAPI를 사용하여 LLM 분석 엔드포인트를 제공한다.
             시장 감정, 브리핑, 시나리오, 통합 플랜 분석을 수행한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Scheduler│ ──→ │ FastAPI  │ ──→ │ LLM      │
│ (Node.js)│     │ Server   │     │ Client   │
└──────────┘     └──────────┘     └──────────┘
      ↑               ↓
  REST API      Oracle DB
  (:2002)       (Log Result)

@zone z2-intel
@dependencies fastapi, pydantic, llm, oracle_reader, prompts, validator, app_utils
"""
import asyncio
import logging
import re
import time
from collections import Counter
from typing import Dict, Any, List, Optional

import httpx
from fastapi import FastAPI
from app_utils import lifespan, setup_logging
from models import (
    SentimentRequest, BriefingRequest, ScenarioRequest, 
    UnifiedPlanRequest, UnifiedPlanResolveRequest, EventRequest, ValidatePositionRequest, 
    EmbedRequest, TestRequest
)
from config import LLM_ROUTING, LOCAL_LLM_MODEL, LOCAL_LLM_URL, TASK_REASONING_EFFORT, LOCAL_LLM_REASONING_EFFORT
from embedder import encode
from llm import generate, get_active_calls, _active_calls, _OLLAMA_AVAILABLE
from llm_utils import extract_selected_id, parse_json_response
from oracle_reader import (
    get_all_symbols_snapshot, get_macro_snapshot, get_market_snapshot,
    get_recent_briefing, get_recent_events, get_recent_losses, get_recent_sentiment, get_similar_states
)
from prompts import (
    SENTIMENT_SYSTEM, SYSTEM_PROMPT, UNIFIED_PLAN_SELECTOR_SYSTEM, VALIDATE_SYSTEM,
    build_briefing_prompt, build_event_interpret_prompt, build_scenario_prompt,
    build_sentiment_prompt, build_unified_plan_selector_prompt, build_validate_position_prompt
)
from validator_fixed import validate_response, validate_unified_plan_response
from unified_plan_factory import build_unified_plan_candidates

# 로깅 설정
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
setup_logging()

app = FastAPI(title="COIN v2 LLM Server", lifespan=lifespan)

# 세마포어 제어
sentiment_sem = asyncio.Semaphore(2)
analysis_sem = asyncio.Semaphore(4)
plan_sem = asyncio.Semaphore(2)
fast_sem = asyncio.Semaphore(4)
bge_sem = asyncio.Semaphore(4)
cloud_sem = asyncio.Semaphore(2)
TEST_MAX_TOKENS = 800


def _norm_bias(value: Any, default: str = "NEUTRAL") -> str:
    if not isinstance(value, str):
        return default
    upper = value.strip().upper()
    if upper in {"BULLISH", "BEARISH", "NEUTRAL"}:
        return upper
    if upper == "UP":
        return "BULLISH"
    if upper == "DOWN":
        return "BEARISH"
    if upper == "LONG":
        return "BULLISH"
    if upper == "SHORT":
        return "BEARISH"
    return default


def _first_number(*values: Any, default: Optional[float] = None) -> Optional[float]:
    for value in values:
        if isinstance(value, (int, float)):
            return float(value)
    return default


def _snapshot_price(snapshot: Dict[str, Any]) -> Optional[float]:
    return _first_number(snapshot.get("price"), snapshot.get("p"))


def _snapshot_atr(snapshot: Dict[str, Any]) -> Optional[float]:
    return _first_number(snapshot.get("atr_4h"), snapshot.get("atr4h"), snapshot.get("atr_1h"))


def _preferred_direction(snapshot: Dict[str, Any]) -> str:
    bullish = 0
    bearish = 0
    for key in ("daily_bias", "trend_bias_4h", "trigger_bias_1h", "btc_daily_bias"):
        bias = _norm_bias(snapshot.get(key))
        if bias == "BULLISH":
            bullish += 1
        elif bias == "BEARISH":
            bearish += 1
    return "SHORT" if bearish > bullish else "LONG"


def _opposite_bias(direction: str) -> str:
    return "BEARISH" if direction == "LONG" else "BULLISH"


def _bias_alignment_score(snapshot: Dict[str, Any], direction: str) -> int:
    target = "BULLISH" if direction == "LONG" else "BEARISH"
    score = 0
    for key in ("daily_bias", "trend_bias_4h", "trigger_bias_1h", "btc_daily_bias"):
        if _norm_bias(snapshot.get(key)) == target:
            score += 1
    return score


def _build_trade_scenario(symbol: str, snapshot: Dict[str, Any], variant: str, direction: str) -> Dict[str, Any]:
    price = _snapshot_price(snapshot) or 0.0
    atr = _snapshot_atr(snapshot) or (price * 0.02 if price > 0 else 1.0)
    stop_gap = max(atr * 1.1, price * 0.012 if price > 0 else atr * 0.6)
    if price > 0:
        stop_gap = min(stop_gap, price * 0.04)
    target_gap = max(stop_gap * 2.2, atr * (2.4 if variant == "breakout" else 2.0), price * 0.03 if price > 0 else atr * 2.2)
    if price > 0:
        target_gap = min(target_gap, price * 0.095)
    if direction == "LONG":
        target_price = round(price + target_gap, 5)
        stop_price = round(max(0.0, price - stop_gap), 5)
    else:
        target_price = round(max(0.0, price - target_gap), 5)
        stop_price = round(price + stop_gap, 5)

    setup_field = {
        ("LONG", "pullback"): "pullback_long_setup",
        ("LONG", "breakout"): "breakout_long_setup",
        ("LONG", "retest"): "retest_support_ready",
        ("SHORT", "pullback"): "pullback_short_setup",
        ("SHORT", "breakout"): "breakout_short_setup",
        ("SHORT", "retest"): "retest_resistance_ready",
    }[(direction, variant)]
    trigger_value = int(bool(snapshot.get(setup_field)))
    if direction == "LONG":
        trigger_op_field = "support_distance_pct" if variant != "breakout" else "range_position_20"
    else:
        trigger_op_field = "resistance_distance_pct" if variant != "breakout" else "range_position_20"

    entry_conditions: Dict[str, Any] = {
        "daily_bias": {"op": "==", "value": _norm_bias(snapshot.get("daily_bias"), "NEUTRAL")},
        "trend_bias_4h": {"op": "==", "value": _norm_bias(snapshot.get("trend_bias_4h"), "NEUTRAL")},
        "trigger_bias_1h": {"op": "==", "value": _norm_bias(snapshot.get("trigger_bias_1h"), "NEUTRAL")},
        setup_field: {"op": ">=", "value": trigger_value},
    }
    if trigger_op_field in ("support_distance_pct", "resistance_distance_pct"):
        trigger_value_num = _first_number(snapshot.get(trigger_op_field))
        if trigger_value_num is not None:
            entry_conditions[trigger_op_field] = {"op": "<=", "value": round(min(trigger_value_num, 1.5), 3)}
    else:
        range_value = _first_number(snapshot.get("range_position_20"))
        if range_value is not None:
            entry_conditions["range_position_20"] = {"op": ">=" if direction == "LONG" else "<=", "value": round(range_value, 3)}

    stop_conditions: Dict[str, Any] = {
        "daily_bias": {"op": "==", "value": _opposite_bias(direction)},
        "trend_bias_4h": {"op": "==", "value": _opposite_bias(direction)},
        "trigger_bias_1h": {"op": "==", "value": _opposite_bias(direction)},
        "cvd_direction": {"op": "<" if direction == "LONG" else ">", "value": 0},
    }
    funding_rate = _first_number(snapshot.get("funding_rate"), default=0.0) or 0.0
    stop_conditions["funding_rate"] = {
        "op": ">" if direction == "LONG" else "<",
        "value": 0.001 if direction == "LONG" else -0.001,
    }
    stop_conditions["oi_change_pct"] = {
        "op": ">" if direction == "LONG" else "<",
        "value": 1.5 if direction == "LONG" else -1.5,
    }

    confidence = 0.56
    confidence += 0.08 * _bias_alignment_score(snapshot, direction)
    if trigger_value:
        confidence += 0.05
    if variant == "breakout":
        confidence += 0.02
    if _norm_bias(snapshot.get("btc_daily_bias")) == ("BULLISH" if direction == "LONG" else "BEARISH"):
        confidence += 0.04
    confidence = max(0.55, min(confidence, 0.93))

    return {
        "id": f"{symbol.lower()}_{variant}_{direction.lower()}",
        "description": f"{symbol} {variant} {direction.lower()} fallback",
        "probability": round(confidence, 2),
        "direction": direction,
        "funding_rate": round(funding_rate, 6),
        "open_interest": _first_number(snapshot.get("open_interest"), default=0.0) or 0.0,
        "entry_conditions": entry_conditions,
        "target_price": target_price,
        "stop_price": stop_price,
        "stop_conditions": stop_conditions,
        "time_stop_min": 720 if variant == "breakout" else 480,
        "reasoning": f"{symbol} {direction} {variant} fallback. daily={_norm_bias(snapshot.get('daily_bias'))}, 4h={_norm_bias(snapshot.get('trend_bias_4h'))}, 1h={_norm_bias(snapshot.get('trigger_bias_1h'))}.",
    }


def _fallback_briefing(snapshot: Dict[str, Any], sentiment: Optional[Dict[str, Any]], similar_states: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    direction = _preferred_direction(snapshot)
    regime = "markup" if direction == "LONG" else "markdown"
    price = _snapshot_price(snapshot) or 0.0
    atr = _snapshot_atr(snapshot) or (price * 0.02 if price > 0 else 0.0)
    support = _first_number(snapshot.get("support_level_1h"), default=None)
    resistance = _first_number(snapshot.get("resistance_level_1h"), default=None)
    if support is None and price > 0:
        support = round(max(0.0, price - atr), 5)
    if resistance is None and price > 0:
        resistance = round(price + atr, 5)

    risk_factors = []
    funding_rate = _first_number(snapshot.get("funding_rate"), default=0.0) or 0.0
    oi_change = _first_number(snapshot.get("oi_change_pct"), default=0.0) or 0.0
    if funding_rate > 0.001:
        risk_factors.append("롱 과열 funding 부담")
    if funding_rate < -0.001:
        risk_factors.append("숏 쏠림 funding 부담")
    if abs(oi_change) > 2.0:
        risk_factors.append("OI 변동성 확대")
    if _norm_bias(snapshot.get("btc_daily_bias")) != _norm_bias(snapshot.get("daily_bias")):
        risk_factors.append("BTC 방향과 개별 심리 불일치")
    if sentiment and isinstance(sentiment, dict):
        risk_factors.append("최근 뉴스 심리 변동")

    confidence = 0.62 + 0.05 * _bias_alignment_score(snapshot, direction)
    confidence = max(0.58, min(confidence, 0.9))

    if _first_number(snapshot.get("atr_4h_pct")) is not None and _first_number(snapshot.get("atr_4h_pct")) >= 4.0:
        volatility_state = "HIGH"
    elif _first_number(snapshot.get("atr_4h_pct")) is not None and _first_number(snapshot.get("atr_4h_pct")) <= 1.5:
        volatility_state = "LOW"
    else:
        volatility_state = "MED"

    return {
        "regime_diagnosis": regime,
        "direction_bias": "bullish" if direction == "LONG" else "bearish",
        "bias_strength": round(confidence, 2),
        "key_levels": {
            "support": [support] if support is not None else [],
            "resistance": [resistance] if resistance is not None else [],
        },
        "risk_factors": risk_factors or ["데이터 기반 폴백"],
        "funding_rate": round(funding_rate, 6),
        "oi_interpretation": "OI 상승 추세" if oi_change > 0 else "OI 둔화" if oi_change < 0 else "OI 중립",
        "volatility_state": volatility_state,
        "summary": f"LLM 응답이 비어 있어 데이터 기반 폴백 브리핑을 생성했습니다. 현재 구조는 {direction} 우위입니다.",
        "confidence": round(confidence, 2),
        "_fallback": True,
    }


def _fallback_scenario(
    symbol: str,
    snapshot: Dict[str, Any],
    briefing: Optional[Dict[str, Any]],
    event_calendar: Optional[List[Any]],
    fear_greed: Optional[Dict[str, Any]],
    stablecoin: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    direction = _preferred_direction(snapshot)
    scenarios = [
        _build_trade_scenario(symbol, snapshot, "pullback", direction),
        _build_trade_scenario(symbol, snapshot, "breakout", direction),
        _build_trade_scenario(symbol, snapshot, "retest", direction),
    ]
    scenarios.sort(key=lambda item: item.get("probability", 0), reverse=True)
    return {
        "scenarios": scenarios,
        "recommended_scenario": scenarios[0]["id"] if scenarios else "",
        "confidence": round(min(0.9, max(0.6, scenarios[0]["probability"] if scenarios else 0.6)), 2),
        "_fallback": True,
    }


def _fallback_interpret_event(symbol: str, event_text: str, snapshot: Dict[str, Any]) -> Dict[str, Any]:
    lowered = (event_text or "").lower()
    positive = any(word in lowered for word in ("approval", "etf", "partnership", "listing", "launch", "upgrade", "cut"))
    negative = any(word in lowered for word in ("hack", "exploit", "breach", "ban", "lawsuit", "crash", "liquidation", "hike"))
    impact = "neutral"
    if positive and not negative:
        impact = "positive"
    elif negative and not positive:
        impact = "negative"

    affected_direction = "LONG" if impact == "positive" else "SHORT" if impact == "negative" else "NONE"
    urgency = "immediate" if impact != "neutral" and any(word in lowered for word in ("hack", "exploit", "ban", "approval", "etf", "hike", "cut")) else "delayed" if impact != "neutral" else "none"
    confidence = 0.72 if impact != "neutral" else 0.42
    suggested_conditions = {}
    if impact == "positive":
        suggested_conditions = {"daily_bias": {"op": "==", "value": "BULLISH"}, "trigger_bias_1h": {"op": "==", "value": "BULLISH"}}
    elif impact == "negative":
        suggested_conditions = {"daily_bias": {"op": "==", "value": "BEARISH"}, "trigger_bias_1h": {"op": "==", "value": "BEARISH"}}

    return {
        "event_type": "news" if any(word in lowered for word in ("news", "announcement", "report")) else "macro" if any(word in lowered for word in ("fed", "fomc", "rate", "cpi", "inflation")) else "onchain" if any(word in lowered for word in ("onchain", "wallet", "whale")) else "liquidation" if "liquid" in lowered else "news",
        "impact": impact,
        "impact_magnitude": 0.75 if impact != "neutral" else 0.25,
        "affected_direction": affected_direction,
        "urgency": urgency,
        "reasoning": f"{symbol} 이벤트를 기반으로 한 폴백 해석입니다. 현재 시장 구조와 {affected_direction if affected_direction != 'NONE' else '중립'} 방향을 우선 확인하세요.",
        "activate_plan": impact != "neutral" and confidence >= 0.6,
        "suggested_conditions": suggested_conditions,
        "confidence": confidence,
        "_fallback": True,
    }


def _fallback_validate_position(symbol: str, entry_reasoning: Dict[str, Any], snapshot: Dict[str, Any]) -> Dict[str, Any]:
    direction = _preferred_direction(snapshot)
    daily = _norm_bias(snapshot.get("daily_bias"))
    trend = _norm_bias(snapshot.get("trend_bias_4h"))
    trigger = _norm_bias(snapshot.get("trigger_bias_1h"))
    checks = [
        {
            "reason": "daily_bias",
            "status": "VALID" if daily == direction or daily == "NEUTRAL" else "INVALID",
            "current_value": daily,
            "explanation": "일봉 추세가 현재 포지션과 크게 충돌하지 않습니다." if daily == direction or daily == "NEUTRAL" else "일봉 추세가 반대입니다.",
        },
        {
            "reason": "trend_bias_4h",
            "status": "VALID" if trend == direction or trend == "NEUTRAL" else "INVALID",
            "current_value": trend,
            "explanation": "4시간 구조가 현재 포지션과 크게 충돌하지 않습니다." if trend == direction or trend == "NEUTRAL" else "4시간 구조가 반대입니다.",
        },
        {
            "reason": "trigger_bias_1h",
            "status": "VALID" if trigger == direction or trigger == "NEUTRAL" else "INVALID",
            "current_value": trigger,
            "explanation": "1시간 트리거가 유지되고 있습니다." if trigger == direction or trigger == "NEUTRAL" else "1시간 트리거가 반대입니다.",
        },
        {
            "reason": "funding_rate",
            "status": "VALID" if (_first_number(snapshot.get("funding_rate"), default=0.0) or 0.0) <= 0.001 else "INVALID",
            "current_value": round((_first_number(snapshot.get("funding_rate"), default=0.0) or 0.0), 6),
            "explanation": "펀딩이 과도하지 않습니다." if (_first_number(snapshot.get("funding_rate"), default=0.0) or 0.0) <= 0.001 else "펀딩 부담이 큽니다.",
        },
    ]
    valid_count = sum(1 for item in checks if item["status"] == "VALID")
    invalid_count = len(checks) - valid_count
    recommendation = "HOLD" if invalid_count == 0 else "PARTIAL_EXIT" if invalid_count <= 2 else "FULL_EXIT"
    if direction == "SHORT" and daily == "BULLISH" and trend == "BULLISH":
        recommendation = "FULL_EXIT"
    if direction == "LONG" and daily == "BEARISH" and trend == "BEARISH":
        recommendation = "FULL_EXIT"

    return {
        "checks": checks,
        "valid_count": valid_count,
        "invalid_count": invalid_count,
        "recommendation": recommendation,
        "reasoning": f"{symbol} 포지션 폴백 검증입니다. entry_reasoning 키 수={len(entry_reasoning or {})}, daily={daily}, 4h={trend}, 1h={trigger}.",
        "confidence": 0.45,
        "_fallback": True,
    }


def _select_route(requested_provider: str, task_type: str) -> str:
    return "local"


_POSITIVE_WORDS = {
    "surge", "breakout", "bull", "bullish", "gain", "gains", "rally", "approval",
    "accumulation", "support", "beats", "beat", "strong", "growth", "record"
}
_NEGATIVE_WORDS = {
    "drop", "drops", "selloff", "bear", "bearish", "loss", "losses", "hack",
    "lawsuit", "crash", "fear", "weak", "decline", "liquidation", "liquidations"
}
_STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "will", "into", "after",
    "market", "crypto", "coin", "token", "news", "price", "prices", "likely"
}


def _fallback_sentiment(news_items: List[Dict[str, Any]]) -> Dict[str, Any]:
    texts: List[str] = []
    for item in news_items[:20]:
        parts = [
            str(item.get("title", "")).strip(),
            str(item.get("content", "")).strip(),
            str(item.get("summary", "")).strip(),
            str(item.get("description", "")).strip(),
        ]
        texts.append(" ".join(p for p in parts if p))

    joined = " ".join(texts).lower()
    pos = sum(1 for w in _POSITIVE_WORDS if w in joined)
    neg = sum(1 for w in _NEGATIVE_WORDS if w in joined)
    denom = max(1, pos + neg)
    score = max(-1.0, min(1.0, (pos - neg) / denom))
    abs_score = abs(score)
    intensity = "low" if abs_score < 0.25 else "medium" if abs_score < 0.6 else "high"
    tokens = [t.lower() for t in re.findall(r"[A-Za-z0-9가-힣]+", joined) if len(t) > 2 and t.lower() not in _STOPWORDS]
    topic = Counter(tokens).most_common(1)[0][0] if tokens else "market"
    return {
        "sentiment": round(score, 2),
        "intensity": intensity,
        "key_topic": topic[:20],
        "source_count": len(news_items[:20]),
        "confidence": 0.2 if texts else 0.0,
        "_fallback": True,
    }


def _fallback_unified_plan(candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not candidates:
        return {"plan": None}
    best = candidates[0]
    logging.warning("[LLM] Unified plan fallback selected top candidate %s", best.get("id"))
    return {"plan": best, "_fallback": True}


async def _prepare_unified_plan_context(req: UnifiedPlanRequest | UnifiedPlanResolveRequest):
    snaps, macro, *rest = await asyncio.gather(
        get_all_symbols_snapshot(req.symbols), get_macro_snapshot(),
        *[get_recent_losses(s, limit=2) for s in req.symbols],
        *[get_recent_events(s, limit=2) for s in req.symbols],
    )
    split = len(req.symbols)
    loss_res = rest[:split]
    event_res = rest[split:]
    losses = {s: l for s, l in zip(req.symbols, loss_res) if l}
    events = {s: e for s, e in zip(req.symbols, event_res) if e}
    candidates = build_unified_plan_candidates(snaps)
    candidates.sort(key=lambda item: item.get("confidence", 0.0), reverse=True)
    return snaps, macro, losses, events, candidates


async def _select_unified_plan_id(
    candidates: List[Dict[str, Any]],
    macro: Dict[str, Any],
    req: UnifiedPlanRequest | UnifiedPlanResolveRequest,
    losses: Optional[Dict[str, Any]] = None,
    recent_events: Optional[Dict[str, Any]] = None,
) -> tuple[str, int, str]:
    prompt = build_unified_plan_selector_prompt(
        candidates,
        macro,
        req.event_calendar,
        req.fear_greed,
        req.stablecoin,
        losses,
        recent_events,
    )
    route = _select_route(req.provider, "unified_plan")
    max_tok = 64

    sem = cloud_sem if route == "cloud" else plan_sem
    async with sem:
        text, ms, _ = await generate(prompt, UNIFIED_PLAN_SELECTOR_SYSTEM, max_tok, "unified_plan", route_override=route)

    result = parse_json_response(text)
    selected_id = extract_selected_id(text, result)
    return selected_id, ms, route


def _resolve_unified_plan(selected_id: str, candidates: List[Dict[str, Any]], snaps: Dict[str, Any]) -> Dict[str, Any]:
    candidate_map = {c["id"]: c for c in candidates if c.get("id")}
    selected_plan = candidate_map.get(selected_id) if isinstance(selected_id, str) else None
    if not selected_plan:
        logging.warning("[LLM] Unified plan resolve received empty/invalid selected_id; using fallback candidate")
        fallback = _fallback_unified_plan(candidates)
        selected_plan = fallback.get("plan")
    if selected_plan:
        selected_plan.setdefault("confidence", 0.5)

    normalized_result = {"plan": selected_plan}
    validated = validate_unified_plan_response(normalized_result, snaps)
    return validated["result"]

@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "version": "v2", "timestamp": time.time()}

@app.get("/api/llm-active")
async def llm_active() -> Dict[str, Any]:
    return {"calls": get_active_calls(), "total": len(_active_calls)}

@app.post("/api/sentiment")
async def sentiment(req: SentimentRequest) -> Dict[str, Any]:
    prompt = build_sentiment_prompt(req.news_items)
    system = (
        "Analyze crypto/macro news and output exactly one JSON object. "
        "No markdown, no prose, no bullet points, no code fences. "
        "Return only this schema: "
        '{"sentiment":<float>,"intensity":"<low|medium|high>","key_topic":"<main topic in 5 words>",'
        '"source_count":<int>,"confidence":<float>}.'
    )
    async with sentiment_sem:
        text, _, _ = await generate(prompt, system, 300, "sentiment")
    result = parse_json_response(text)
    if not isinstance(result, dict) or not result:
        repair_prompt = f"""Convert the following assistant output into exactly one valid JSON object.
Do not explain anything. Do not add markdown. Do not add code fences.

Assistant output:
{text}

Required JSON keys:
sentiment, intensity, key_topic, source_count, confidence
"""
        async with sentiment_sem:
            repaired_text, _, _ = await generate(repair_prompt, system, 180, "sentiment")
        result = parse_json_response(repaired_text)
    if not result:
        logging.warning("[LLM] Sentiment fallback used after empty LLM output")
        result = _fallback_sentiment(req.news_items)
    else:
        result.setdefault("sentiment", 0); result.setdefault("confidence", 0)
    return result

@app.post("/api/briefing")
async def briefing(req: BriefingRequest) -> Dict[str, Any]:
    snap, sent, similar, recent_events = await asyncio.gather(
        get_market_snapshot(req.symbol), get_recent_sentiment(), get_similar_states(req.symbol), get_recent_events(req.symbol, limit=3)
    )
    prompt = build_briefing_prompt(snap, sent, similar, recent_events)
    async with analysis_sem:
        text, _, _ = await generate(prompt, SYSTEM_PROMPT, 1500, "briefing")
    result = parse_json_response(text)
    if not isinstance(result, dict) or not result:
        result = _fallback_briefing(snap, sent, similar)
    validated = validate_response(result, snap, "briefing")
    result = validated["result"] or result
    result["_warnings"] = validated["warnings"]
    return result

@app.post("/api/scenario")
async def scenario(req: ScenarioRequest) -> Dict[str, Any]:
    snap, similar, losses, briefing, recent_events = await asyncio.gather(
        get_market_snapshot(req.symbol), get_similar_states(req.symbol),
        get_recent_losses(req.symbol), get_recent_briefing(req.symbol), get_recent_events(req.symbol, limit=5)
    )
    prompt = build_scenario_prompt(
        snap,
        briefing or {},
        similar,
        req.event_calendar,
        req.fear_greed,
        req.stablecoin,
        losses,
        recent_events,
    )
    async with analysis_sem:
        text, _, _ = await generate(prompt, SYSTEM_PROMPT, 2000, "scenario")
    result = parse_json_response(text)
    if not isinstance(result, dict) or not result:
        result = _fallback_scenario(req.symbol, snap, briefing, req.event_calendar, req.fear_greed, req.stablecoin)
    validated = validate_response(result, snap, "scenario")
    result = validated["result"] or result
    result.update({"_warnings": validated["warnings"], "_valid": validated["valid"]})
    return result

@app.post("/api/unified-plan")
async def unified_plan(req: UnifiedPlanRequest) -> Dict[str, Any]:
    snaps, macro, losses, recent_events, candidates = await _prepare_unified_plan_context(req)
    candidates = candidates[:20]
    if not candidates:
        return {"plan": None}

    selected_id, ms, route = await _select_unified_plan_id(candidates, macro, req, losses, recent_events)
    candidate_map = {c["id"]: c for c in candidates if c.get("id")}
    if selected_id not in candidate_map:
        selected_id = ""
    filtered = _resolve_unified_plan(selected_id, candidates, snaps)
    logging.info(f"[LLM] Unified plan selected_id: {selected_id or 'EMPTY'} in {ms}ms ({route})")
    logging.info(f"[LLM] Unified plan resolved plan(s): {1 if filtered.get('plan') else 0}")
    return filtered

@app.post("/api/interpret-event")
async def interpret_event(req: EventRequest) -> Dict[str, Any]:
    snap = await get_market_snapshot(req.symbol)
    prompt = build_event_interpret_prompt(req.event_text, snap)
    async with fast_sem:
        text, _, _ = await generate(prompt, SYSTEM_PROMPT, 800, "interpret_event")
    result = parse_json_response(text)
    if not isinstance(result, dict) or not result:
        result = _fallback_interpret_event(req.symbol, req.event_text, snap)
    return result

@app.post("/api/validate-position")
async def validate_position(req: ValidatePositionRequest) -> Dict[str, Any]:
    snap = await get_market_snapshot(req.symbol)
    prompt = build_validate_position_prompt(req.entry_reasoning, snap)
    async with fast_sem:
        text, ms, _ = await generate(prompt, VALIDATE_SYSTEM, 500, "validate_position")
    result = parse_json_response(text)
    if not isinstance(result, dict) or not result:
        result = _fallback_validate_position(req.symbol, req.entry_reasoning, snap)
    logging.info(f"[LLM] Validate {req.symbol}: {result.get('recommendation')} ({ms}ms)")
    return result

@app.post("/api/embed")
async def embed_text(req: EmbedRequest) -> Dict[str, Any]:
    async with bge_sem:
        vector = encode(req.text)
    return {"vector": vector, "dimensions": len(vector)}

@app.post("/api/test-llm")
async def test_llm(req: TestRequest) -> Dict[str, Any]:
    system = "Concise assistant. Output only the final answer. Do not emit <think> blocks."
    route = _select_route(req.provider, "test")
    sem = cloud_sem if route == "cloud" else fast_sem
    async with sem:
        text, ms, tokens = await generate(req.prompt, system, TEST_MAX_TOKENS, "test", route_override=route)
    response = text or "LLM 응답이 비어 있습니다."
    return {"response": response, "latency_ms": ms, "tokens": tokens, "status": "ok" if text else "error"}

@app.get("/api/llm-status")
async def llm_status() -> Dict[str, Any]:
    local_status = {
        "available": bool(LOCAL_LLM_URL) and _OLLAMA_AVAILABLE,
        "provider": "ollama",
        "model": LOCAL_LLM_MODEL,
        "url": LOCAL_LLM_URL,
        "backend_available": _OLLAMA_AVAILABLE,
    }
    return {
        "local": local_status,
        "local_llm": local_status,
        "routing": LLM_ROUTING,
        "effort": {"default": LOCAL_LLM_REASONING_EFFORT, "tasks": TASK_REASONING_EFFORT}
    }
