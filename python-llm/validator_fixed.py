"""
Validator for LLM outputs.

This version normalizes the trading condition schema used by the executor:
- flat form: {"price": {"op": "<", "value": 0}}
- legacy form: {"field": "price", "op": "<", "value": 0}
- arrays of conditions are also accepted.
"""
import logging
from typing import Dict, List, Any

from config import CONFIDENCE_THRESHOLD

logger = logging.getLogger(__name__)

HIGHER_TIMEFRAME_FIELDS = {
    "daily_bias",
    "trend_bias_4h",
    "btc_daily_bias",
}

TRIGGER_FIELDS = {
    "trigger_bias_1h",
    "pullback_long_setup",
    "pullback_short_setup",
    "breakout_long_setup",
    "breakout_short_setup",
    "retest_support_ready",
    "retest_resistance_ready",
    "support_distance_pct",
    "resistance_distance_pct",
    "range_position_20",
    "donchian_break_20",
    "relative_strength_btc_12h",
    "pullback_atr_ratio",
    "ema_gap_4h",
    "ema_gap_1d",
    "ema_fast_above_slow_4h",
    "ema_fast_above_slow_1d",
}

LONG_ONLY_SETUP_FIELDS = {
    "pullback_long_setup",
    "breakout_long_setup",
    "retest_support_ready",
}

SHORT_ONLY_SETUP_FIELDS = {
    "pullback_short_setup",
    "breakout_short_setup",
    "retest_resistance_ready",
}


def _normalize_conditions(cond: Any) -> Dict[str, Any]:
    if not cond:
        return {}

    if isinstance(cond, list):
        normalized: Dict[str, Any] = {}
        for item in cond:
            if not isinstance(item, dict):
                continue
            field = item.get("field")
            op = item.get("op")
            value = item.get("value")
            if isinstance(field, str) and field and op and "value" in item:
                normalized[field] = {"op": op, "value": value}
        return normalized

    if not isinstance(cond, dict):
        return {}

    keys = set(cond.keys())
    if keys == {"field"}:
        nested = cond.get("field")
        if isinstance(nested, dict) and "op" in nested and "value" in nested:
            return {}

    if "field" in keys and "op" in keys and "value" in keys and isinstance(cond.get("field"), str):
        return {cond["field"]: {"op": cond["op"], "value": cond["value"]}}

    return cond


def _has_valid_conditions(cond: Any) -> bool:
    if not cond or not isinstance(cond, dict):
        return False
    if set(cond.keys()) == {"field"}:
        return False
    return any(isinstance(v, dict) and "op" in v and "value" in v for v in cond.values())


def validate_response(result: Dict[str, Any], snapshot: Dict[str, Any], task_type: str) -> Dict[str, Any]:
    warnings: List[str] = []

    if not result:
        return {"valid": False, "result": {}, "warnings": ["LLM returned empty response"]}

    confidence = result.get("confidence", 0)
    if confidence < CONFIDENCE_THRESHOLD:
        return {
            "valid": False,
            "result": result,
            "warnings": [f"Confidence {confidence} < threshold {CONFIDENCE_THRESHOLD}"],
        }

    if task_type in ("briefing", "scenario"):
        warnings.extend(_crosscheck_numbers(result, snapshot))

    if task_type == "scenario":
        consistency_warnings = _check_risk_and_direction(result, snapshot)
        warnings.extend(consistency_warnings)
        if any(w.startswith("CRITICAL:") for w in consistency_warnings):
            return {"valid": False, "result": result, "warnings": warnings}

    return {"valid": True, "result": result, "warnings": warnings}


def validate_unified_plan_response(result: Dict[str, Any], snapshots: Dict[str, Any]) -> Dict[str, Any]:
    warnings: List[str] = []

    if not result:
        return {"valid": False, "result": {"plan": None}, "warnings": ["LLM returned empty response"]}

    plan = result.get("plan") if isinstance(result.get("plan"), dict) else None
    if not plan:
        filtered = dict(result)
        filtered["plan"] = None
        return {"valid": False, "result": filtered, "warnings": ["LLM returned empty plan"]}

    plan_warnings = _check_plan_item(
        plan,
        _normalize_unified_snapshot(snapshots.get(plan.get("symbol"), {})),
        "Plan",
        require_structure=True,
    )
    warnings.extend(plan_warnings)

    filtered = dict(result)
    filtered["plan"] = plan if not any(w.startswith("CRITICAL:") for w in plan_warnings) else None
    return {"valid": filtered["plan"] is not None, "result": filtered, "warnings": warnings}


