-- ============================================================
-- COIN v2 PL/SQL — Zone 1 자동 가공 트리거/프로시저
-- z0 데이터 INSERT 시 자동으로 z1 가공 데이터 생성
-- ============================================================

-- ========== 1. CVD (누적 볼륨 델타) 계산 ==========
-- z0_price_ohlcv INSERT 시 buy_volume - sell_volume 누적
-- CVD는 kline 단위로 계산: 이전 CVD + (buy_volume - sell_volume)

CREATE OR REPLACE TRIGGER trg_z0_ohlcv_cvd
BEFORE INSERT ON z0_price_ohlcv
FOR EACH ROW
DECLARE
    v_prev_cvd NUMBER := 0;
BEGIN
    -- 같은 심볼/타임프레임의 직전 CVD 조회
    BEGIN
        SELECT cvd INTO v_prev_cvd
        FROM z0_price_ohlcv
        WHERE symbol = :NEW.symbol
          AND timeframe = :NEW.timeframe
          AND ts < :NEW.ts
        ORDER BY ts DESC
        FETCH FIRST 1 ROW ONLY;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            v_prev_cvd := 0;
    END;

    -- CVD = 이전 CVD + (매수체결량 - 매도체결량)
    :NEW.cvd := v_prev_cvd + NVL(:NEW.buy_volume, 0) - NVL(:NEW.sell_volume, 0);
END;
/

-- ========== 2. OI-가격 매트릭스 해석 ==========
-- z0_derivatives INSERT 시 이전 행과 비교하여 해석

CREATE OR REPLACE TRIGGER trg_z0_deriv_oi_matrix
AFTER INSERT ON z0_derivatives
FOR EACH ROW
DECLARE
    v_prev_oi     NUMBER;
    v_prev_price  NUMBER;
    v_curr_price  NUMBER;
    v_price_dir   VARCHAR2(5);
    v_oi_dir      VARCHAR2(5);
    v_interp      VARCHAR2(50);
BEGIN
    -- 직전 OI 조회
    BEGIN
        SELECT open_interest INTO v_prev_oi
        FROM z0_derivatives
        WHERE symbol = :NEW.symbol
          AND ts < :NEW.ts
        ORDER BY ts DESC
        FETCH FIRST 1 ROW ONLY;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN RETURN;  -- 첫 행이면 스킵
    END;

    -- 현재/이전 가격 조회 (1m kline close)
    BEGIN
        SELECT close_price INTO v_curr_price
        FROM z0_price_ohlcv
        WHERE symbol = :NEW.symbol AND timeframe = '1m'
        ORDER BY ts DESC FETCH FIRST 1 ROW ONLY;

        SELECT close_price INTO v_prev_price
        FROM z0_price_ohlcv
        WHERE symbol = :NEW.symbol AND timeframe = '1m'
          AND ts < :NEW.ts - INTERVAL '1' MINUTE
        ORDER BY ts DESC FETCH FIRST 1 ROW ONLY;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN RETURN;
    END;

    -- 방향 판별
    v_price_dir := CASE
        WHEN v_curr_price > v_prev_price * 1.0005 THEN 'UP'
        WHEN v_curr_price < v_prev_price * 0.9995 THEN 'DOWN'
        ELSE 'FLAT'
    END;

    v_oi_dir := CASE
        WHEN :NEW.open_interest > v_prev_oi * 1.001 THEN 'UP'
        WHEN :NEW.open_interest < v_prev_oi * 0.999 THEN 'DOWN'
        ELSE 'FLAT'
    END;

    -- 해석
    v_interp := CASE
        WHEN v_price_dir = 'UP'   AND v_oi_dir = 'UP'   THEN 'NEW_LONG'           -- 신규 롱 진입 (건강한 상승)
        WHEN v_price_dir = 'UP'   AND v_oi_dir = 'DOWN' THEN 'SHORT_COVER'        -- 숏 청산 (연료 소진)
        WHEN v_price_dir = 'DOWN' AND v_oi_dir = 'UP'   THEN 'NEW_SHORT'          -- 신규 숏 진입 (하락 가속)
        WHEN v_price_dir = 'DOWN' AND v_oi_dir = 'DOWN' THEN 'LONG_LIQUIDATION'   -- 롱 청산 (항복 매도)
        ELSE 'NEUTRAL'
    END;

    -- z1_oi_matrix 저장
    INSERT INTO z1_oi_matrix (symbol, ts, price_dir, oi_dir, interpretation)
    VALUES (:NEW.symbol, :NEW.ts, v_price_dir, v_oi_dir, v_interp);
