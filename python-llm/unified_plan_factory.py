"""
@module Unified Plan Factory
@description LLM이 고를 수 있는 통합 플랜 후보를 결정론적으로 생성한다.
             LLM은 이 후보들 중에서만 선택하고, 새 조건을 발명하지 않는다.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def build_unified_plan_candidates(symbol_snapshots: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []
    for symbol, snap in symbol_snapshots.items():
        candidates.extend(_build_symbol_candidates(symbol, snap))
    return candidates


def _build_symbol_candidates(symbol: str, snap: Dict[str, Any]) -> List[Dict[str, Any]]:
    price = _num(snap.get("p"))
    if price is None or price <= 0:
        return []

    atr_pct = _num(snap.get("atr4h"))
    if atr_pct is None or atr_pct <= 0:
        atr_pct = 2.0
    atr_value = max(price * atr_pct / 100.0, price * 0.01)

    daily_bias = str(snap.get("daily_bias", "NEUTRAL")).upper()
    trend_bias_4h = str(snap.get("trend_bias_4h", "NEUTRAL")).upper()
    trigger_bias_1h = str(snap.get("trigger_bias_1h", "NEUTRAL")).upper()
    btc_daily_bias = str(snap.get("btc_daily_bias", "NEUTRAL")).upper()
    rsi14 = _num(snap.get("rsi14"), 50) or 50
    btc_mom = _num(snap.get("btc_mom"), 0) or 0

    support_distance_pct = _num(snap.get("support_distance_pct"))
    resistance_distance_pct = _num(snap.get("resistance_distance_pct"))
    pullback_atr_ratio = _num(snap.get("pullback_atr_ratio"))
    range_position_20 = _num(snap.get("range_position_20"))
    relative_strength = _num(snap.get("relative_strength_btc_12h"))

    setups = [
        _make_long_candidate(
            symbol,
            snap,
            "pullback",
            price,
            atr_value,
            daily_bias,
            trend_bias_4h,
            trigger_bias_1h,
            btc_daily_bias,
            support_distance_pct,
            pullback_atr_ratio,
            btc_mom,
            rsi14,
            relative_strength,
        ),
        _make_long_candidate(
            symbol,
            snap,
            "breakout",
            price,
            atr_value,
            daily_bias,
            trend_bias_4h,
            trigger_bias_1h,
            btc_daily_bias,
            support_distance_pct,
            pullback_atr_ratio,
            btc_mom,
            rsi14,
            relative_strength,
        ),
        _make_long_candidate(
            symbol,
            snap,
            "retest",
            price,
            atr_value,
            daily_bias,
            trend_bias_4h,
            trigger_bias_1h,
            btc_daily_bias,
            support_distance_pct,
            pullback_atr_ratio,
            btc_mom,
            rsi14,
            relative_strength,
        ),
        _make_short_candidate(
            symbol,
            snap,
            "pullback",
            price,
            atr_value,
            daily_bias,
            trend_bias_4h,
            trigger_bias_1h,
            btc_daily_bias,
            resistance_distance_pct,
            pullback_atr_ratio,
            btc_mom,
            rsi14,
            relative_strength,
        ),
        _make_short_candidate(
            symbol,
            snap,
            "breakout",
            price,
            atr_value,
            daily_bias,
            trend_bias_4h,
            trigger_bias_1h,
            btc_daily_bias,
            resistance_distance_pct,
            pullback_atr_ratio,
            btc_mom,
            rsi14,
            relative_strength,
        ),
        _make_short_candidate(
            symbol,
            snap,
            "retest",
            price,
            atr_value,
            daily_bias,
            trend_bias_4h,
            trigger_bias_1h,
            btc_daily_bias,
            resistance_distance_pct,
            pullback_atr_ratio,
            btc_mom,
            rsi14,
            relative_strength,
        ),
    ]

    viable = [c for c in setups if c is not None]
    viable.sort(key=lambda item: item.get("confidence", 0.0), reverse=True)
    return viable[:3]


def _make_long_candidate(
    symbol: str,
    snap: Dict[str, Any],
    variant: str,
    price: float,
    atr_value: float,
    daily_bias: str,
    trend_bias_4h: str,
    trigger_bias_1h: str,
    btc_daily_bias: str,
    support_distance_pct: Optional[float],
    pullback_atr_ratio: Optional[float],
    btc_mom: float,
    rsi14: float,
    relative_strength: Optional[float],
) -> Optional[Dict[str, Any]]:
    if daily_bias != "BULLISH" and trend_bias_4h != "BULLISH":
        return None
    if btc_daily_bias == "BEARISH" and btc_mom < -1.0:
        return None
    if rsi14 > 70:
        return None

    setup_field = {
        "pullback": "pullback_long_setup",
        "breakout": "breakout_long_setup",
        "retest": "retest_support_ready",
    }[variant]
    setup_value = _num(snap.get(setup_field), 0) or 0
    if variant == "pullback" and not setup_value:
        return None
    if variant == "breakout" and not setup_value:
        return None
    if variant == "retest" and not setup_value:
        return None

    entry_conditions: Dict[str, Any] = {
        "daily_bias": {"op": "==", "value": "BULLISH"},
        "trend_bias_4h": {"op": "==", "value": "BULLISH"},
        "trigger_bias_1h": {"op": "==", "value": "BULLISH"},
        setup_field: {"op": ">=", "value": 1},
    }
    stop_conditions: Dict[str, Any] = {
        "daily_bias": {"op": "==", "value": "BEARISH"},
        "trend_bias_4h": {"op": "==", "value": "BEARISH"},
        "trigger_bias_1h": {"op": "==", "value": "BEARISH"},
    }

    if variant == "pullback":
        if support_distance_pct is None or support_distance_pct > 1.75:
            return None
        if pullback_atr_ratio is None or pullback_atr_ratio > 1.9:
            return None
        entry_conditions["support_distance_pct"] = {"op": "<=", "value": round(min(support_distance_pct, 1.5), 3)}
        entry_conditions["pullback_atr_ratio"] = {"op": "<=", "value": round(max(pullback_atr_ratio, 0.8), 3)}
        stop_conditions["support_distance_pct"] = {"op": ">=", "value": 2.5}
    elif variant == "breakout":
        entry_conditions["breakout_long_setup"] = {"op": ">=", "value": 1}
        entry_conditions["range_position_20"] = {"op": ">=", "value": 0.7}
        stop_conditions["range_position_20"] = {"op": "<=", "value": 0.45}
    else:
        if support_distance_pct is None or support_distance_pct > 1.0:
            return None
        entry_conditions["retest_support_ready"] = {"op": ">=", "value": 1}
        entry_conditions["support_distance_pct"] = {"op": "<=", "value": 1.0}
        stop_conditions["support_distance_pct"] = {"op": ">=", "value": 2.0}

    target_multiplier = 2.3 if variant != "breakout" else 2.6
    target_price = round(price + atr_value * target_multiplier, 5)
    stop_price = round(price - atr_value * 1.1, 5)
    if stop_price <= 0:
        return None

    confidence = _score_candidate(
        base=0.58,
        daily_bias=daily_bias,
        trend_bias_4h=trend_bias_4h,
        trigger_bias_1h=trigger_bias_1h,
        setup_value=setup_value,
        btc_daily_bias=btc_daily_bias,
        btc_mom=btc_mom,
        relative_strength=relative_strength,
        direction="LONG",
        variant=variant,
    )
    if confidence < 0.55:
        return None

    return {
        "id": f"{symbol}:{variant}:long",
        "symbol": symbol,
        "direction": "LONG",
        "confidence": confidence,
        "entry_conditions": entry_conditions,
        "target_price": target_price,
        "stop_price": stop_price,
        "stop_conditions": stop_conditions,
        "time_stop_min": 480 if variant == "retest" else 720,
        "reasoning": _reasoning_text(symbol, "LONG", variant, daily_bias, trend_bias_4h, trigger_bias_1h, confidence),
    }


def _make_short_candidate(
    symbol: str,
    snap: Dict[str, Any],
    variant: str,
    price: float,
    atr_value: float,
    daily_bias: str,
    trend_bias_4h: str,
    trigger_bias_1h: str,
    btc_daily_bias: str,
    resistance_distance_pct: Optional[float],
    pullback_atr_ratio: Optional[float],
    btc_mom: float,
    rsi14: float,
    relative_strength: Optional[float],
) -> Optional[Dict[str, Any]]:
    if daily_bias != "BEARISH" and trend_bias_4h != "BEARISH":
        return None
    if btc_daily_bias == "BULLISH" and btc_mom > 1.0:
        return None
    if rsi14 < 30:
        return None

    setup_field = {
        "pullback": "pullback_short_setup",
        "breakout": "breakout_short_setup",
        "retest": "retest_resistance_ready",
    }[variant]
    setup_value = _num(snap.get(setup_field), 0) or 0
    if variant == "pullback" and not setup_value:
        return None
    if variant == "breakout" and not setup_value:
        return None
    if variant == "retest" and not setup_value:
        return None

    entry_conditions: Dict[str, Any] = {
        "daily_bias": {"op": "==", "value": "BEARISH"},
        "trend_bias_4h": {"op": "==", "value": "BEARISH"},
        "trigger_bias_1h": {"op": "==", "value": "BEARISH"},
        setup_field: {"op": ">=", "value": 1},
    }
    stop_conditions: Dict[str, Any] = {
        "daily_bias": {"op": "==", "value": "BULLISH"},
        "trend_bias_4h": {"op": "==", "value": "BULLISH"},
        "trigger_bias_1h": {"op": "==", "value": "BULLISH"},
    }

    if variant == "pullback":
        if resistance_distance_pct is None or resistance_distance_pct > 1.75:
            return None
        if pullback_atr_ratio is None or pullback_atr_ratio > 1.9:
            return None
        entry_conditions["resistance_distance_pct"] = {"op": "<=", "value": round(min(resistance_distance_pct, 1.5), 3)}
        entry_conditions["pullback_atr_ratio"] = {"op": "<=", "value": round(max(pullback_atr_ratio, 0.8), 3)}
        stop_conditions["resistance_distance_pct"] = {"op": ">=", "value": 2.5}
    elif variant == "breakout":
        entry_conditions["breakout_short_setup"] = {"op": ">=", "value": 1}
        entry_conditions["range_position_20"] = {"op": "<=", "value": 0.3}
        stop_conditions["range_position_20"] = {"op": ">=", "value": 0.55}
    else:
        if resistance_distance_pct is None or resistance_distance_pct > 1.0:
            return None
        entry_conditions["retest_resistance_ready"] = {"op": ">=", "value": 1}
        entry_conditions["resistance_distance_pct"] = {"op": "<=", "value": 1.0}
        stop_conditions["resistance_distance_pct"] = {"op": ">=", "value": 2.0}

    target_multiplier = 2.3 if variant != "breakout" else 2.6
    target_price = round(price - atr_value * target_multiplier, 5)
    stop_price = round(price + atr_value * 1.1, 5)
    if stop_price <= 0:
        return None

    confidence = _score_candidate(
        base=0.58,
        daily_bias=daily_bias,
        trend_bias_4h=trend_bias_4h,
        trigger_bias_1h=trigger_bias_1h,
        setup_value=setup_value,
        btc_daily_bias=btc_daily_bias,
        btc_mom=btc_mom,
        relative_strength=relative_strength,
        direction="SHORT",
        variant=variant,
    )
    if confidence < 0.55:
        return None

    return {
        "id": f"{symbol}:{variant}:short",
        "symbol": symbol,
        "direction": "SHORT",
        "confidence": confidence,
        "entry_conditions": entry_conditions,
        "target_price": target_price,
        "stop_price": stop_price,
        "stop_conditions": stop_conditions,
        "time_stop_min": 480 if variant == "retest" else 720,
        "reasoning": _reasoning_text(symbol, "SHORT", variant, daily_bias, trend_bias_4h, trigger_bias_1h, confidence),
    }


def _score_candidate(
    base: float,
    daily_bias: str,
    trend_bias_4h: str,
    trigger_bias_1h: str,
    setup_value: float,
    btc_daily_bias: str,
    btc_mom: float,
    relative_strength: Optional[float],
    direction: str,
    variant: str,
) -> float:
    score = base
    if setup_value:
        score += 0.12
    if daily_bias == ("BULLISH" if direction == "LONG" else "BEARISH"):
        score += 0.08
    if trend_bias_4h == ("BULLISH" if direction == "LONG" else "BEARISH"):
        score += 0.08
    if trigger_bias_1h == ("BULLISH" if direction == "LONG" else "BEARISH"):
        score += 0.04
    if btc_daily_bias == ("BULLISH" if direction == "LONG" else "BEARISH"):
        score += 0.03
    if direction == "LONG" and btc_mom >= 1.0:
        score += 0.03
    if direction == "SHORT" and btc_mom <= -1.0:
        score += 0.03
    if relative_strength is not None:
        if direction == "LONG" and relative_strength >= 0:
            score += 0.03
        if direction == "SHORT" and relative_strength <= 0:
            score += 0.03
    if variant == "breakout":
        score += 0.02
    elif variant == "retest":
        score += 0.01
    return round(max(0.0, min(score, 0.95)), 2)


def _reasoning_text(symbol: str, direction: str, variant: str, daily_bias: str, trend_bias_4h: str, trigger_bias_1h: str, confidence: float) -> str:
    return (
        f"{symbol} {direction} {variant} 후보. "
        f"daily={daily_bias}, 4h={trend_bias_4h}, 1h={trigger_bias_1h}, conf={confidence:.2f}"
    )


def _num(value: Any, default: Optional[float] = None) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    return default
