"""
Z2 LLM Supervisor Prompts — 시장 분석/시나리오/검증용 프롬프트 템플릿
모든 프롬프트는 검증 가능한 수치 출력을 강제함
"""
import json

SYSTEM_PROMPT = """You are an expert crypto derivatives trading analyst.
You analyze market data and produce structured JSON outputs.

RULES:
1. Always include specific numerical values from the data in your reasoning
2. Output ONLY valid JSON (no markdown, no explanation outside JSON)
3. Include a "confidence" field (0.0-1.0) in every response
4. If data is insufficient, set confidence below 0.5
5. Never hallucinate numbers — only reference values provided in the input
6. CRITICAL: Write ALL "reasoning", "summary", "explanation" fields in Korean (한국어).
   Include specific data values in Korean text. Example: "펀딩비 -0.0005로 숏 과밀, OI 2.3% 감소로 매도 압력 확인"
   NEVER write reasoning in English."""


# ── Qwen 전용 시스템 프롬프트 (LM Studio KV cache 최적화) ──
# 정적 규칙/출력포맷을 시스템 프롬프트에 포함 → 매 호출 KV cache 프리픽스 재사용

QWEN_SENTIMENT_SYSTEM = """You are an expert crypto news sentiment analyst.
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

QWEN_VALIDATE_SYSTEM = """You are an expert crypto position validator.
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
                          stablecoin: dict | None = None) -> str:
    data = json.dumps(snapshot, indent=2, default=str)
    brief = json.dumps(briefing, indent=2)
    similar_text = json.dumps(similar_states, indent=2) if similar_states else "N/A"
    cal_text = json.dumps(event_calendar, indent=2) if event_calendar else "None"
    fg_text = json.dumps(fear_greed, indent=2) if fear_greed else "N/A"
    sc_text = json.dumps(stablecoin, indent=2) if stablecoin else "N/A"

    return f"""Generate 3 trading scenarios with machine-readable entry conditions.

MARKET: {data}
BRIEFING: {brief}
HISTORICAL: {similar_text}
EVENTS: {cal_text}
FEAR_GREED: {fg_text}
STABLECOIN_SUPPLY: {sc_text}

Operators: "<", ">", "<=", ">=", "==", "in"
Fields and data types (use ONLY numeric comparisons for numeric fields):
- price: float (USD, e.g. 68000.0) — use >, <, >=, <=
- funding_rate: float (e.g. 0.0001 = 0.01%) — use >, <, >=, <=
- oi_change_pct: float (e.g. 0.02 = 2% increase) — use >, <, >=, <=
- cvd_direction: float (-1.0 = strong sell pressure, 0 = neutral, +1.0 = strong buy pressure) — use >, <, >=, <=
- macro_regime: string enum ("risk_on", "risk_off", "neutral") — use "in" or "=="
- volume_surge: float (ratio vs 5min avg, e.g. 2.0 = 2x normal volume) — use >, <, >=, <=
IMPORTANT: Never use string values like "positive"/"negative" or booleans for numeric fields.

IMPORTANT: Every scenario MUST include both target_price AND stop_price.
- target_price: realistic take-profit level based on support/resistance and ATR
- stop_price: invalidation level where the thesis breaks (key S/R level beyond entry)
  - For LONG: stop_price < entry price (below nearest support)
  - For SHORT: stop_price > entry price (above nearest resistance)
- Risk:Reward ratio (distance to target / distance to stop) should be >= 1.5

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
      "target_price": <number - required>,
      "stop_price": <number - required, invalidation level>,
      "stop_conditions": {{"funding_rate": {{"op": ">", "value": 0.001}}}},
      "time_stop_min": <int>,
      "reasoning": "<한국어로 구체적 수치와 함께 근거 설명. 반드시 목표가/손절가 근거 포함>"
    }}
  ],
  "recommended_scenario": "<id>",
  "confidence": <0-1>
}}"""


