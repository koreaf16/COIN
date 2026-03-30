"""
@module Oracle Reader
@description Oracle DB에서 시장 지표, 유사 과거 사례, 최근 분석 결과 등을 조회한다.
             모든 쿼리는 UTC 기준으로 실행되며, 대량 조회를 위해 병렬 처리를 지원한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Oracle   │ ──→ │ Oracle   │ ──→ │ LLM      │
│ DB       │     │ Reader   │     │ Services │
└──────────┘     └──────────┘     └──────────┘
      ↑               ↓
  Raw Data      State Vectors
  (Zones 0-1)   (Context)

@dependencies config.py, query_loader.py, oracledb
"""
import asyncio
import json
import logging
from typing import List, Dict, Any, Optional
import oracledb
from config import ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING, ORACLE_INSTANT_CLIENT_PATH
from market_structure import build_market_structure
from query_loader import load_queries

# 로거 설정
logger = logging.getLogger(__name__)

_pool: Optional[oracledb.ConnectionPool] = None
_queries = load_queries("oracle_reader")

def init_pool() -> None:
    """Oracle 연결 풀을 초기화한다."""
    global _pool
    if _pool:
        return
    try:
        if ORACLE_INSTANT_CLIENT_PATH:
            oracledb.init_oracle_client(lib_dir=ORACLE_INSTANT_CLIENT_PATH)

        def _session_cb(conn: Any, requested_tag: Any) -> None:
            conn.cursor().execute("ALTER SESSION SET TIME_ZONE = 'UTC'")

        _pool = oracledb.create_pool(
            user=ORACLE_USER, 
            password=ORACLE_PASSWORD, 
            dsn=ORACLE_CONNECT_STRING,
            min=2, max=10,
            session_callback=_session_cb,
        )
        logger.info("[DB] Oracle reader pool created")
    except Exception as e:
        logger.error(f"[DB] Failed to initialize reader pool: {e}")

def get_pool() -> Optional[oracledb.ConnectionPool]:
    """현재 활성화된 연결 풀을 반환한다."""
    if not _pool:
        init_pool()
    return _pool

def _query(query_name: str, params: Optional[Dict[str, Any]] = None) -> List[Any]:
    """지정된 이름의 쿼리를 실행하고 결과를 반환한다."""
    sql = _queries.get(query_name)
    if not sql:
        logger.error(f"[DB] Query '{query_name}' not found")
        return []
        
    pool = get_pool()
    if not pool:
        return []

    try:
        with pool.acquire() as conn:
            cur = conn.cursor()
            cur.execute("ALTER SESSION SET TIME_ZONE = 'UTC'")
            cur.execute(sql, params or {})
            return cur.fetchall()
    except Exception as e:
        logger.error(f"[DB] Query '{query_name}' failed: {e}")
        return []

def _query_one(query_name: str, params: Optional[Dict[str, Any]] = None) -> Optional[Any]:
    """지정된 이름의 쿼리를 실행하고 첫 번째 행을 반환한다."""
    rows = _query(query_name, params)
    return rows[0] if rows else None

async def get_market_snapshot(symbol: str) -> Dict[str, Any]:
    """심볼의 현재 시장 스냅샷을 조회한다 (Non-blocking)."""
    return await asyncio.to_thread(_get_market_snapshot_sync, symbol)

def _get_market_snapshot_sync(symbol: str) -> Dict[str, Any]:
    """심볼의 현재 시장 스냅샷을 동기 방식으로 조회한다."""
    snapshot: Dict[str, Any] = {}
    params = {"sym": symbol}

    _fetch_price_and_vol(snapshot, params)
    _fetch_derivatives(snapshot, params)
    _fetch_onchain(snapshot, params)
    _fetch_trends_and_rsi(snapshot, params)
    _fetch_market_structure(snapshot, params)
    _fetch_indicators_and_macro(snapshot, params)
    _fetch_liquidations(snapshot, params)

    return snapshot