EXCEPTION
    WHEN OTHERS THEN NULL;  -- 에러 시 데이터 수집 방해하지 않음
END;
/

-- ========== 3. 변동성 레짐 계산 ==========
-- 매 1시간 kline INSERT 시 변동성 레짐 분류

CREATE OR REPLACE PROCEDURE sp_calc_volatility_regime(
    p_symbol   IN VARCHAR2,
    p_ts       IN TIMESTAMP
)
AS
    v_atr      NUMBER;
    v_bb_width NUMBER;
    v_avg_price NUMBER;
    v_regime   VARCHAR2(10);
    TYPE t_nums IS TABLE OF NUMBER;
    v_highs    t_nums;
    v_lows     t_nums;
    v_closes   t_nums;
    v_tr_sum   NUMBER := 0;
    v_n        NUMBER;
    v_std      NUMBER;
    v_sma      NUMBER;
BEGIN
    -- 최근 20개 1h kline
    SELECT high_price, low_price, close_price
    BULK COLLECT INTO v_highs, v_lows, v_closes
    FROM (
        SELECT high_price, low_price, close_price
        FROM z0_price_ohlcv
        WHERE symbol = p_symbol AND timeframe = '1h' AND ts <= p_ts
        ORDER BY ts DESC
        FETCH FIRST 20 ROWS ONLY
    )
    ORDER BY ROWNUM;

    v_n := v_closes.COUNT;
    IF v_n < 14 THEN RETURN; END IF;

    -- ATR 14 계산
    FOR i IN 2..LEAST(v_n, 15) LOOP
        v_tr_sum := v_tr_sum + GREATEST(
            v_highs(i) - v_lows(i),
            ABS(v_highs(i) - v_closes(i-1)),
            ABS(v_lows(i) - v_closes(i-1))
        );
    END LOOP;
    v_atr := v_tr_sum / 14;

    -- 볼린저밴드 폭: (2*std/sma) * 100
    SELECT AVG(close_price), STDDEV(close_price)
    INTO v_sma, v_std
    FROM (
        SELECT close_price FROM z0_price_ohlcv
        WHERE symbol = p_symbol AND timeframe = '1h' AND ts <= p_ts
        ORDER BY ts DESC FETCH FIRST 20 ROWS ONLY
    );

    v_bb_width := CASE WHEN v_sma > 0 THEN (2 * v_std / v_sma) * 100 ELSE 0 END;
    v_avg_price := v_sma;

    -- 레짐 분류: ATR/가격 비율 기준
    v_regime := CASE
        WHEN v_avg_price > 0 AND (v_atr / v_avg_price * 100) < 0.5 THEN 'LOW'
        WHEN v_avg_price > 0 AND (v_atr / v_avg_price * 100) > 1.5 THEN 'HIGH'
        ELSE 'MED'
    END;

    MERGE INTO z1_volatility_regime t
    USING (SELECT p_symbol AS symbol, p_ts AS ts FROM dual) s
    ON (t.symbol = s.symbol AND t.ts = s.ts)
    WHEN MATCHED THEN UPDATE SET regime = v_regime, atr_14 = v_atr, bb_width = v_bb_width
    WHEN NOT MATCHED THEN INSERT (symbol, ts, regime, atr_14, bb_width)
                          VALUES (p_symbol, p_ts, v_regime, v_atr, v_bb_width);
    COMMIT;
EXCEPTION
    WHEN OTHERS THEN NULL;
END;
/

-- 1h kline INSERT 시 자동 호출 트리거
CREATE OR REPLACE TRIGGER trg_z0_ohlcv_vol_regime
AFTER INSERT ON z0_price_ohlcv
FOR EACH ROW
BEGIN
    IF :NEW.timeframe = '1h' THEN
        sp_calc_volatility_regime(:NEW.symbol, :NEW.ts);
    END IF;
