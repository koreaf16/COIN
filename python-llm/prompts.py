"""
Z2 LLM Supervisor Prompts — 시장 분석/시나리오/검증용 프롬프트 템플릿
모든 프롬프트는 검증 가능한 수치 출력을 강제함
"""
import json

SYSTEM_PROMPT = """You are an expert crypto derivatives SWING trading analyst.
You analyze market data across multiple timeframes (4h, Daily) and produce structured JSON outputs.
Your goal is to identify high-conviction setups with holding periods of 4 to 48 hours.

RULES:
1. Always include specific numerical values from the data in your reasoning
2. Output ONLY valid JSON (no markdown, no explanation outside JSON)
3. Include a "confidence" field (0.0-1.0) in every response
4. If data is insufficient, set confidence below 0.5
5. Never hallucinate numbers — only reference values provided in the input
6. CRITICAL: Write ALL "reasoning", "summary", "explanation" fields in Korean (한국어).
   Include specific data values in Korean text. Example: "4시간봉 ATR 기준 목표가 설정, 펀딩비 -0.0005로 숏 과밀, OI 2.3% 감소로 롱 매수 압력 확인"
   NEVER write reasoning in English.
7. SWING RULES: Prioritize 4h and Daily trend structure over short-term noise.
   Set time_stop_min between 240 (4h) and 2880 (48h). Avoid scalping setups (time_stop < 60min)."""


# ── 분석 전용 시스템 프롬프트 (DeepSeek/Qwen 공용) ──

SENTIMENT_SYSTEM = """You are an expert crypto news sentiment analyst.
You analyze news headlines and produce structured JSON outputs.

RULES:
1. Output ONLY valid JSON (no markdown, no explanation outside JSON)
2. Include a "confidence" field (0.0-1.0) in every response
3. Never hallucinate — only reference what is provided in the input
4. If data is insufficient, set confidence below 0.5

Output JSON format:
{
  "sentiment": "<float -1.0 to 1.0>",
  "intensity": "<low|medium|high>",
  "key_topic": "<main topic in 5 words>",
  "source_count": "<int>",
  "confidence": "<float 0-1>"
}"""

VALIDATE_SYSTEM = """You are an expert crypto position validator.
You check if the fundamental market premise for an open position is still valid.

RULES:
1. Output ONLY valid JSON (no markdown, no explanation outside JSON)
2. Include a "confidence" field (0.0-1.0) in every response
3. Never hallucinate numbers — only reference values provided in the input
4. Write ALL "reasoning", "explanation" fields in Korean (한국어).
5. Ignore exact 'price' entry conditions. Price fluctuations are managed by Stop-Loss and Take-Profit.
6. Focus ONLY on fundamental metrics (CVD, OI, Funding Rate, Macro, Volume) mentioned in the reasoning.
7. If the fundamental bearish/bullish premise is still intact, recommend HOLD.
8. Only recommend FULL_EXIT if the core thesis has fundamentally reversed.

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


def build_sentiment_prompt(news_items: list[dict]) -> str:
    news_text = "\n".join([
        f"- [{n.get('source','?')}] {n.get('title','')}"
        for n in news_items[:20]
    ])
    return f"""NEWS:
{news_text}"""


def build_briefing_prompt(snapshot: dict, sentiment: dict | None, similar_states: dict | None) -> str:
    data = json.dumps(snapshot, indent=2, default=str)
    sent_text = json.dumps(sentiment, indent=2) if sentiment else "N/A"
    similar_text = json.dumps(similar_states, indent=2) if similar_states else "N/A"

    return f"""Analyze the current market state and produce a comprehensive briefing.

MARKET DATA:
{data}

RECENT SENTIMENT:
{sent_text}

SIMILAR HISTORICAL STATES:
{similar_text}

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