def _fetch_price_and_vol(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """가격 및 거래량 급증 여부를 조회한다."""
    rows = _query("getMarketOhlcv", params)
    if rows:
        snapshot["price"] = float(rows[0][0])
        snapshot["volume_1m"] = float(rows[0][1])
        if len(rows) >= 2:
            avg_vol = sum(float(r[1] or 0) for r in rows[1:]) / (len(rows) - 1)
            latest_vol = float(rows[0][1] or 0)
            raw_surge = latest_vol / avg_vol if avg_vol > 0 else 1.0
            snapshot["volume_surge"] = round(min(raw_surge, 5.0), 2)

def _fetch_derivatives(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """파생상품 지표(OI, 펀딩비 등)를 조회한다."""
    r = _query_one("getDerivatives", params)
    if r:
        snapshot["open_interest"] = float(r[0] or 0)
        snapshot["oi_change_pct"] = float(r[1] or 0)
        snapshot["funding_rate"] = float(r[2] or 0)
        snapshot["predicted_funding"] = float(r[3] or 0)
        snapshot["long_ratio"] = float(r[4] or 0)
        snapshot["short_ratio"] = float(r[5] or 0)
        snapshot["liq_long_24h"] = float(r[6] or 0)
        snapshot["liq_short_24h"] = float(r[7] or 0)

    r = _query_one("getCvd1h", params)
    if r:
        cvd_raw = float(r[0] or 0)
        vol_1h = float(r[1] or 0)
        snapshot["cvd_1h"] = cvd_raw
        snapshot["cvd_direction"] = round(cvd_raw / vol_1h, 3) if vol_1h > 0 else 0.0

def _fetch_onchain(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """온체인 지표를 조회한다."""
    r = _query_one("getOnchain", params)
    if r:
        snapshot["onchain_mpi"] = float(r[0] or 0)
        snapshot["onchain_stablecoin_reserve"] = float(r[1] or 0)
        snapshot["onchain_whale_ratio"] = float(r[2] or 0)

def _fetch_trends_and_rsi(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """4h 추세 및 1h RSI를 조회한다."""
    # 4h 추세/ATR
    rows_4h = _query("get4hCandles", params)
    if rows_4h and len(rows_4h) >= 5:
        _calc_4h_metrics(snapshot, rows_4h)

    # 1h RSI
    rows_1h = _query("get1hCandles", params)
    if rows_1h and len(rows_1h) >= 15:
        _calc_1h_metrics(snapshot, rows_1h)

def _fetch_market_structure(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """1d/4h/1h 구조와 스윙 셋업 피처를 조회한다."""
    rows_1h = _query("get1hCandlesFull", params)
    rows_4h = _query("get4hCandlesFull", params)
    rows_1d = _query("get1dCandlesFull", params)
    if not rows_1h or not rows_4h:
        return

    btc_params = params if params.get("sym") == "BTCUSDT" else {"sym": "BTCUSDT"}
    btc_rows_1h = rows_1h if btc_params is params else _query("get1hCandlesFull", btc_params)
    btc_rows_1d = rows_1d if btc_params is params else _query("get1dCandlesFull", btc_params)

    structure = build_market_structure(
        rows_1h=rows_1h,
        rows_4h=rows_4h,
        rows_1d=rows_1d,
        btc_rows_1h=btc_rows_1h,
        btc_rows_1d=btc_rows_1d,
        current_price=snapshot.get("price"),
    )
    snapshot.update(structure)


def _calc_4h_metrics(snapshot: Dict[str, Any], rows_4h: List[Any]) -> None:
    """4시간 봉 데이터를 기반으로 지표를 계산한다."""
    rows_4h = list(reversed(rows_4h))
    closes_4h = [float(r[2]) for r in rows_4h]
    atr_bars = rows_4h[-min(14, len(rows_4h)):]
    atr_sum = sum(float(r[0]) - float(r[1]) for r in atr_bars)
    atr_4h = atr_sum / len(atr_bars)
    snapshot["atr_4h"] = round(atr_4h, 5)
    if closes_4h[-1] > 0:
        snapshot["atr_4h_pct"] = round(atr_4h / closes_4h[-1] * 100, 3)
    if len(closes_4h) >= 12:
        _calc_ema_trend(snapshot, closes_4h)

def _calc_ema_trend(snapshot: Dict[str, Any], closes: List[float]) -> None:
    """EMA를 사용하여 추세를 계산한다."""
    ema12, k12 = closes[0], 2/13
    for p in closes[1:]: ema12 = p * k12 + ema12 * (1 - k12)
    ema26, k26 = closes[0], 2/27
    for p in closes[1:]: ema26 = p * k26 + ema26 * (1 - k26)
    trend = (ema12 - ema26) / ema26 if ema26 > 0 else 0
    snapshot["trend_4h"] = round(max(-1, min(1, trend / 0.03)), 3)
    snapshot["trend_4h_bias"] = "bullish" if trend > 0.005 else "bearish" if trend < -0.005 else "neutral"

def _calc_1h_metrics(snapshot: Dict[str, Any], rows_1h: List[Any]) -> None:
    """1시간 봉 데이터를 기반으로 RSI 및 연속 방향을 계산한다."""
    closes_desc = [float(r[0]) for r in rows_1h]
    closes_asc = list(reversed(closes_desc))
    # RSI(14)
    gains = sum(max(0, closes_asc[i] - closes_asc[i-1]) for i in range(1, 15))
    losses = sum(max(0, closes_asc[i-1] - closes_asc[i]) for i in range(1, 15))
    avg_gain, avg_loss = gains / 14, losses / 14
    rsi = 100 - (100 / (1 + avg_gain/avg_loss)) if avg_loss > 0 else 100.0 if avg_gain > 0 else 50.0
    snapshot["rsi_1h_14"] = round(rsi, 1)
    # 연속 방향
    _calc_consecutive_moves(snapshot, closes_desc)

def _calc_consecutive_moves(snapshot: Dict[str, Any], closes_desc: List[float]) -> None:
    """연속적인 상승/하락 캔들을 카운트한다."""
    bear, bull = 0, 0
    for i in range(len(closes_desc)-1):
        if closes_desc[i] < closes_desc[i+1]: bear += 1
        else: break
    for i in range(len(closes_desc)-1):
        if closes_desc[i] > closes_desc[i+1]: bull += 1
        else: break
    if bear >= 3:
        snapshot["consecutive_bearish"] = bear
        snapshot["cumulative_drop_pct"] = round((closes_desc[bear]-closes_desc[0])/closes_desc[bear]*100, 2)
    if bull >= 3:
        snapshot["consecutive_bullish"] = bull
        snapshot["cumulative_rise_pct"] = round((closes_desc[0]-closes_desc[bull])/closes_desc[bull]*100, 2)

def _fetch_indicators_and_macro(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """변동성 레지스트리, OI 매트릭스, 매크로 지표를 조회한다."""
    # BTC 모멘텀
    if params["sym"] != "BTCUSDT":
        btc = _query("getBtcOhlcv")
        if len(btc) >= 2:
            mom = (float(btc[0][0]) - float(btc[-1][0])) / float(btc[-1][0]) * 100
            snapshot["btc_momentum_2h"] = round(mom, 3)

    for q in ["getVolatilityRegime", "getMarketState", "getOiMatrix"]:
        r = _query_one(q, params)
        if r:
            if q == "getVolatilityRegime":
                snapshot["volatility_regime"], snapshot["atr_14"], snapshot["bb_width"] = r[0], float(r[1] or 0), float(r[2] or 0)
            elif q == "getMarketState": snapshot["volatility_acceleration"] = float(r[0] or 1.0)
            elif q == "getOiMatrix": snapshot["oi_matrix"] = {"price_dir": r[0], "oi_dir": r[1], "interpretation": r[2]}

    macro = _query("getMacroData")
    for r in macro: snapshot[f"macro_{r[0].lower()}"] = float(r[1])

def _fetch_liquidations(snapshot: Dict[str, Any], params: Dict[str, Any]) -> None:
    """청산 맵 데이터를 조회한다."""
    rows = _query("getLiquidationMap", params)
    snapshot["top_liquidation_levels"] = [
        {"price": float(r[0]), "long_usd": float(r[1] or 0), "short_usd": float(r[2] or 0)} for r in rows
    ]

async def get_all_symbols_snapshot(symbols: List[str]) -> Dict[str, Any]:
    """모든 심볼의 스냅샷을 병렬로 조회하고 압축한다."""
    snaps = await asyncio.gather(*[get_market_snapshot(s) for s in symbols], return_exceptions=True)
    result = {}
    for sym, snap in zip(symbols, snaps):
        if isinstance(snap, Exception) or not snap or not snap.get("price"): continue
        result[sym] = _compress_snapshot(snap)
    return result

def _compress_snapshot(s: Dict[str, Any]) -> Dict[str, Any]:
    """LLM 토큰 절감을 위해 스냅샷 데이터를 압축한다."""
    return {
        "p": round(s["price"], 5), "oi_pct": round(s.get("oi_change_pct", 0), 4),
        "fr": round(s.get("funding_rate", 0), 6), "cvd_dir": round(s.get("cvd_direction", 0), 3),
        "v_surge": round(s.get("volume_surge", 1.0), 2), "vol_r": s.get("volatility_regime", "MED"),
        "vol_acc": round(s.get("volatility_acceleration", 1.0), 3), "oi_mat": s.get("oi_matrix", {}).get("interpretation", "N/A"),
        "t4h": s.get("trend_4h", 0), "t4h_b": s.get("trend_4h_bias", "N/A"), "atr4h": s.get("atr_4h_pct", 0),
        "chg12h": s.get("price_change_12h_pct", 0), "l_liq": round(s.get("liq_long_24h", 0), 0),
        "s_liq": round(s.get("liq_short_24h", 0), 0), "rsi14": s.get("rsi_1h_14", 50),
        "c_bear": s.get("consecutive_bearish", 0), "c_bull": s.get("consecutive_bullish", 0),
        "c_drop": s.get("cumulative_drop_pct", 0), "c_rise": s.get("cumulative_rise_pct", 0),
        "btc_mom": s.get("btc_momentum_2h", 0), "whale": round(s.get("onchain_whale_ratio", 0), 3),
        "reserve": round(s.get("onchain_stablecoin_reserve", 0), 0),
        "liq": [{"p": round(l["price"], 5), "v": round(l["long_usd"]+l["short_usd"], 0)} for l in s.get("top_liquidation_levels", [])[:2]],
        "daily_bias": s.get("daily_bias", "NEUTRAL"),
        "trend_bias_4h": s.get("trend_bias_4h", "NEUTRAL"),
        "trigger_bias_1h": s.get("trigger_bias_1h", "NEUTRAL"),
        "btc_daily_bias": s.get("btc_daily_bias", "NEUTRAL"),
        "ema_fast_above_slow_4h": s.get("ema_fast_above_slow_4h", 0),
        "ema_fast_above_slow_1d": s.get("ema_fast_above_slow_1d", 0),
        "ema_gap_4h": s.get("ema_gap_4h"),
        "ema_gap_1d": s.get("ema_gap_1d"),
        "pullback_atr_ratio": s.get("pullback_atr_ratio"),
        "support_distance_pct": s.get("support_distance_pct"),
        "resistance_distance_pct": s.get("resistance_distance_pct"),
        "range_position_20": s.get("range_position_20"),
        "donchian_break_20": s.get("donchian_break_20", "NONE"),
        "relative_strength_btc_12h": s.get("relative_strength_btc_12h"),
        "pullback_long_setup": s.get("pullback_long_setup", 0),
        "pullback_short_setup": s.get("pullback_short_setup", 0),
        "breakout_long_setup": s.get("breakout_long_setup", 0),
        "breakout_short_setup": s.get("breakout_short_setup", 0),
        "retest_support_ready": s.get("retest_support_ready", 0),
        "retest_resistance_ready": s.get("retest_resistance_ready", 0),
    }

async def get_macro_snapshot() -> Dict[str, float]:
    """매크로 지표 스냅샷을 조회한다."""
    rows = await asyncio.to_thread(_query, "getMacroData")
    return {r[0]: float(r[1]) for r in rows}

async def get_similar_states(symbol: str, limit: int = 50) -> Optional[Dict[str, Any]]:
    """현재 시장 상태와 유사한 과거 사례의 통계를 조회한다."""
    try:
        cnt = _query_one("countStateVectors", {"sym": symbol})
        if not cnt or cnt[0] < 5: return None
        
        vec_row = _query_one("getLatestVector", {"sym": symbol})
        if not vec_row or not vec_row[0]: return None
        
        rows = _query("getSimilarStates", {"sym": symbol, "vec": vec_row[0], "lim": limit})
        if not rows: return None
        
        def _stat(vals):
            if not vals: return None
            s = sorted(vals)
            avg = sum(vals)/len(vals)
            return {"avg": round(avg, 3), "median": round(s[len(s)//2], 3), "std": round((sum((v-avg)**2 for v in vals)/len(vals))**0.5, 3), "win_rate": round(sum(1 for v in vals if v>0)/len(vals), 2), "count": len(vals)}

        return {
            "sample_count": len(rows), "avg_similarity": round(sum(float(r[4]) for r in rows)/len(rows), 4),
            "stats_1h": _stat([float(r[1]) for r in rows if r[1] is not None]),
            "stats_4h": _stat([float(r[2]) for r in rows if r[2] is not None]),
            "stats_24h": _stat([float(r[3]) for r in rows if r[3] is not None])
        }
    except Exception as e:
        logger.warning(f"[DB] get_similar_states failed: {e}")
        return None

async def get_recent_sentiment() -> Optional[Dict[str, Any]]:
    """최근 시장 감정 분석 결과를 조회한다."""
    r = _query_one("getRecentSentiment")
    return _parse_json_column(r[0]) if r else None

async def get_recent_events(symbol: str, limit: int = 3) -> List[Dict[str, Any]]:
    rows = _query("getRecentEventsBySymbol", {"sym": symbol, "limit": limit})
    events: List[Dict[str, Any]] = []
    for r in rows:
        payload = _parse_json_column(r[1])
        if not isinstance(payload, dict):
            continue
        event = dict(payload)
        if r[0] is not None:
            event["ts"] = str(r[0])
        events.append(event)
    return events

async def get_recent_briefing(symbol: str) -> Optional[Dict[str, Any]]:
    """특정 심볼의 최근 브리핑 결과를 조회한다."""
    r = _query_one("getRecentAnalysis", {"sym": symbol, "atype": "briefing"})
    return _parse_json_column(r[0]) if r else None

async def get_active_plans(symbol: str) -> List[Dict[str, Any]]:
    """현재 활성화된 매매 플랜을 조회한다."""
    rows = _query("getActivePlans", {"sym": symbol})
    return [{"id": int(r[0]), "direction": r[1], "target_price": float(r[2]) if r[2] else None, "confidence": float(r[3]) if r[3] else None} for r in rows]

async def get_recent_losses(symbol: str, limit: int = 3) -> List[Dict[str, Any]]:
    """RAG를 위한 최근 손실 사례를 조회한다."""
    rows = _query("getRecentLosses", {"sym": symbol, "limit": limit})
    losses = []
    for r in rows:
        reasoning = _parse_json_column(r[5])
        reasoning_text = reasoning.get('reasoning', '') if isinstance(reasoning, dict) else str(reasoning)
        losses.append({"direction": r[0], "pnl": float(r[3]), "exit_reason": r[4], "reasoning": reasoning_text[:200]})
    return losses

def _parse_json_column(col_data: Any) -> Any:
    """DB의 JSON/LOB 컬럼 데이터를 파싱한다."""
    if not col_data: return None
    try:
        text = col_data.read() if hasattr(col_data, 'read') else str(col_data)
        return json.loads(text)
    except: return str(col_data)