END;
/

-- ========== 4. 유동성 맵 집계 ==========
-- z0_liquidation_raw INSERT 시 가격대별 집계 → z1_liquidation_map

CREATE OR REPLACE PROCEDURE sp_update_liquidation_map(
    p_symbol   IN VARCHAR2,
    p_ts       IN TIMESTAMP
)
AS
    v_curr_price NUMBER;
    v_step       NUMBER;
BEGIN
    -- 현재 가격 조회
    SELECT close_price INTO v_curr_price
    FROM z0_price_ohlcv
    WHERE symbol = p_symbol AND timeframe = '1m'
    ORDER BY ts DESC FETCH FIRST 1 ROW ONLY;

    -- 가격 단위 결정 (BTC: $100, 소형코인: $0.01 등)
    v_step := CASE
        WHEN v_curr_price > 10000 THEN 100
        WHEN v_curr_price > 1000  THEN 10
        WHEN v_curr_price > 100   THEN 1
        WHEN v_curr_price > 10    THEN 0.1
        ELSE 0.01
    END;

    -- 최근 24시간 청산 데이터를 가격대별 집계
    DELETE FROM z1_liquidation_map WHERE symbol = p_symbol AND ts = p_ts;

    INSERT INTO z1_liquidation_map (symbol, ts, price_level, long_liq_usd, short_liq_usd)
    SELECT p_symbol,
           p_ts,
           ROUND(price / v_step) * v_step AS price_level,
           SUM(CASE WHEN side = 'SELL' THEN usd_value ELSE 0 END) AS long_liq_usd,
           SUM(CASE WHEN side = 'BUY'  THEN usd_value ELSE 0 END) AS short_liq_usd
    FROM z0_liquidation_raw
    WHERE symbol = p_symbol
      AND ts > p_ts - INTERVAL '24' HOUR
    GROUP BY ROUND(price / v_step) * v_step;

    COMMIT;
EXCEPTION
    WHEN OTHERS THEN NULL;
END;
/

-- ========== 5. 매크로 레짐 분류 ==========
-- DXY 추세 + VIX 레벨 + 금리 방향 종합

CREATE OR REPLACE FUNCTION fn_macro_regime RETURN VARCHAR2
AS
    v_dxy       NUMBER;
    v_dxy_prev  NUMBER;
    v_vix       NUMBER;
    v_regime    VARCHAR2(15);
BEGIN
    -- 최신 DXY
    BEGIN
        SELECT value INTO v_dxy FROM z0_macro_data
        WHERE indicator = 'DXY' ORDER BY ts DESC FETCH FIRST 1 ROW ONLY;
    EXCEPTION WHEN NO_DATA_FOUND THEN v_dxy := 100; END;

    -- 24시간 전 DXY
    BEGIN
        SELECT value INTO v_dxy_prev FROM z0_macro_data
        WHERE indicator = 'DXY' AND ts < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '24' HOUR
        ORDER BY ts DESC FETCH FIRST 1 ROW ONLY;
    EXCEPTION WHEN NO_DATA_FOUND THEN v_dxy_prev := v_dxy; END;

    -- 최신 VIX
    BEGIN
        SELECT value INTO v_vix FROM z0_macro_data
        WHERE indicator = 'VIX' ORDER BY ts DESC FETCH FIRST 1 ROW ONLY;
    EXCEPTION WHEN NO_DATA_FOUND THEN v_vix := 20; END;

    -- 레짐 판단
    v_regime := CASE
        WHEN v_vix > 30 THEN 'risk_off'                          -- 공포
        WHEN v_vix < 15 AND v_dxy < v_dxy_prev THEN 'risk_on'    -- 안정 + 달러 약세
        WHEN v_vix < 20 AND v_dxy <= v_dxy_prev THEN 'risk_on'   -- 보통 + 달러 약세
        WHEN v_vix > 25 OR v_dxy > v_dxy_prev * 1.005 THEN 'risk_off' -- 불안 또는 달러 강세
        ELSE 'neutral'
    END;

    RETURN v_regime;
END;
/
