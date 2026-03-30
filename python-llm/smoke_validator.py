import json

from llm_utils import extract_selected_id
from validator_fixed import validate_response, validate_unified_plan_response


def main() -> None:
    assert extract_selected_id('{"selected_id":"LTCUSDT:retest:short"}') == "LTCUSDT:retest:short"
    assert extract_selected_id('analysis first {"selected_id":"BNBUSDT:pullback:short","reasoning":"skip"}') == "BNBUSDT:pullback:short"
    assert extract_selected_id("selected_id: \"ETHUSDT:retest:short\"") == "ETHUSDT:retest:short"

    snapshot = {
        "price": 100,
        "funding_rate": 0.0002,
        "open_interest": 12345,
    }

    valid = {
        "confidence": 0.9,
        "scenarios": [{
            "direction": "LONG",
            "entry_conditions": [
                {"field": "price", "op": ">", "value": 95},
                {"field": "cvd_direction", "op": ">", "value": 0.1},
            ],
            "stop_conditions": {"cvd_direction": {"op": "<", "value": -0.2}},
            "target_price": 110,
            "stop_price": 97,
            "time_stop_min": 240,
            "funding_rate": 0.0002,
            "open_interest": 12345,
        }],
    }

    invalid = {
        "confidence": 0.9,
        "scenarios": [{
            "direction": "LONG",
            "entry_conditions": {"field": {"op": ">", "value": 0}},
            "stop_conditions": {},
            "target_price": 110,
            "stop_price": 99,
            "time_stop_min": 240,
        }],
    }

    valid_result = validate_response(valid, snapshot, "scenario")
    invalid_result = validate_response(invalid, snapshot, "scenario")

    unified = {
        "confidence": 0.9,
        "plan": {
            "symbol": "BTCUSDT",
            "direction": "LONG",
            "confidence": 0.82,
            "entry_conditions": {
                "daily_bias": {"op": "==", "value": "BULLISH"},
                "trend_bias_4h": {"op": "==", "value": "BULLISH"},
                "trigger_bias_1h": {"op": "==", "value": "BULLISH"},
                "breakout_long_setup": {"op": ">=", "value": 1},
                "price": {"op": ">", "value": 100},
            },
            "stop_conditions": {"cvd_direction": {"op": "<", "value": -0.2}},
            "target_price": 106,
            "stop_price": 97,
            "time_stop_min": 240,
        },
    }
    unified_snapshots = {
        "BTCUSDT": {"p": 100, "fr": 0.0002, "daily_bias": "BULLISH", "trend_bias_4h": "BULLISH", "trigger_bias_1h": "BULLISH"},
    }
    unified_result = validate_unified_plan_response(unified, unified_snapshots)

    assert valid_result["valid"] is True
    assert invalid_result["valid"] is False
    assert unified_result["valid"] is True
    assert unified_result["result"]["plan"] is not None
    assert any("CRITICAL" in w for w in invalid_result.get("warnings", []))

    print(json.dumps({
        "valid": valid_result["valid"],
        "invalid": invalid_result["valid"],
        "unified_valid": unified_result["valid"],
    }))
    print("smoke_validator ok")


if __name__ == "__main__":
    main()
