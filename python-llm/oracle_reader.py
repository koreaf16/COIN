"""
Z2 Oracle Reader — DB에서 최신 지표/유사사례 조회 (UTC 강제)
"""
import oracledb
from config import ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING, ORACLE_INSTANT_CLIENT_PATH

_pool = None


def init_pool():
    global _pool
    if _pool:
        return
    if ORACLE_INSTANT_CLIENT_PATH:
        oracledb.init_oracle_client(lib_dir=ORACLE_INSTANT_CLIENT_PATH)

    def _session_cb(conn, requested_tag):
        conn.cursor().execute("ALTER SESSION SET TIME_ZONE = 'UTC'")

    _pool = oracledb.create_pool(
        user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_CONNECT_STRING,
        min=1, max=5,
        session_callback=_session_cb,
    )


def get_pool():
    if not _pool:
        init_pool()
    return _pool


def _query(sql, params=None):
    """UTC 세션으로 쿼리 실행"""
    with get_pool().acquire() as conn:
        cur = conn.cursor()
        cur.execute("ALTER SESSION SET TIME_ZONE = 'UTC'")
        cur.execute(sql, params or {})
        return cur.fetchall()


def _query_one(sql, params=None):
    rows = _query(sql, params)
    return rows[0] if rows else None


async def get_market_snapshot(symbol: str) -> dict:
    """심볼의 현재 시장 스냅샷"""
    snapshot = {}

    rows = _query(
        "SELECT close_price, volume FROM z0_price_ohlcv "
        "WHERE symbol = :sym AND timeframe = '1m' ORDER BY ts DESC FETCH FIRST 6 ROWS ONLY",
        {"sym": symbol})
    if rows:
        snapshot["price"] = float(rows[0][0])
        snapshot["volume_1m"] = float(rows[0][1])
        if len(rows) >= 2:
            avg_vol = sum(float(r[1] or 0) for r in rows[1:]) / (len(rows) - 1)
            latest_vol = float(rows[0][1] or 0)
            snapshot["volume_surge"] = round(latest_vol / avg_vol, 2) if avg_vol > 0 else 1.0

    r = _query_one(
        "SELECT open_interest, oi_change_pct, funding_rate, predicted_rate, "
        "long_ratio, short_ratio, liq_long_24h, liq_short_24h "
        "FROM z0_derivatives WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY",
        {"sym": symbol})
    if r:
        snapshot["open_interest"] = float(r[0] or 0)
        snapshot["oi_change_pct"] = float(r[1] or 0)
        snapshot["funding_rate"] = float(r[2] or 0)
        snapshot["predicted_funding"] = float(r[3] or 0)
        snapshot["long_ratio"] = float(r[4] or 0)
        snapshot["short_ratio"] = float(r[5] or 0)
        snapshot["liq_long_24h"] = float(r[6] or 0)
        snapshot["liq_short_24h"] = float(r[7] or 0)

    r = _query_one(
        "SELECT cvd, volume FROM z0_price_ohlcv WHERE symbol = :sym AND timeframe = '1h' "
        "ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"sym": symbol})
    if r:
        cvd_raw = float(r[0] or 0)
        vol_1h = float(r[1] or 0)
        snapshot["cvd_1h"] = cvd_raw
        snapshot["cvd_direction"] = round(cvd_raw / vol_1h, 3) if vol_1h > 0 else 0.0

    # ── 4h 캔들 추세/ATR (스윙 핵심) ──
    rows_4h = _query(
        "SELECT high_price, low_price, close_price FROM ("
        "  SELECT high_price, low_price, close_price FROM z0_price_ohlcv"
        "  WHERE symbol = :sym AND timeframe = '4h'"
        "  ORDER BY ts DESC FETCH FIRST 20 ROWS ONLY"
        ") ORDER BY ROWNUM",
        {"sym": symbol})
    if rows_4h and len(rows_4h) >= 5:
        closes_4h = [float(r[2]) for r in rows_4h]
        # 4h ATR (최근 14봉)
        atr_bars = rows_4h[-min(14, len(rows_4h)):]
        atr_sum = sum(float(r[0]) - float(r[1]) for r in atr_bars)
        atr_4h = atr_sum / len(atr_bars)
        snapshot["atr_4h"] = round(atr_4h, 5)
        if closes_4h[-1] > 0:
            snapshot["atr_4h_pct"] = round(atr_4h / closes_4h[-1] * 100, 3)
        # 4h 추세 (EMA 12 vs EMA 26)
        if len(closes_4h) >= 12:
            ema12 = closes_4h[0]
            k12 = 2 / 13
            for p in closes_4h[1:]:
                ema12 = p * k12 + ema12 * (1 - k12)
            ema26 = closes_4h[0]
            k26 = 2 / 27
            for p in closes_4h[1:]:
                ema26 = p * k26 + ema26 * (1 - k26)
            trend_4h = (ema12 - ema26) / ema26 if ema26 > 0 else 0
            snapshot["trend_4h"] = round(max(-1, min(1, trend_4h / 0.03)), 3)  # ±3%를 ±1로 정규화
            snapshot["trend_4h_bias"] = "bullish" if trend_4h > 0.005 else "bearish" if trend_4h < -0.005 else "neutral"
        # 4h 가격 변동률 (최근 3봉 = 12시간)
        if len(closes_4h) >= 4:
            chg_12h = (closes_4h[-1] - closes_4h[-4]) / closes_4h[-4] * 100
            snapshot["price_change_12h_pct"] = round(chg_12h, 3)

    r = _query_one(
        "SELECT regime, atr_14, bb_width FROM z1_volatility_regime "
        "WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"sym": symbol})
    if r:
        snapshot["volatility_regime"] = r[0]
        snapshot["atr_14"] = float(r[1] or 0)
        snapshot["bb_width"] = float(r[2] or 0)

    r = _query_one(
        "SELECT volatility_acceleration FROM z1_market_states "
        "WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"sym": symbol})
    if r:
        snapshot["volatility_acceleration"] = float(r[0] or 1.0)

    r = _query_one(
        "SELECT price_dir, oi_dir, interpretation FROM z1_oi_matrix "
        "WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"sym": symbol})
    if r:
        snapshot["oi_matrix"] = {"price_dir": r[0], "oi_dir": r[1], "interpretation": r[2]}

    for ind in ["DXY", "VIX", "US10Y", "NQ_FUTURE"]:
        r = _query_one(
            "SELECT value FROM z0_macro_data WHERE indicator = :ind "
            "ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"ind": ind})
        if r:
            snapshot[f"macro_{ind.lower()}"] = float(r[0])

    rows = _query(
        "SELECT price_level, long_liq_usd, short_liq_usd FROM z1_liquidation_map "
        "WHERE symbol = :sym AND ts = (SELECT MAX(ts) FROM z1_liquidation_map WHERE symbol = :sym) "
        "ORDER BY (long_liq_usd + short_liq_usd) DESC FETCH FIRST 5 ROWS ONLY", {"sym": symbol})
    snapshot["top_liquidation_levels"] = [
        {"price": float(r[0]), "long_usd": float(r[1] or 0), "short_usd": float(r[2] or 0)} for r in rows
    ]

    return snapshot


async def get_all_symbols_snapshot(symbols: list[str]) -> dict:
    """전체 심볼의 시장 스냅샷을 압축하여 조회 (토큰 최적화)"""
    result = {}
    for sym in symbols:
        snap = await get_market_snapshot(sym)
        if not snap or not snap.get("price"):
            continue

        # [최적화 4] Prompt Compression: 핵심 지표 위주로 필드 압축
        # [최적화 5] Float 정밀도 축소 + 불필요 필드(v_1m, atr) 제거 → 토큰 절감
        # [BugFix] DOGE 등 저가 코인을 위해 가격 정밀도를 2 -> 5자리로 상향
        compressed = {
            "p": round(snap["price"], 5),
            "oi_pct": round(snap.get("oi_change_pct", 0), 4),
            "fr": round(snap.get("funding_rate", 0), 6),
            "cvd_dir": round(snap.get("cvd_direction", 0), 3),
            "v_surge": round(snap.get("volume_surge", 1.0), 2),
            "vol_r": snap.get("volatility_regime", "MED"),
            "vol_acc": round(snap.get("volatility_acceleration", 1.0), 3),
            "oi_mat": snap.get("oi_matrix", {}).get("interpretation", "N/A"),
            # 4h 스윙 핵심 데이터
            "t4h": snap.get("trend_4h", 0),           # 4h 추세 강도 (-1~+1)
            "t4h_b": snap.get("trend_4h_bias", "N/A"), # 4h 방향 편향
            "atr4h": snap.get("atr_4h_pct", 0),        # 4h ATR %
            "chg12h": snap.get("price_change_12h_pct", 0), # 12시간 가격변동률
            "liq": [
                {"p": round(l["price"], 5), "v": round(l["long_usd"] + l["short_usd"], 0)}
                for l in snap.get("top_liquidation_levels", [])[:2]
            ]
        }
        result[sym] = compressed
    return result


async def get_macro_snapshot() -> dict:
    """매크로 지표 스냅샷"""
    macro = {}
    for ind in ["DXY", "VIX", "US10Y", "NQ_FUTURE"]:
        r = _query_one(
            "SELECT value FROM z0_macro_data WHERE indicator = :ind "
            "ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"ind": ind})
        if r:
            macro[ind] = float(r[0])
    return macro


async def get_similar_states(symbol: str, limit: int = 50) -> dict | None:
    """유사 과거 시장 상태 검색 (데이터 축적 전 비활성)"""
    return None


async def get_recent_sentiment(symbol: str) -> dict | None:
    """최근 센티먼트 (전체 뉴스 기반, symbol=NULL로 저장됨)"""
    r = _query_one(
        "SELECT result FROM z2_llm_analysis WHERE analysis_type = 'sentiment' "
        "ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {})
    if r and r[0]:
        import json
        try:
            return json.loads(r[0].read() if hasattr(r[0], 'read') else str(r[0]))
        except:
            return None
    return None


async def get_recent_briefing(symbol: str) -> dict | None:
    """최근 브리핑"""
    r = _query_one(
        "SELECT result FROM z2_llm_analysis WHERE symbol = :sym AND analysis_type = 'briefing' "
        "ORDER BY ts DESC FETCH FIRST 1 ROW ONLY", {"sym": symbol})
    if r and r[0]:
        import json
        try:
            return json.loads(r[0].read() if hasattr(r[0], 'read') else str(r[0]))
        except:
            return None
    return None


async def get_active_plans(symbol: str) -> list:
    """활성 실행 플랜"""
    rows = _query(
        "SELECT id, direction, target_price, confidence FROM z2_execution_plan "
        "WHERE symbol = :sym AND status = 'ACTIVE' AND valid_until > CAST(SYSTIMESTAMP AS TIMESTAMP) "
        "ORDER BY created_at DESC", {"sym": symbol})
    return [{"id": int(r[0]), "direction": r[1], "target_price": float(r[2]) if r[2] else None,
             "confidence": float(r[3]) if r[3] else None} for r in rows]


async def get_recent_losses(symbol: str, limit: int = 3) -> list:
    """최근 손실 사례 (RAG용)"""
    rows = _query(
        "SELECT direction, entry_price, exit_price, pnl_pct, exit_reason, entry_reasoning "
        "FROM z4_positions WHERE symbol = :sym AND pnl_pct < -0.5 "
        "ORDER BY entry_time DESC FETCH FIRST :limit ROWS ONLY",
        {"sym": symbol, "limit": limit})
    
    losses = []
    for r in rows:
        import json
        reasoning = r[5]
        if hasattr(reasoning, 'read'):
            reasoning = reasoning.read()
        try:
            if isinstance(reasoning, str):
                reasoning = json.loads(reasoning)
            reasoning_text = reasoning.get('reasoning', '')
        except:
            reasoning_text = str(reasoning)

        losses.append({
            "direction": r[0],
            "pnl": float(r[3]),
            "exit_reason": r[4],
            "reasoning": reasoning_text[:200] # 길면 자름
        })
    return losses

