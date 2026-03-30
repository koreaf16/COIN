from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional


def _round(value: Optional[float], digits: int = 4) -> Optional[float]:
    if value is None:
        return None
    return round(float(value), digits)


def _ema(values: List[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    alpha = 2 / (period + 1)
    ema_value = values[0]
    for value in values[1:]:
        ema_value = value * alpha + ema_value * (1 - alpha)
    return ema_value


def _atr(candles: List[Dict[str, float]], period: int = 14) -> Optional[float]:
    if len(candles) < 2:
        return None
    recent = candles[-max(period + 1, 2):]
    trs: List[float] = []
    for i in range(1, len(recent)):
        high = recent[i]["high"]
        low = recent[i]["low"]
        prev_close = recent[i - 1]["close"]
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    if not trs:
        return None
    window = trs[-period:]
    return sum(window) / len(window)


def _bollinger(closes: List[float], period: int = 20, std_mult: float = 2.0) -> Optional[Dict[str, float]]:
    if len(closes) < period:
        return None
    window = closes[-period:]
    mean = sum(window) / period
    variance = sum((value - mean) ** 2 for value in window) / period
    std = variance ** 0.5
    return {"middle": mean, "upper": mean + std * std_mult, "lower": mean - std * std_mult}


def _pct_change(current: Optional[float], previous: Optional[float]) -> Optional[float]:
    if current is None or previous is None or previous == 0:
        return None
    return ((current - previous) / previous) * 100


def _classify_bias(
    current_price: Optional[float],
    ema_fast: Optional[float],
    ema_slow: Optional[float],
    gap_threshold_pct: float = 0.15,
) -> str:
    if (
        current_price is None
        or ema_fast is None
        or ema_slow is None
        or ema_slow == 0
    ):
        return "NEUTRAL"
    gap_pct = ((ema_fast - ema_slow) / ema_slow) * 100
    if gap_pct >= gap_threshold_pct and current_price >= ema_fast:
        return "BULLISH"
    if gap_pct <= -gap_threshold_pct and current_price <= ema_fast:
        return "BEARISH"
    return "NEUTRAL"


def _flag(condition: bool) -> int:
    return 1 if condition else 0


def _dmi_adx(candles: List[Dict[str, float]], period: int = 14) -> Dict[str, Optional[float]]:
    if len(candles) < period + 2:
        return {"adx_1h": None, "plus_di_1h": None, "minus_di_1h": None}

    trs: List[float] = []
    plus_dms: List[float] = []
    minus_dms: List[float] = []

    for i in range(1, len(candles)):
        current = candles[i]
        previous = candles[i - 1]
        up_move = current["high"] - previous["high"]
        down_move = previous["low"] - current["low"]
        plus_dms.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dms.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        trs.append(max(
            current["high"] - current["low"],
            abs(current["high"] - previous["close"]),
            abs(current["low"] - previous["close"]),
        ))

    if len(trs) < period:
        return {"adx_1h": None, "plus_di_1h": None, "minus_di_1h": None}

    atr_sum = sum(trs[:period])
    plus_sum = sum(plus_dms[:period])
    minus_sum = sum(minus_dms[:period])
    dx_values: List[float] = []
    plus_di = 0.0
    minus_di = 0.0

    for i in range(period - 1, len(trs)):
        if i > period - 1:
            atr_sum = atr_sum - atr_sum / period + trs[i]
            plus_sum = plus_sum - plus_sum / period + plus_dms[i]
            minus_sum = minus_sum - minus_sum / period + minus_dms[i]
        if atr_sum <= 0:
            continue
        plus_di = 100 * (plus_sum / atr_sum)
        minus_di = 100 * (minus_sum / atr_sum)
        denom = plus_di + minus_di
        dx_values.append(0.0 if denom <= 0 else 100 * abs(plus_di - minus_di) / denom)

    if not dx_values:
        return {"adx_1h": None, "plus_di_1h": None, "minus_di_1h": None}

    window = dx_values[: min(period, len(dx_values))]
    adx = sum(window) / len(window)
    for dx in dx_values[period:]:
        adx = ((adx * (period - 1)) + dx) / period

    return {
        "adx_1h": _round(adx, 2),
        "plus_di_1h": _round(plus_di, 2),
        "minus_di_1h": _round(minus_di, 2),
    }


def _pivot_levels(candles: List[Dict[str, float]], current_price: Optional[float], lookback: int = 40) -> Dict[str, Optional[float]]:
    if current_price is None or current_price <= 0:
        return {"support": None, "resistance": None}

    recent = candles[-lookback:]
    if len(recent) < 5:
        return {"support": None, "resistance": None}

    highs: List[float] = []
    lows: List[float] = []
    for i in range(2, len(recent) - 2):
        high = recent[i]["high"]
        low = recent[i]["low"]
        neighbor_highs = [recent[j]["high"] for j in (i - 2, i - 1, i + 1, i + 2)]
        neighbor_lows = [recent[j]["low"] for j in (i - 2, i - 1, i + 1, i + 2)]
        if high >= max(neighbor_highs):
            highs.append(high)
        if low <= min(neighbor_lows):
            lows.append(low)

    fallback_high = max(candle["high"] for candle in recent)
    fallback_low = min(candle["low"] for candle in recent)
    support_candidates = [level for level in lows if level <= current_price]
    resistance_candidates = [level for level in highs if level >= current_price]

    return {
        "support": max(support_candidates) if support_candidates else fallback_low,
        "resistance": min(resistance_candidates) if resistance_candidates else fallback_high,
    }


def _rows_to_candles(rows: Iterable[Any]) -> List[Dict[str, float]]:
    candles: List[Dict[str, float]] = []
    for row in reversed(list(rows)):
        if isinstance(row, dict):
            open_price = float(row.get("open", 0))
            high_price = float(row.get("high", 0))
            low_price = float(row.get("low", 0))
            close_price = float(row.get("close", 0))
            volume = float(row.get("volume", 0))
        else:
            open_price = float(row[0] or 0)
            high_price = float(row[1] or 0)
            low_price = float(row[2] or 0)
            close_price = float(row[3] or 0)
            volume = float(row[4] or 0)
        candles.append({
            "open": open_price,
            "high": high_price,
            "low": low_price,
            "close": close_price,
            "volume": volume,
        })
    return candles


def build_market_structure(
    rows_1h: Iterable[Any],
    rows_4h: Iterable[Any],
    rows_1d: Optional[Iterable[Any]],
    btc_rows_1h: Iterable[Any],
    btc_rows_1d: Optional[Iterable[Any]],
    current_price: Optional[float],
) -> Dict[str, Any]:
    candles_1h = _rows_to_candles(rows_1h)
    candles_4h = _rows_to_candles(rows_4h)
    candles_1d = _rows_to_candles(rows_1d or [])
    btc_candles_1h = _rows_to_candles(btc_rows_1h)
    btc_candles_1d = _rows_to_candles(btc_rows_1d or [])

    closes_1h = [candle["close"] for candle in candles_1h]
    closes_4h = [candle["close"] for candle in candles_4h]
    closes_1d = [candle["close"] for candle in candles_1d]
    price = current_price if current_price and current_price > 0 else (closes_1h[-1] if closes_1h else None)

    ema20_1h = _ema(closes_1h, 20)
    ema50_1h = _ema(closes_1h, 50)
    ema20_4h = _ema(closes_4h, 20)
    ema50_4h = _ema(closes_4h, 50)
    ema20_1d = _ema(closes_1d, 20)
    ema50_1d = _ema(closes_1d, 50)
    atr_1h = _atr(candles_1h, 14)
    bb = _bollinger(closes_1h, 20)
    pivots = _pivot_levels(candles_1h, price)
    dmi = _dmi_adx(candles_1h, 14)

    donchian_upper = None
    donchian_lower = None
    donchian_break = "NONE"
    if len(candles_1h) >= 21:
        previous_window = candles_1h[-21:-1]
        donchian_upper = max(candle["high"] for candle in previous_window)
        donchian_lower = min(candle["low"] for candle in previous_window)
        latest_close = closes_1h[-1]
        if latest_close > donchian_upper:
            donchian_break = "UP"
        elif latest_close < donchian_lower:
            donchian_break = "DOWN"

    range_position = None
    if len(candles_1h) >= 20 and price:
        range_window = candles_1h[-20:]
        range_high = max(candle["high"] for candle in range_window)
        range_low = min(candle["low"] for candle in range_window)
        span = range_high - range_low
        range_position = ((price - range_low) / span) if span > 0 else 0.5

    own_12h = _pct_change(closes_1h[-1], closes_1h[-13]) if len(closes_1h) >= 13 else None
    btc_closes_1h = [candle["close"] for candle in btc_candles_1h]
    btc_closes_1d = [candle["close"] for candle in btc_candles_1d]
    btc_12h = _pct_change(btc_closes_1h[-1], btc_closes_1h[-13]) if len(btc_closes_1h) >= 13 else own_12h
    btc_price_1d = btc_closes_1d[-1] if btc_closes_1d else (btc_closes_1h[-1] if btc_closes_1h else None)
    btc_ema20_1d = _ema(btc_closes_1d, 20)
    btc_ema50_1d = _ema(btc_closes_1d, 50)

    ema_gap_1h = ((ema20_1h - ema50_1h) / ema50_1h) * 100 if ema20_1h and ema50_1h else None
    ema_gap_4h = ((ema20_4h - ema50_4h) / ema50_4h) * 100 if ema20_4h and ema50_4h else None
    ema_gap_1d = ((ema20_1d - ema50_1d) / ema50_1d) * 100 if ema20_1d and ema50_1d else None
    pullback_atr_ratio = abs(price - ema20_1h) / atr_1h if price and atr_1h and ema20_1h else None
    support_distance_pct = ((price - pivots["support"]) / price) * 100 if price and pivots["support"] else None
    resistance_distance_pct = ((pivots["resistance"] - price) / price) * 100 if price and pivots["resistance"] else None
    daily_bias = _classify_bias(price, ema20_1d, ema50_1d, 0.2)
    trend_bias_4h = _classify_bias(price, ema20_4h, ema50_4h, 0.1)
    trigger_bias_1h = _classify_bias(price, ema20_1h, ema50_1h, 0.05)
    btc_daily_bias = _classify_bias(btc_price_1d, btc_ema20_1d, btc_ema50_1d, 0.2)

    retest_support_ready = support_distance_pct is not None and support_distance_pct <= 1.0
    retest_resistance_ready = resistance_distance_pct is not None and resistance_distance_pct <= 1.0
    pullback_long_setup = (
        daily_bias == "BULLISH"
        and trend_bias_4h == "BULLISH"
        and support_distance_pct is not None
        and support_distance_pct <= 1.5
        and pullback_atr_ratio is not None
        and pullback_atr_ratio <= 1.75
    )
    pullback_short_setup = (
        daily_bias == "BEARISH"
        and trend_bias_4h == "BEARISH"
        and resistance_distance_pct is not None
        and resistance_distance_pct <= 1.5
        and pullback_atr_ratio is not None
        and pullback_atr_ratio <= 1.75
    )
    breakout_long_setup = (
        trend_bias_4h == "BULLISH"
        and donchian_break == "UP"
        and range_position is not None
        and range_position >= 0.75
    )
    breakout_short_setup = (
        trend_bias_4h == "BEARISH"
        and donchian_break == "DOWN"
        and range_position is not None
        and range_position <= 0.25
    )

    return {
        "ema20_1h": _round(ema20_1h, 5),
        "ema50_1h": _round(ema50_1h, 5),
        "ema20_4h": _round(ema20_4h, 5),
        "ema50_4h": _round(ema50_4h, 5),
        "ema20_1d": _round(ema20_1d, 5),
        "ema50_1d": _round(ema50_1d, 5),
        "ema_gap_1h": _round(ema_gap_1h, 3),
        "ema_gap_4h": _round(ema_gap_4h, 3),
        "ema_gap_1d": _round(ema_gap_1d, 3),
        "ema_fast_above_slow_1h": 1 if ema20_1h and ema50_1h and ema20_1h >= ema50_1h else -1 if ema20_1h and ema50_1h else 0,
        "ema_fast_above_slow_4h": 1 if ema20_4h and ema50_4h and ema20_4h >= ema50_4h else -1 if ema20_4h and ema50_4h else 0,
        "ema_fast_above_slow_1d": 1 if ema20_1d and ema50_1d and ema20_1d >= ema50_1d else -1 if ema20_1d and ema50_1d else 0,
        "daily_bias": daily_bias,
        "trend_bias_4h": trend_bias_4h,
        "trigger_bias_1h": trigger_bias_1h,
        "btc_daily_bias": btc_daily_bias,
        "atr_1h": _round(atr_1h, 5),
        "pullback_atr_ratio": _round(pullback_atr_ratio, 3),
        "bb_pos_1h": _round((price - bb["lower"]) / (bb["upper"] - bb["lower"]), 3) if price and bb and (bb["upper"] - bb["lower"]) > 0 else None,
        "bb_width_1h": _round(((bb["upper"] - bb["lower"]) / bb["middle"]) * 100, 3) if bb and bb["middle"] else None,
        "donchian_upper_20": _round(donchian_upper, 5),
        "donchian_lower_20": _round(donchian_lower, 5),
        "donchian_break_20": donchian_break,
        "range_position_20": _round(range_position, 3),
        "support_level_1h": _round(pivots["support"], 5),
        "resistance_level_1h": _round(pivots["resistance"], 5),
        "support_distance_pct": _round(support_distance_pct, 3),
        "resistance_distance_pct": _round(resistance_distance_pct, 3),
        "retest_support_ready": _flag(retest_support_ready),
        "retest_resistance_ready": _flag(retest_resistance_ready),
        "pullback_long_setup": _flag(pullback_long_setup),
        "pullback_short_setup": _flag(pullback_short_setup),
        "breakout_long_setup": _flag(breakout_long_setup),
        "breakout_short_setup": _flag(breakout_short_setup),
        "price_change_12h_pct": _round(own_12h, 3),
        "relative_strength_btc_12h": _round(own_12h - btc_12h, 3) if own_12h is not None and btc_12h is not None else None,
        **dmi,
    }