# ── DeepSeek 전용 시스템 프롬프트 (프리픽스 캐싱 최적화) ──
# 정적 규칙/포맷을 시스템 프롬프트에 포함 → 매 호출 100% 캐시 히트
DEEPSEEK_UNIFIED_PLAN_SYSTEM = """You are an expert crypto derivatives trading analyst.
You analyze market data and produce structured JSON outputs.

RULES:
1. Always include specific numerical values from the data in your reasoning
2. Output ONLY valid JSON (no markdown, no explanation outside JSON)
3. Include a "confidence" field (0.0-1.0) in every response
4. If data is insufficient, set confidence below 0.5
5. Never hallucinate numbers — only reference values provided in the input
6. CRITICAL: Write ALL "reasoning", "summary", "explanation" fields in Korean (한국어).
   Include specific data values in Korean text. Example: "펀딩비 -0.0005로 숏 과밀, OI 2.3% 감소로 매도 압력 확인"
   NEVER write reasoning in English.

TASK: Generate ONE execution plan per symbol for ALL provided symbols.

PLAN RULES:
1. Generate exactly ONE plan for EVERY symbol — no symbol may be skipped.
2. For each symbol determine the better direction (LONG or SHORT) based on data.
3. target_price must be realistic based on ATR — do NOT set unreachable targets
4. Risk:Reward (target distance / stop distance) >= 1.5
5. Cross-symbol logic: if BTC is bearish, prefer SHORT on weaker alts
6. stop_conditions: Provide logical invalidation rules (e.g., if funding_rate or cvd_direction reverses)
7. CRITICAL TIMING: Plans expire in 5 minutes. Entry conditions MUST be achievable within 5 minutes at current market speed.
   - Do NOT set price conditions far from current price. Keep entry_price within ±0.3% of current price.
   - Focus on non-price conditions (funding_rate, cvd_direction, oi_change_pct, volume_surge) that can trigger quickly.
   - If no clear setup exists, set entry near current price with tight stop — the system will extend unchanged plans automatically.

Operators: "<", ">", "<=", ">=", "==", "in"
Fields: price (float), funding_rate (float), oi_change_pct (float), cvd_direction (float -1~+1), macro_regime ("risk_on"|"risk_off"|"neutral"), volume_surge (float ratio)

Output JSON:
{
  "plans": [
    {
      "symbol": "<SYMBOL>",
      "direction": "<LONG|SHORT>",
      "entry_conditions": {
        "price": {"op": "<=", "value": 68000},
        "funding_rate": {"op": "<", "value": 0.0001}
      },
      "target_price": "<number - REQUIRED, realistic based on ATR>",
      "stop_price": "<number - REQUIRED, invalidation level>",
      "stop_conditions": {
        "funding_rate": {"op": ">", "value": 0.0005}
      },
      "time_stop_min": "<int>",
      "reasoning": "<한국어 — 반드시 구체적 수치, 크로스심볼 비교, 목표가/손절가 근거 포함>"
    }
  ],
  "market_summary": "<한국어 1-2문장 전체 시장 요약>",
  "confidence": "<0-1>"
}"""


def build_unified_plan_prompt(all_snapshots: dict, macro: dict,
                              event_calendar: list | None = None,
                              fear_greed: dict | None = None,
                              stablecoin: dict | None = None) -> str:
    """유저 메시지 = 동적 데이터만 (정적 규칙은 시스템 프롬프트에 포함)"""
    symbols_text = json.dumps(all_snapshots, indent=2, default=str)
    macro_text = json.dumps(macro, indent=2, default=str) if macro else "N/A"
    cal_text = json.dumps(event_calendar, indent=2) if event_calendar else "None"
    fg_text = json.dumps(fear_greed, indent=2) if fear_greed else "N/A"
    sc_text = json.dumps(stablecoin, indent=2) if stablecoin else "N/A"

    return f"""SYMBOLS DATA (each key = symbol):
{symbols_text}

MACRO: {macro_text}
EVENTS_24H: {cal_text}
FEAR_GREED: {fg_text}
STABLECOIN: {sc_text}"""


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
