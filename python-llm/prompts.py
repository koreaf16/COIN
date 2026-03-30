"""
@module Prompts
@description LLM에 전달할 시스템 프롬프트 및 사용자 프롬프트 템플릿을 관리한다.
             모든 프롬프트는 검증 가능한 수치 출력을 강제하며 한국어 응답을 포함한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Market   │ ──→ │ Prompt   │ ──→ │ LLM      │
│ Data     │     │ Builder  │     │ Client   │
└──────────┘     └──────────┘     └──────────┘

@dependencies json, typing
"""
import json
from typing import List, Dict, Optional, Any

# ── 시스템 프롬프트 상수 ──

SYSTEM_PROMPT = """Analyze crypto derivatives SWING trading data and produce structured JSON outputs.
Focus on high-conviction setups for 4 to 48 hour holding periods based on 4h/Daily timeframes.

RULES:
1. Always include specific numerical values from the data in your reasoning.
2. Output ONLY valid JSON (no markdown, no explanation outside JSON).
3. Include a "confidence" field (0.0-1.0) in every response.
4. If data is insufficient, set confidence below 0.5.
5. Never hallucinate numbers — only reference values provided in the input.
6. CRITICAL: Write ALL "reasoning", "summary", "explanation" fields in Korean (한국어).
   Include specific data values in Korean text.
7. SWING RULES: Prioritize 4h and Daily trend structure. Set time_stop_min between 240 (4h) and 2880 (48h)."""

SENTIMENT_SYSTEM = """Analyze news headlines and produce structured JSON.
Output ONLY valid JSON. No explanations outside JSON.

RULES:
1. Include "confidence" field (0.0-1.0).
2. Never hallucinate — reference input only.
3. If data is insufficient, set confidence below 0.5.

Output JSON format:
{
  "sentiment": "<float -1.0 to 1.0>",
  "intensity": "<low|medium|high>",
  "key_topic": "<main topic in 5 words>",
  "source_count": "<int>",
  "confidence": "<float 0-1>"
}"""

VALIDATE_SYSTEM = """Validate crypto position premise based on current market metrics.
Output ONLY valid JSON. No explanations outside JSON.

RULES:
1. Include "confidence" field (0.0-1.0).
2. Never hallucinate numbers.
3. Write ALL "reasoning", "explanation" fields in Korean (한국어).
4. Ignore exact 'price' entry conditions. Focus on CVD, OI, Funding Rate, Macro, Volume.
5. Recommend HOLD if thesis is intact, FULL_EXIT only if thesis reversed.

Output JSON format:
{
  "checks": [
    {"reason": "<한국어 근거>", "status": "<VALID|INVALID>", "current_value": "<val>", "explanation": "<한국어 설명>"}
  ],
  "valid_count": "<int>",
  "invalid_count": "<int>",
  "recommendation": "<HOLD|PARTIAL_EXIT|FULL_EXIT>",
  "reasoning": "<한국어로 종합 판단>",
  "confidence": "<0-1>"
}"""

UNIFIED_PLAN_SYSTEM = """Crypto SWING trading (4-48h hold). Output ONLY valid JSON, no hallucinations.

ALLOWED CONDITION FIELDS (exact names only):
price, funding_rate, predicted_funding, oi_change_pct, open_interest, long_ratio, short_ratio, liq_long_24h, liq_short_24h, cvd_direction, macro_regime, volume_surge, price_dir_1h, oi_dir_1h, volatility_acceleration, daily_bias, trend_bias_4h, trigger_bias_1h, btc_daily_bias, ema_gap_4h, ema_gap_1d, ema_fast_above_slow_4h, ema_fast_above_slow_1d, pullback_atr_ratio, support_distance_pct, resistance_distance_pct, range_position_20, donchian_break_20, relative_strength_btc_12h, pullback_long_setup, pullback_short_setup, breakout_long_setup, breakout_short_setup, retest_support_ready, retest_resistance_ready.

RULES:
1. Direction: LONG/SHORT/SKIP. SKIP only if data missing or contradictory.
2. cvd_direction: -1.0~1.0. volume_surge: ratio(1.0=normal). price_dir_1h/oi_dir_1h: "UP"/"DOWN"/"FLAT" with "==".
3. target_price: 1.5~3x 4h ATR, max 10% from entry. R:R>=2.0. stop_price>=1.0% from entry.
4. time_stop_min: 240~2880.
5. TREND MATURITY: c_bear>=4 & c_drop>1% → SKIP SHORT. c_bull>=4 & c_rise>1% → SKIP LONG.
6. BTC ALIGN(non-BTC): btc_mom>+1% → no SHORT. btc_mom<-1% → no LONG.
7. RSI: rsi14<30 → SKIP SHORT. rsi14>70 → SKIP LONG.
8. STRUCTURE HIERARCHY: Align plans with daily_bias -> trend_bias_4h -> trigger_bias_1h. entry_conditions MUST include at least 1 higher timeframe field (daily_bias, trend_bias_4h, btc_daily_bias) AND at least 1 trigger field (trigger_bias_1h, pullback_*, breakout_*, retest_*, support/resistance structure fields).
9. stop_conditions MUST NOT be empty. Include at least 1 condition that invalidates the thesis (e.g. funding_rate reversal, oi_change_pct spike, cvd_direction flip). These are logical exit triggers evaluated every 5s while in position.

CONFIDENCE per plan (0.0-1.0): 0.85-0.95=3+ signals aligned, 0.70-0.84=2 signals, 0.55-0.69=weak, <0.55=SKIP.

{"plans":[{"symbol":"SYM","direction":"LONG|SHORT|SKIP","confidence":0.0,"entry_conditions":{"daily_bias":{"op":"==","value":"BULLISH"},"trend_bias_4h":{"op":"==","value":"BULLISH"},"trigger_bias_1h":{"op":"==","value":"BULLISH"},"breakout_long_setup":{"op":">=","value":1},"price":{"op":">","value":0}},"target_price":0,"stop_price":0,"stop_conditions":{"cvd_direction":{"op":">","value":0.5}},"time_stop_min":0,"reasoning":"max 150 chars"}]}"""

