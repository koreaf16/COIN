"""
Z2 Validator — LLM 출력 크로스체크 + confidence 필터
할루시네이션 방지: LLM이 출력한 수치를 Oracle 실제 값과 비교
"""
from config import CONFIDENCE_THRESHOLD


def validate_response(result: dict, snapshot: dict, task_type: str) -> dict:
    """
    LLM 결과를 검증하고 confidence 필터 적용.
    Returns: { valid: bool, result: dict, warnings: list }
    """
    warnings = []

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

    # 3. 방향 일관성 체크 (시나리오에서 방향과 조건이 일치하는지)
    if task_type == "scenario":
        warnings.extend(_check_direction_consistency(result))

    return {
        "valid": True,
        "result": result,
        "warnings": warnings,
    }


def _crosscheck_numbers(result: dict, snapshot: dict) -> list:
    """LLM이 언급한 주요 수치를 실제 데이터와 비교"""
    warnings = []

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


def _check_direction_consistency(result: dict) -> list:
    """시나리오의 방향과 조건이 일치하는지"""
    warnings = []
    scenarios = result.get("scenarios", [])

    for i, scenario in enumerate(scenarios):
        direction = scenario.get("direction", "").upper()
        conditions = scenario.get("entry_conditions", {})

        if direction == "LONG":
            fr = conditions.get("funding_rate", {})
            if fr.get("op") == ">" and fr.get("value", 0) > 0.001:
                warnings.append(f"Scenario {i+1}: LONG with positive funding requirement seems contradictory")
        elif direction == "SHORT":
            fr = conditions.get("funding_rate", {})
            if fr.get("op") == "<" and fr.get("value", 0) < -0.001:
                warnings.append(f"Scenario {i+1}: SHORT with negative funding requirement seems contradictory")

    return warnings


def filter_low_confidence(result: dict) -> bool:
    """confidence가 임계치 미만이면 True (패스해야 함)"""
    return result.get("confidence", 0) < CONFIDENCE_THRESHOLD