def build_scenario_prompt(snapshot: dict, briefing: dict, similar_states: dict | None,
                          event_calendar: list | None = None,
                          fear_greed: dict | None = None,
                          stablecoin: dict | None = None,
                          recent_losses: list | None = None) -> str:
    data = json.dumps(snapshot, indent=2, default=str)
    brief = json.dumps(briefing, indent=2)
    similar_text = json.dumps(similar_states, indent=2) if similar_states else "N/A"
    cal_text = json.dumps(event_calendar, indent=2) if event_calendar else "None"
    fg_text = json.dumps(fear_greed, indent=2) if fear_greed else "N/A"
    sc_text = json.dumps(stablecoin, indent=2) if stablecoin else "N/A"
    loss_text = json.dumps(recent_losses, indent=2) if recent_losses else "None"

    return f"""Generate 3 SWING trading scenarios with machine-readable entry conditions.
Target holding period: 4 to 48 hours. Use 4h/Daily structure for key levels.

MARKET: {data}
BRIEFING: {brief}
HISTORICAL: {similar_text}
EVENTS: {cal_text}
FEAR_GREED: {fg_text}
STABLECOIN_SUPPLY: {sc_text}
RELEVANT_RECENT_LOSSES (RAG): {loss_text}

Rules for scenarios:
1. Review RELEVANT_RECENT_LOSSES. Do NOT suggest a plan if current market metrics match a pattern that previously led to a loss (e.g., catching a falling knife when Price DOWN & OI UP).
2. If current metrics (volatility_acceleration, funding_rate, etc.) look like a trap, increase the confidence threshold for entry.
3. SWING RULE: Use 4h ATR for target_price and stop_price calculation, not 1m ATR.
4. SWING RULE: time_stop_min should be between 240 (4h) and 2880 (48h). NEVER set below 120.

Operators: "<", ">", "<=", ">=", "==", "in"
Fields and data types (use ONLY numeric comparisons for numeric fields):
- price: float (USD, e.g. 68000.0) — use >, <, >=, <=
- funding_rate: float (e.g. 0.0001 = 0.01%) — use >, <, >=, <=
- oi_change_pct: float (e.g. 0.02 = 2% increase) — use >, <, >=, <=
- cvd_direction: float (-1.0 = strong sell pressure, 0 = neutral, +1.0 = strong buy pressure) — use >, <, >=, <=
- macro_regime: string enum ("risk_on", "risk_off", "neutral") — use "in" or "=="
- volume_surge: float (ratio vs 5min avg, e.g. 2.0 = 2x normal volume) — use >, <, >=, <=
- volatility_acceleration: float (current ATR / recent 10-bar avg ATR) — use >, <, >=, <=
IMPORTANT: Never use string values like "positive"/"negative" or booleans for numeric fields.

IMPORTANT: Every scenario MUST include both target_price AND stop_price.
- target_price: realistic take-profit level based on 4h support/resistance and 4h ATR
- stop_price: invalidation level where the thesis breaks (key S/R level beyond entry)
  - For LONG: stop_price < entry price (below nearest 4h support)
  - For SHORT: stop_price > entry price (above nearest 4h resistance)
- Risk:Reward ratio (distance to target / distance to stop) MUST be >= 2.0 for swing trades

Output JSON:
{{
  "scenarios": [
    {{
      "id": "scenario_1",
      "description": "<한국어 시나리오 설명>",
      "probability": <0-1>,
      "direction": "<LONG|SHORT>",
      "entry_conditions": {{
        "funding_rate": {{"op": "<", "value": -0.0005}},
        "macro_regime": {{"op": "in", "value": ["risk_on", "neutral"]}}
      }},
      "target_price": <number - required, based on 4h ATR or key resistance/support>,
      "stop_price": <number - required, invalidation level based on 4h structure>,
      "stop_conditions": {{"funding_rate": {{"op": ">", "value": 0.001}}}},
      "time_stop_min": <int, MUST be between 240 and 2880>,
      "reasoning": "<한국어로 구체적 수치와 함께 근거 설명. 반드시 4시간봉 기준 목표가/손절가 근거 포함>"
    }}
  ],
  "recommended_scenario": "<id>",
  "confidence": <0-1>
}}"""