# ── 프롬프트 빌더 함수 ──

def build_sentiment_prompt(news_items: List[Dict[str, Any]]) -> str:
    """뉴스 항목들을 기반으로 감정 분석 프롬프트를 생성한다."""
    lines = []
    for n in news_items[:20]:
        title = n.get('title', '').strip()
        source = n.get('source', '?')
        category = n.get('category', '')
        content = n.get('content', '').strip()

        entry = f"[{source}]"
        if category:
            entry += f"[{category}]"
        entry += f" {title}"
        if content:
            entry += f"\n  → {content[:150]}"
        lines.append(entry)

    news_text = "\n".join(lines)
    return f"""Analyze the following {len(news_items[:20])} crypto/macro news articles and determine the overall market sentiment.

NEWS:
{news_text}

Classify the aggregate sentiment from the articles above.
Consider: market-moving events, institutional signals, regulatory news, macro factors.
Return exactly one JSON object with keys sentiment, intensity, key_topic, source_count, confidence.
Do not add any other text."""

def build_briefing_prompt(
    snapshot: Dict[str, Any],
    sentiment: Optional[Dict[str, Any]],
    similar_states: Optional[Dict[str, Any]],
    recent_events: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """시장 스냅샷과 감정 지표를 결합하여 브리핑 프롬프트를 생성한다."""
    data = json.dumps(snapshot, indent=2, default=str)
    sent_text = json.dumps(sentiment, indent=2) if sentiment else "N/A"
    similar_text = json.dumps(similar_states, indent=2) if similar_states else "N/A"
    events_text = json.dumps(recent_events, indent=2, default=str) if recent_events else "None"

    return f"""Analyze the current market state and produce a comprehensive briefing.

MARKET DATA:
{data}

RECENT SENTIMENT:
{sent_text}

RECENT INTERPRETED EVENTS:
{events_text}

SIMILAR HISTORICAL STATES:
{similar_text}

Use RECENT INTERPRETED EVENTS to adjust direction_bias, bias_strength, and risk_factors.

Output JSON:
{{
  "regime_diagnosis": "<accumulation|distribution|markup|markdown|ranging>",
  "direction_bias": "<bullish|bearish|neutral>",
  "bias_strength": <float 0-1>,
  "key_levels": {{"support": [<price>], "resistance": [<price>]}},
  "risk_factors": ["<한국어 리스크 요인>"],
  "funding_rate": <actual from data>,
  "oi_interpretation": "<from OI matrix>",
  "volatility_state": "<LOW/MED/HIGH>",
  "summary": "<한국어 2-3문장 요약>",
  "confidence": <float 0-1>
}}"""

def build_scenario_prompt(
    snapshot: Dict[str, Any], 
    briefing: Dict[str, Any], 
    similar_states: Optional[Dict[str, Any]],
    event_calendar: Optional[List[Any]] = None,
    fear_greed: Optional[Dict[str, Any]] = None,
    stablecoin: Optional[Dict[str, Any]] = None,
    recent_losses: Optional[List[Any]] = None,
    recent_events: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """시나리오 생성 프롬프트를 빌드한다. (50줄 초과 방지를 위해 데이터 직렬화 분리)"""
    data_ctx = {
        "market": snapshot,
        "briefing": briefing,
        "historical": similar_states or "N/A",
        "events": event_calendar or "None",
        "recent_events": recent_events or "None",
        "fear_greed": fear_greed or "N/A",
        "stablecoin": stablecoin or "N/A",
        "recent_losses": recent_losses or "None"
    }
    
    # 템플릿 부분만 반환하여 함수 길이 유지
    return _get_scenario_template(data_ctx)

def _get_scenario_template(ctx: Dict[str, Any]) -> str:
    """시나리오 생성을 위한 상세 템플릿과 데이터를 결합한다."""
    return f"""Generate 3 SWING trading scenarios with machine-readable entry conditions.
Target holding period: 4 to 48 hours. Use 4h/Daily structure for key levels.

MARKET: {json.dumps(ctx['market'], default=str)}
BRIEFING: {json.dumps(ctx['briefing'], default=str)}
HISTORICAL: {json.dumps(ctx['historical'], default=str)}
EVENTS: {json.dumps(ctx['events'], default=str)}
RECENT_INTERPRETED_EVENTS: {json.dumps(ctx['recent_events'], default=str)}
FEAR_GREED: {json.dumps(ctx['fear_greed'], default=str)}
STABLECOIN_SUPPLY: {json.dumps(ctx['stablecoin'], default=str)}
RELEVANT_RECENT_LOSSES (RAG): {json.dumps(ctx['recent_losses'], default=str)}

Rules for scenarios:
1. Review RELEVANT_RECENT_LOSSES. Do NOT suggest a plan if current market metrics match a pattern that previously led to a loss.
2. Review RECENT_INTERPRETED_EVENTS. If a recent high-urgency or high-confidence event conflicts with the setup, lower probability sharply or do not suggest that plan.
3. If current metrics look like a trap, increase the confidence threshold.
4. SWING RULE: Use 4h ATR for targets, time_stop_min between 240-2880.
5. TREND MATURITY: If c_bear >= 4 and drop > 1%, do NOT SHORT. If c_bull >= 4 and rise > 1%, do NOT LONG.
6. BTC ALIGNMENT: Check btc_mom. Do NOT counter BTC bounce/drop.
7. RSI EXTREMES: rsi14 < 30 no SHORT, rsi14 > 70 no LONG.
8. STOP DISTANCE: stop_price >= 1.0% from entry. R:R >= 2.0.
9. STOP CONDITIONS: MUST NOT be empty. Include logic like funding_rate reversal or cvd_direction flip.
10. IMPORTANT: Use actual market field names as JSON keys. Never use a literal "field" key. Example: {"price":{"op":"<","value":0}}.

Output JSON:
{{
  "scenarios": [
    {{
      "id": "scenario_1",
      "description": "<한국어 시나리오 설명>",
      "probability": <0-1>,
      "direction": "<LONG|SHORT>",
      "funding_rate": <actual from data>,
      "open_interest": <actual from data>,
      "entry_conditions": {{"price": {{"op": "<", "value": 0}}}},
      "target_price": <number>,
      "stop_price": <number>,
      "stop_conditions": {{"cvd_direction": {{"op": ">", "value": 0}}}},
      "time_stop_min": <int>,
      "reasoning": "<한국어로 구체적 수치와 함께 근거 설명>"
    }}
  ],
  "recommended_scenario": "<id>",
  "confidence": <0-1>
}}"""

def build_unified_plan_prompt(
    all_snapshots: Dict[str, Any], 
    macro: Dict[str, Any],
    event_calendar: Optional[List[Any]] = None,
    fear_greed: Optional[Dict[str, Any]] = None,
    stablecoin: Optional[Dict[str, Any]] = None,
    recent_losses: Optional[Dict[str, Any]] = None,
    recent_events: Optional[Dict[str, Any]] = None,
) -> str:
    """동적 데이터를 압축하여 통합 플랜 프롬프트를 생성한다."""
    _compact = lambda obj: json.dumps(obj, separators=(',', ':'), default=str)

    macro_text = _compact(macro) if macro else "N/A"
    cal_text = _compact(event_calendar) if event_calendar else "None"
    fg_text = _compact(fear_greed) if fear_greed else "N/A"
    sc_text = _compact(stablecoin) if stablecoin else "N/A"
    symbols_text = _compact(all_snapshots)
    loss_text = _compact(recent_losses) if recent_losses else "None"
    event_text = _compact(recent_events) if recent_events else "None"

    return f"""MACRO: {macro_text}
EVENTS_24H: {cal_text}
FEAR_GREED: {fg_text}
STABLECOIN: {sc_text}
RECENT_INTERPRETED_EVENTS: {event_text}

SYMBOL DATA:
{symbols_text}

RECENT_LOSSES:
{loss_text}

CRITICAL: Analyze recent losses. If current market speed or OI-Price patterns match those losses, set higher confidence bars."""


_LEGACY_UNIFIED_PLAN_SELECTOR_SYSTEM = """You are a selector, not a creator.
Choose only from the pre-generated candidate plans below.
Do NOT invent new symbols, directions, conditions, targets, stops, or time stops.
Output ONLY valid JSON.

Selection rules:
1. Select exactly 1 candidate overall, or none if nothing fits.
2. Prefer the candidate with the best alignment to daily_bias -> trend_bias_4h -> trigger_bias_1h.
3. Reject candidates that conflict with BTC alignment, RSI extremes, or structure hierarchy.
4. Reject candidates that conflict with RECENT_INTERPRETED_EVENTS, especially urgent/high-confidence negative or positive event direction.
5. Confidence reflects selection quality, not market prediction.

Output JSON format:
{
  "selected_id": "candidate_id_1",
  "confidence": 0.0,
  "reasoning": "짧은 한국어 설명"
}"""


UNIFIED_PLAN_SELECTOR_SYSTEM = """You are a selector, not a creator.
Choose only from the pre-generated candidate plans below.
Do NOT invent new symbols, directions, conditions, targets, stops, or time stops.
Output ONLY one minified JSON object.
Do not include analysis, reasoning, markdown, code fences, or extra text.

Selection rules:
1. Select exactly 1 candidate overall, or none if nothing fits.
2. Prefer the candidate with the best alignment to daily_bias -> trend_bias_4h -> trigger_bias_1h.
3. Reject candidates that conflict with BTC alignment, RSI extremes, or structure hierarchy.
4. Reject candidates that conflict with RECENT_INTERPRETED_EVENTS, especially urgent/high-confidence negative or positive event direction.

Output JSON format:
{
  "selected_id": "candidate_id_1"
}"""


def build_unified_plan_selector_prompt(
    candidate_plans: List[Dict[str, Any]],
    macro: Dict[str, Any],
    event_calendar: Optional[List[Any]] = None,
    fear_greed: Optional[Dict[str, Any]] = None,
    stablecoin: Optional[Dict[str, Any]] = None,
    recent_losses: Optional[Dict[str, Any]] = None,
    recent_events: Optional[Dict[str, Any]] = None,
) -> str:
    """코드가 만든 후보들 중에서 LLM이 고르게 하는 선택 프롬프트를 만든다."""
    _compact = lambda obj: json.dumps(obj, separators=(',', ':'), default=str)

    macro_text = _compact(macro) if macro else "N/A"
    cal_text = _compact(event_calendar) if event_calendar else "None"
    fg_text = _compact(fear_greed) if fear_greed else "N/A"
    sc_text = _compact(stablecoin) if stablecoin else "N/A"
    candidates_text = _compact(candidate_plans)
    loss_text = _compact(recent_losses) if recent_losses else "None"
    event_text = _compact(recent_events) if recent_events else "None"

    return f"""MACRO: {macro_text}
EVENTS_24H: {cal_text}
FEAR_GREED: {fg_text}
STABLECOIN: {sc_text}
RECENT_INTERPRETED_EVENTS: {event_text}

CANDIDATE_PLANS:
{candidates_text}

RECENT_LOSSES:
{loss_text}

Select only from the candidate_plans above. Do not create any new plan fields.
If the market looks contradictory or low quality, return {{"selected_id": ""}}.
Return exactly one minified JSON object and nothing else.
"""

def build_event_interpret_prompt(event_text: str, snapshot: Dict[str, Any]) -> str:
    """급격한 이벤트를 해석하기 위한 프롬프트를 생성한다."""
    data = json.dumps(snapshot, indent=2, default=str)
    return f"""URGENT: Interpret this event for trading.

EVENT: {event_text}
MARKET: {data}

Output JSON:
{{
  "event_type": "<macro|news|onchain|liquidation>",
  "impact": "<positive|negative|neutral>",
  "impact_magnitude": <0-1>,
  "affected_direction": "<LONG|SHORT|NONE>",
  "urgency": "<immediate|delayed|none>",
  "reasoning": "<한국어로 구체적 수치와 함께 근거 설명>",
  "activate_plan": <bool>,
  "suggested_conditions": {{}},
  "confidence": <0-1>
}}"""

def build_validate_position_prompt(entry_reasoning: Dict[str, Any], current_snapshot: Dict[str, Any]) -> str:
    """포지션 진입 근거가 현재 시장 상황에서도 유효한지 검증하는 프롬프트를 생성한다."""
    entry = json.dumps(entry_reasoning, indent=2, default=str)
    current = json.dumps(current_snapshot, indent=2, default=str)
    return f"""ENTRY REASONING: {entry}
CURRENT MARKET: {current}"""
