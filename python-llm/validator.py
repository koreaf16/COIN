"""
@module Validator
@description LLM 출력 결과를 실제 시장 데이터와 비교하여 검증하고 신뢰도를 평가한다.
             할루시네이션(수치 조작) 방지 및 리스크 관리 규칙(손익비 등)을 체크한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ LLM      │ ──→ │ Validator│ ──→ │ Final    │
│ Response │     │          │     │ Decision │
└──────────┘     └──────────┘     └──────────┘
      ↑               ↑
  Market Data    Safety Rules

@dependencies config.py
"""
import logging
from typing import Dict, List, Any, Tuple
from config import CONFIDENCE_THRESHOLD

# 로거 설정
logger = logging.getLogger(__name__)


def _normalize_conditions(cond: Any) -> Dict[str, Any]:
    if not cond or not isinstance(cond, dict):
        return {}

    keys = set(cond.keys())
    if keys == {"field"}:
        maybe = cond.get("field")
        if isinstance(maybe, dict) and "op" in maybe and "value" in maybe:
            return {}

    if "field" in keys and "op" in keys and "value" in keys and isinstance(cond.get("field"), str):
        return {cond["field"]: {"op": cond["op"], "value": cond["value"]}}

    return cond


def _has_valid_conditions(cond: Any) -> bool:
    if not cond or not isinstance(cond, dict):
        return False
    for v in cond.values():
        if isinstance(v, dict) and "op" in v and "value" in v:
            return True
    return False

def validate_response(result: Dict[str, Any], snapshot: Dict[str, Any], task_type: str) -> Dict[str, Any]:
    """
    LLM 결과를 검증하고 confidence 필터를 적용한다.
    
    Returns:
        Dict: { valid: bool, result: dict, warnings: list }
    """
    warnings: List[str] = []

    if not result:
        return {"valid": False, "result": {}, "warnings": ["LLM returned empty response"]}

    # 1. confidence 필터
    confidence = result.get("confidence", 0)
    if confidence < CONFIDENCE_THRESHOLD:
        return {
            "valid": False,
            "result": result,
            "warnings": [f"Confidence {confidence} < threshold {CONFIDENCE_THRESHOLD}"],
        }

    # 2. 수치 크로스체크 (LLM이 언급한 수치가 실제와 크게 다르면 경고)
    if task_type in ("briefing", "scenario"):
        warnings.extend(_crosscheck_numbers(result, snapshot))

    # 3. 방향 및 리스크 일관성 체크
    if task_type == "scenario":
        consistency_warnings = _check_risk_and_direction(result, snapshot)
        warnings.extend(consistency_warnings)
        if any("CRITICAL" in w for w in consistency_warnings):
             return {
                "valid": False,
                "result": result,
                "warnings": warnings,
            }

    return {
        "valid": True,
        "result": result,
        "warnings": warnings,
    }

def _crosscheck_numbers(result: Dict[str, Any], snapshot: Dict[str, Any]) -> List[str]:
    """LLM이 언급한 주요 수치를 실제 데이터와 비교하여 불일치를 찾아낸다."""
    warnings: List[str] = []

    # 펀딩비 체크
    llm_funding = result.get("funding_rate")
    actual_funding = snapshot.get("funding_rate")
    if llm_funding is not None and actual_funding is not None:
        if abs(llm_funding - actual_funding) > 0.001:
            warnings.append(
                f"Funding rate mismatch: LLM={llm_funding}, actual={actual_funding}"
            )

    # OI 체크
    llm_oi = result.get("open_interest")
    actual_oi = snapshot.get("open_interest")
    if llm_oi is not None and actual_oi is not None and actual_oi > 0:
        ratio = abs(llm_oi - actual_oi) / actual_oi
        if ratio > 0.1:  # 10% 이상 차이
            warnings.append(
                f"OI mismatch: LLM={llm_oi}, actual={actual_oi} (diff={ratio:.1%})"
            )

    return warnings

def _check_risk_and_direction(result: Dict[str, Any], snapshot: Dict[str, Any]) -> List[str]:
    """시나리오의 방향, 조건, 그리고 리스크 관리(손절가 거리, 손익비)를 검증한다."""
    warnings: List[str] = []
    scenarios = result.get("scenarios", [])
    current_price = snapshot.get("price", 0)

    for i, scenario in enumerate(scenarios):
        direction = scenario.get("direction", "").upper()
        conditions = scenario.get("entry_conditions", {})
        target_price = scenario.get("target_price")
        stop_price = scenario.get("stop_price")

        # 1. 방향성-조건 일치 여부
        if direction == "LONG":
            fr = conditions.get("funding_rate", {})
            if fr.get("op") == ">" and fr.get("value", 0) > 0.001:
                warnings.append(f"Scenario {i+1}: LONG with positive funding requirement seems contradictory")
        elif direction == "SHORT":
            fr = conditions.get("funding_rate", {})
            if fr.get("op") == "<" and fr.get("value", 0) < -0.001:
                warnings.append(f"Scenario {i+1}: SHORT with negative funding requirement seems contradictory")

        # 2. 리스크 관리 검증 (SWING 규칙)
        if current_price > 0 and target_price and stop_price:
            entry_price = current_price
            
            # 손절가 거리 체크 (최소 1.0%)
            stop_dist_pct = abs(entry_price - stop_price) / entry_price * 100
            if stop_dist_pct < 1.0:
                warnings.append(f"CRITICAL: Scenario {i+1} stop distance too tight ({stop_dist_pct:.2f}% < 1.0%)")
            
            # 손익비(R:R) 체크 (최소 2.0)
            reward = abs(target_price - entry_price)
            risk = abs(entry_price - stop_price)
            if risk > 0:
                rr_ratio = reward / risk
                if rr_ratio < 2.0:
                    warnings.append(f"CRITICAL: Scenario {i+1} R:R ratio too low ({rr_ratio:.2f} < 2.0)")
            
            # 타겟가 도달 가능성 (최대 10%)
            target_dist_pct = abs(target_price - entry_price) / entry_price * 100
            if target_dist_pct > 10.0:
                warnings.append(f"Scenario {i+1} target too far ({target_dist_pct:.2f}% > 10%)")

    return warnings

def filter_low_confidence(result: Dict[str, Any]) -> bool:
    """confidence가 임계치 미만이면 True를 반환하여 해당 결과를 무시하게 한다."""
    return result.get("confidence", 0) < CONFIDENCE_THRESHOLD