# ── DeepSeek 전용 시스템 프롬프트 (프리픽스 캐싱 최적화) ──
# 정적 규칙/포맷을 시스템 프롬프트에 포함 → 매 호출 100% 캐시 히트
DEEPSEEK_UNIFIED_PLAN_SYSTEM = """You are an expert crypto derivatives SWING trading analyst.
You analyze market data and produce structured JSON outputs.
Target holding period: 4 to 48 hours. Prioritize 4h/Daily trend structure.

RULES:
1. Output ONLY valid JSON (no markdown, no explanation outside JSON)
2. Include a "confidence" field (0.0-1.0) in every response
3. If data is insufficient, set confidence below 0.5
4. Never hallucinate numbers — only reference values provided in the input

TASK: Determine the better direction (LONG or SHORT) for the symbol and set entry conditions.

PLAN RULES:
1. Always output LONG or SHORT. Use SKIP only when data is completely missing or contradictory signals cancel out.
2. entry_conditions must require a trigger NOT already satisfied at current market state.
   - Bad: price <= current_price (already true — triggers immediately)
   - Good: cvd_direction > 0.5, oi_change_pct > 0.01, volume_surge > 1.5
3. target_price must be realistic based on 4h ATR — calculate distance as 1.5~3x the 4h ATR
4. Risk:Reward (target distance / stop distance) MUST be >= 2.0 for swing trades
5. stop_conditions: logical invalidation rules (e.g., funding_rate or cvd_direction reverses)
6. time_stop_min: MUST be between 240 (4h minimum) and 2880 (48h maximum). NEVER set below 120.

Operators: "<", ">", "<=", ">=", "==", "in"
Fields: price (float), funding_rate (float), oi_change_pct (float), cvd_direction (float -1~+1), macro_regime ("risk_on"|"risk_off"|"neutral"), volume_surge (float ratio, see v_surge in data), volatility_acceleration (float, current 4h ATR / 10-bar avg 4h ATR; >1.2 = expanding, <0.8 = contracting, see vol_acc in data)
4h Swing Data: t4h (float -1~+1, 4h EMA trend strength), t4h_b ("bullish"|"bearish"|"neutral", 4h bias), atr4h (float, 4h ATR as % of price), chg12h (float, 12h price change %). USE these to determine swing direction and realistic target distances.

Output JSON:
{
  "plans": [
    {
      "symbol": "<SYMBOL>",
      "direction": "<LONG|SHORT|SKIP>",
      "entry_conditions": {
        "volume_surge": {"op": ">", "value": 1.5},
        "cvd_direction": {"op": ">", "value": 0.3}
      },
      "target_price": "<number - REQUIRED for LONG/SHORT, based on 4h ATR or key S/R>",
      "stop_price": "<number - REQUIRED for LONG/SHORT, based on 4h structure>",
      "stop_conditions": {
        "cvd_direction": {"op": "<", "value": -0.3}
      },
      "time_stop_min": "<int, between 240 and 2880>",
      "reasoning": "<English, max 150 chars: key 4h/Daily signal + target/stop basis>"
    }
  ],
  "confidence": "<0-1>"
}"""


def _normalize(obj, decimals: int = 4):
    """float 반올림 + dict 키 정렬 → 동일 데이터의 JSON 표현 안정화 (prefix 캐시 히트율 향상)"""
    if isinstance(obj, float):
        return round(obj, decimals)
    if isinstance(obj, dict):
        return {k: _normalize(v, decimals) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_normalize(v, decimals) for v in obj]
    return obj


def _compact(obj) -> str:
    return json.dumps(_normalize(obj), separators=(',', ':'), default=str)


def build_unified_plan_context(macro: dict,
                               event_calendar: list | None = None,
                               fear_greed: dict | None = None,
                               stablecoin: dict | None = None) -> str:
    """[message 2] 느리게 변하는 컨텍스트 — DeepSeek가 prefix로 캐시함
    macro/events/fg/sc는 수십 분~수시간 단위로 변하므로 별도 메시지로 분리.
    """
    macro_text = _compact(macro) if macro else "N/A"
    cal_text = _compact(event_calendar) if event_calendar else "None"
    fg_text = _compact(fear_greed) if fear_greed else "N/A"
    sc_text = _compact(stablecoin) if stablecoin else "N/A"

    return f"""MACRO: {macro_text}
EVENTS_24H: {cal_text}
FEAR_GREED: {fg_text}
STABLECOIN: {sc_text}"""


def build_unified_plan_data(all_snapshots: dict,
                            recent_losses: dict | None = None) -> str:
    """[message 4] 빠르게 변하는 심볼 데이터 — 매 요청마다 새 토큰으로 처리됨"""
    symbols_text = _compact(all_snapshots)
    loss_text = _compact(recent_losses) if recent_losses else "None"

    return f"""SYMBOL DATA:
{symbols_text}

RECENT_LOSSES:
{loss_text}

CRITICAL: Analyze recent losses. If current market speed (volatility_acceleration) or OI-Price patterns match those losses, set higher confidence bars or skip entry."""


def build_unified_plan_prompt(all_snapshots: dict, macro: dict,
                              event_calendar: list | None = None,
                              fear_greed: dict | None = None,
                              stablecoin: dict | None = None,
                              recent_losses: dict | None = None) -> str:
    """하위 호환용 — 단일 문자열 prompt가 필요한 경우에만 사용"""
    ctx = build_unified_plan_context(macro, event_calendar, fear_greed, stablecoin)
    data = build_unified_plan_data(all_snapshots, recent_losses)
    return f"{ctx}\n\n{data}"



def build_event_interpret_prompt(event_text: str, snapshot: dict) -> str:
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


def build_validate_position_prompt(entry_reasoning: dict, current_snapshot: dict) -> str:
    entry = json.dumps(entry_reasoning, indent=2, default=str)
    current = json.dumps(current_snapshot, indent=2, default=str)
    return f"""ENTRY REASONING: {entry}
CURRENT MARKET: {current}"""