def _crosscheck_numbers(result: Dict[str, Any], snapshot: Dict[str, Any]) -> List[str]:
    warnings: List[str] = []

    llm_funding = result.get("funding_rate")
    actual_funding = snapshot.get("funding_rate")
    if llm_funding is not None and actual_funding is not None:
        if abs(llm_funding - actual_funding) > 0.001:
            warnings.append(f"Funding rate mismatch: LLM={llm_funding}, actual={actual_funding}")

    llm_oi = result.get("open_interest")
    actual_oi = snapshot.get("open_interest")
    if llm_oi is not None and actual_oi is not None and actual_oi > 0:
        ratio = abs(llm_oi - actual_oi) / actual_oi
        if ratio > 0.1:
            warnings.append(f"OI mismatch: LLM={llm_oi}, actual={actual_oi} (diff={ratio:.1%})")

    return warnings


def _check_risk_and_direction(result: Dict[str, Any], snapshot: Dict[str, Any]) -> List[str]:
    warnings: List[str] = []
    scenarios = result.get("scenarios", [])
    current_price = snapshot.get("price", 0)

    for i, scenario in enumerate(scenarios):
        warnings.extend(_check_plan_item(scenario, snapshot, f"Scenario {i+1}", require_structure=False))

    return warnings


def _normalize_unified_snapshot(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    if not snapshot:
        return {}

    normalized = dict(snapshot)
    if "price" not in normalized and "p" in normalized:
        normalized["price"] = normalized["p"]
    if "funding_rate" not in normalized and "fr" in normalized:
        normalized["funding_rate"] = normalized["fr"]
    if "cvd_direction" not in normalized and "cvd_dir" in normalized:
        normalized["cvd_direction"] = normalized["cvd_dir"]
    if "volume_surge" not in normalized and "v_surge" in normalized:
        normalized["volume_surge"] = normalized["v_surge"]
    return normalized


def _has_any_condition_field(conditions: Dict[str, Any], fields: set[str]) -> bool:
    return any(field in fields for field in conditions.keys())


def _condition_targets_value(condition: Any, expected_value: str) -> bool:
    if not isinstance(condition, dict):
        return False

    op = condition.get("op")
    value = condition.get("value")
    expected = expected_value.upper()

    if op == "in" and isinstance(value, list):
        return any(str(v).upper() == expected for v in value)
    if op in ("==", ">=", "<=") and isinstance(value, str):
        return value.upper() == expected
    return False


def _append_issue(warnings: List[str], label: str, message: str, critical: bool) -> None:
    prefix = "CRITICAL: " if critical else ""
    warnings.append(f"{prefix}{label} {message}")


def _check_structure_requirements(
    direction: str,
    conditions: Dict[str, Any],
    snapshot: Dict[str, Any],
    label: str,
    confidence: float,
    require_structure: bool,
) -> List[str]:
    warnings: List[str] = []
    critical = require_structure

    if not _has_any_condition_field(conditions, HIGHER_TIMEFRAME_FIELDS):
        _append_issue(warnings, label, "is missing higher timeframe structure in entry_conditions", critical)

    if not _has_any_condition_field(conditions, TRIGGER_FIELDS):
        _append_issue(warnings, label, "is missing trigger structure in entry_conditions", critical)

    if direction == "LONG" and _has_any_condition_field(conditions, SHORT_ONLY_SETUP_FIELDS):
        warnings.append(f"CRITICAL: {label} LONG uses short-only setup fields")
    if direction == "SHORT" and _has_any_condition_field(conditions, LONG_ONLY_SETUP_FIELDS):
        warnings.append(f"CRITICAL: {label} SHORT uses long-only setup fields")

    opposing_bias = "BEARISH" if direction == "LONG" else "BULLISH"
    for field in ("daily_bias", "trend_bias_4h", "trigger_bias_1h", "btc_daily_bias"):
        if _condition_targets_value(conditions.get(field), opposing_bias):
            warnings.append(f"CRITICAL: {label} {field} contradicts {direction}")

    allow_aggressive_countertrend = confidence >= 0.9
    if direction == "LONG":
        if snapshot.get("daily_bias") == "BEARISH" and not allow_aggressive_countertrend:
            warnings.append(f"CRITICAL: {label} current daily_bias is BEARISH")
        if snapshot.get("trend_bias_4h") == "BEARISH" and not allow_aggressive_countertrend:
            warnings.append(f"CRITICAL: {label} current trend_bias_4h is BEARISH")
    if direction == "SHORT":
        if snapshot.get("daily_bias") == "BULLISH" and not allow_aggressive_countertrend:
            warnings.append(f"CRITICAL: {label} current daily_bias is BULLISH")
        if snapshot.get("trend_bias_4h") == "BULLISH" and not allow_aggressive_countertrend:
            warnings.append(f"CRITICAL: {label} current trend_bias_4h is BULLISH")

    return warnings


def _check_plan_item(plan: Dict[str, Any], snapshot: Dict[str, Any], label: str, require_structure: bool = False) -> List[str]:
    warnings: List[str] = []
    direction = str(plan.get("direction", "")).upper()
    conditions = _normalize_conditions(plan.get("entry_conditions", {}))
    stop_conditions = _normalize_conditions(plan.get("stop_conditions", {}))
    target_raw = plan.get("target_price")
    stop_raw = plan.get("stop_price")
    time_stop_raw = plan.get("time_stop_min")
    target_price = float(target_raw) if isinstance(target_raw, (int, float)) else None
    stop_price = float(stop_raw) if isinstance(stop_raw, (int, float)) else None
    time_stop_min = float(time_stop_raw) if isinstance(time_stop_raw, (int, float)) else None
    current_price = snapshot.get("price", 0)

    if direction not in ("LONG", "SHORT"):
        warnings.append(f"CRITICAL: {label} direction is invalid")
        return warnings

    if not _has_valid_conditions(conditions):
        warnings.append(f"CRITICAL: {label} has invalid or empty entry_conditions")
        return warnings

    if not _has_valid_conditions(stop_conditions):
        warnings.append(f"CRITICAL: {label} stop_conditions are missing or invalid")

    confidence_raw = plan.get("confidence", plan.get("probability"))
    confidence = float(confidence_raw) if isinstance(confidence_raw, (int, float)) else None
    if confidence is not None and confidence < 0.55:
        warnings.append(f"CRITICAL: {label} confidence too low ({confidence} < 0.55)")

    warnings.extend(_check_structure_requirements(direction, conditions, snapshot, label, confidence or 0.0, require_structure))

    if time_stop_min is None or not isinstance(time_stop_min, (int, float)) or time_stop_min < 240 or time_stop_min > 2880:
        warnings.append(f"CRITICAL: {label} time_stop_min out of range")

    if direction == "LONG":
        fr = conditions.get("funding_rate", {})
        if fr.get("op") == ">" and fr.get("value", 0) > 0.001:
            warnings.append(f"{label}: LONG with positive funding requirement seems contradictory")
    elif direction == "SHORT":
        fr = conditions.get("funding_rate", {})
        if fr.get("op") == "<" and fr.get("value", 0) < -0.001:
            warnings.append(f"{label}: SHORT with negative funding requirement seems contradictory")

    if current_price > 0 and target_price is not None and stop_price is not None:
        entry_price = _resolve_entry_price(conditions, current_price)
        stop_dist_pct = abs(entry_price - stop_price) / entry_price * 100
        if stop_dist_pct < 1.0:
            warnings.append(f"CRITICAL: {label} stop distance too tight ({stop_dist_pct:.2f}% < 1.0%)")

        reward = abs(target_price - entry_price)
        risk = abs(entry_price - stop_price)
        if risk > 0:
            rr_ratio = reward / risk
            if rr_ratio < 2.0:
                warnings.append(f"CRITICAL: {label} R:R ratio too low ({rr_ratio:.2f} < 2.0)")

        target_dist_pct = abs(target_price - entry_price) / entry_price * 100
        if target_dist_pct > 10.0:
            warnings.append(f"{label} target too far ({target_dist_pct:.2f}% > 10%)")
    else:
        warnings.append(f"CRITICAL: {label} target_price or stop_price is missing")

    return warnings


def _resolve_entry_price(conditions: Dict[str, Any], current_price: float) -> float:
    price_condition = conditions.get("price", {})
    if isinstance(price_condition, dict) and isinstance(price_condition.get("value"), (int, float)):
        return price_condition["value"]
    return current_price


def filter_low_confidence(result: Dict[str, Any]) -> bool:
    return result.get("confidence", 0) < CONFIDENCE_THRESHOLD
