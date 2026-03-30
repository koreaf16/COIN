-- ============================================================
-- COIN v2 Schema — 5-Zone Architecture
-- Zone 0: Raw Data | Zone 1: Processed | Zone 2: Intelligence
-- Zone 3: Execution | Zone 4: Results
-- ============================================================

-- ========== DROP old tables ==========
BEGIN
  FOR t IN (
    SELECT table_name FROM user_tables
    WHERE table_name LIKE 'TB_%'
    ORDER BY table_name
  ) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/

-- ========== Zone 0: Raw Data ==========

-- Z0-1. 멀티 타임프레임 OHLCV + 매수/매도 볼륨 + CVD
CREATE TABLE z0_price_ohlcv (
    symbol        VARCHAR2(20)   NOT NULL,
    timeframe     VARCHAR2(10)   NOT NULL,   -- '1m','5m','1h','4h','1d'
    ts            TIMESTAMP      NOT NULL,
    open_price    NUMBER         NOT NULL,
    high_price    NUMBER         NOT NULL,
    low_price     NUMBER         NOT NULL,
    close_price   NUMBER         NOT NULL,
    volume        NUMBER         NOT NULL,
    quote_volume  NUMBER,
    trade_count   NUMBER,
    buy_volume    NUMBER         DEFAULT 0,   -- taker buy volume
    sell_volume   NUMBER         DEFAULT 0,   -- taker sell volume
    cvd           NUMBER         DEFAULT 0,   -- 누적 볼륨 델타 (PL/SQL 트리거가 계산)
    CONSTRAINT pk_z0_ohlcv PRIMARY KEY (symbol, timeframe, ts)
)
PARTITION BY RANGE (ts) INTERVAL (NUMTODSINTERVAL(1, 'DAY')) (
    PARTITION p_init VALUES LESS THAN (TIMESTAMP '2026-03-23 00:00:00')
)
ROW STORE COMPRESS ADVANCED;

-- Z0-2. 파생상품 데이터 (OI, 펀딩비, 롱숏비, 청산)
CREATE TABLE z0_derivatives (
    symbol         VARCHAR2(20)  NOT NULL,
    ts             TIMESTAMP     NOT NULL,
    open_interest  NUMBER,                    -- 미결제약정 (USD)
    oi_change_pct  NUMBER,                    -- OI 변화율 (%)
    funding_rate   NUMBER,                    -- 펀딩비 (8시간)
    predicted_rate NUMBER,                    -- 다음 펀딩비 예측치
    long_ratio     NUMBER,                    -- 롱 비율 (0~1)
    short_ratio    NUMBER,                    -- 숏 비율 (0~1)
    liq_long_24h   NUMBER        DEFAULT 0,   -- 24h 롱 청산량 (USD)
    liq_short_24h  NUMBER        DEFAULT 0,   -- 24h 숏 청산량 (USD)
    CONSTRAINT pk_z0_deriv PRIMARY KEY (symbol, ts)
)
PARTITION BY RANGE (ts) INTERVAL (NUMTODSINTERVAL(1, 'DAY')) (
    PARTITION p_init VALUES LESS THAN (TIMESTAMP '2026-03-23 00:00:00')
)
ROW STORE COMPRESS ADVANCED;

-- Z0-3. 실시간 강제 청산 이벤트
CREATE TABLE z0_liquidation_raw (
    id             NUMBER GENERATED ALWAYS AS IDENTITY,
    symbol         VARCHAR2(20)  NOT NULL,
    ts             TIMESTAMP     NOT NULL,
    side           VARCHAR2(5)   NOT NULL,    -- 'BUY' or 'SELL' (청산된 방향)
    price          NUMBER        NOT NULL,
    qty            NUMBER        NOT NULL,
    usd_value      NUMBER,                    -- price * qty
    CONSTRAINT pk_z0_liq_raw PRIMARY KEY (id)
)
PARTITION BY RANGE (ts) INTERVAL (NUMTODSINTERVAL(1, 'DAY')) (
    PARTITION p_init VALUES LESS THAN (TIMESTAMP '2026-03-23 00:00:00')
);

CREATE INDEX idx_z0_liq_raw_sym_ts ON z0_liquidation_raw (symbol, ts) LOCAL;

-- Z0-4. 매크로 데이터 (DXY, US10Y, VIX, NQ선물, FRED 지표)
CREATE TABLE z0_macro_data (
    indicator      VARCHAR2(50)  NOT NULL,    -- 'DXY','US10Y','VIX','NQ_FUTURE','FEDFUNDS','CPI'
    ts             TIMESTAMP     NOT NULL,
    value          NUMBER        NOT NULL,
    source         VARCHAR2(20)  DEFAULT 'YAHOO', -- 'YAHOO','FRED'
    CONSTRAINT pk_z0_macro PRIMARY KEY (indicator, ts)
);

-- Z0-5. 뉴스 피드 원본
CREATE TABLE z0_news_raw (
    id             NUMBER GENERATED ALWAYS AS IDENTITY,
    ts             TIMESTAMP     NOT NULL,
    source         VARCHAR2(50),              -- 'tiingo','coindesk','reuters'
    title          VARCHAR2(500) NOT NULL,
    content        CLOB,
    tickers        VARCHAR2(200),             -- 관련 티커 CSV
    url            VARCHAR2(500),
    CONSTRAINT pk_z0_news PRIMARY KEY (id)
);

CREATE INDEX idx_z0_news_ts ON z0_news_raw (ts);

-- ========== Zone 1: Processed Data ==========

-- Z1-1. 시장 상태 벡터 (유사 과거 검색용)
CREATE TABLE z1_market_states (
    symbol              VARCHAR2(20)  NOT NULL,
    ts                  TIMESTAMP     NOT NULL,
    state_vector        VECTOR(9, FLOAT64),   -- 9차원 상태 벡터
    volatility_regime   VARCHAR2(10),         -- 'LOW','MED','HIGH'
    trend_strength      NUMBER,               -- -1.0 ~ +1.0
    funding_zscore      NUMBER,
    oi_change_pct       NUMBER,
    cvd_direction       NUMBER,               -- -1.0 ~ +1.0
    macro_regime        VARCHAR2(15),         -- 'risk_on','neutral','risk_off'
    sentiment_score     NUMBER,               -- -1.0 ~ +1.0
    exchange_netflow    NUMBER DEFAULT 0,     -- Phase 3에서 채움
    liq_asymmetry           NUMBER,           -- 상방/하방 청산비율 (-1~+1)
    volatility_acceleration NUMBER DEFAULT 1.0, -- 변동성 가속도 (ATR 변화율)
    next_1h_return      NUMBER,               -- 사후 기록 (백테스트용)
    next_4h_return      NUMBER,
    next_24h_return     NUMBER,
    CONSTRAINT pk_z1_states PRIMARY KEY (symbol, ts)
);

-- 벡터 유사도 검색용 HNSW 인덱스
CREATE VECTOR INDEX idx_z1_states_vec ON z1_market_states (state_vector)
    ORGANIZATION NEIGHBOR PARTITIONS
    DISTANCE COSINE
    WITH TARGET ACCURACY 95;

-- Z1-2. 유동성 맵 (가격대별 청산 클러스터 집계)
CREATE TABLE z1_liquidation_map (
    symbol         VARCHAR2(20)  NOT NULL,
    ts             TIMESTAMP     NOT NULL,
    price_level    NUMBER        NOT NULL,    -- 가격 레벨 (100단위 반올림 등)
    long_liq_usd   NUMBER        DEFAULT 0,   -- 해당 가격에서 롱 청산 예상량
    short_liq_usd  NUMBER        DEFAULT 0,   -- 해당 가격에서 숏 청산 예상량
    CONSTRAINT pk_z1_liq_map PRIMARY KEY (symbol, ts, price_level)
);

-- Z1-3. 변동성 레짐 시계열
CREATE TABLE z1_volatility_regime (
    symbol         VARCHAR2(20)  NOT NULL,
    ts             TIMESTAMP     NOT NULL,
    regime         VARCHAR2(10)  NOT NULL,    -- 'LOW','MED','HIGH'
    atr_14         NUMBER,                    -- 14기간 ATR
    bb_width       NUMBER,                    -- 볼린저밴드 폭 (%)
    CONSTRAINT pk_z1_vol PRIMARY KEY (symbol, ts)
);

-- Z1-4. OI-가격 매트릭스 해석
CREATE TABLE z1_oi_matrix (
    symbol         VARCHAR2(20)  NOT NULL,
    ts             TIMESTAMP     NOT NULL,
    price_dir      VARCHAR2(5),              -- 'UP','DOWN','FLAT'
    oi_dir         VARCHAR2(5),              -- 'UP','DOWN','FLAT'
    interpretation VARCHAR2(50),             -- 'NEW_LONG','SHORT_COVER','NEW_SHORT','LONG_LIQUIDATION'
    CONSTRAINT pk_z1_oi PRIMARY KEY (symbol, ts)
);

-- ========== Zone 2: Intelligence ==========

-- Z2-1. LLM 분석 결과
CREATE TABLE z2_llm_analysis (
    id              NUMBER GENERATED ALWAYS AS IDENTITY,
    symbol          VARCHAR2(20),
    ts              TIMESTAMP     NOT NULL,
    analysis_type   VARCHAR2(20)  NOT NULL,   -- 'sentiment','briefing','scenario','event'
    llm_source      VARCHAR2(10)  DEFAULT 'local', -- 'local','cloud'
    result          VARCHAR2(32767) NOT NULL,  -- LLM 출력 전체 (Oracle VARCHAR2 max)
    confidence      NUMBER,
    embedding       VECTOR(1024, FLOAT64),    -- 브리핑 텍스트 임베딩 (BGE-M3)
    latency_ms      NUMBER,                   -- LLM 호출 지연
    token_count     NUMBER,                   -- 사용 토큰 수
    CONSTRAINT pk_z2_llm PRIMARY KEY (id)
);

CREATE INDEX idx_z2_llm_sym_ts ON z2_llm_analysis (symbol, ts, analysis_type);

-- 임베딩 벡터 검색용 HNSW
CREATE VECTOR INDEX idx_z2_llm_vec ON z2_llm_analysis (embedding)
    ORGANIZATION NEIGHBOR PARTITIONS
    DISTANCE COSINE
    WITH TARGET ACCURACY 95;

-- Z2-2. 실행 플랜 (LLM이 세팅, 룰엔진이 실행)
CREATE TABLE z2_execution_plan (
    id               NUMBER GENERATED ALWAYS AS IDENTITY,
    symbol           VARCHAR2(20)  NOT NULL,
    created_at       TIMESTAMP     DEFAULT SYSTIMESTAMP,
    valid_until      TIMESTAMP     NOT NULL,
    direction        VARCHAR2(5)   NOT NULL,  -- 'LONG','SHORT'
    entry_conditions JSON          NOT NULL,  -- 진입 조건들 (룰엔진이 평가)
    target_price     NUMBER,
    stop_price       NUMBER,                  -- 고정 안전망 손절가
    stop_conditions  JSON,                    -- 논리 무효화 조건들
    time_stop_min    NUMBER        DEFAULT 30, -- 시간 손절 (분)
    confidence       NUMBER,
    reasoning        CLOB,                    -- LLM 판단 근거
    scenario_id      VARCHAR2(50),            -- 시나리오 참조 ID
    status           VARCHAR2(15)  DEFAULT 'ACTIVE',
                                              -- 'ACTIVE','TRIGGERED','EXPIRED','CANCELLED'
    triggered_at     TIMESTAMP,
    CONSTRAINT pk_z2_plan PRIMARY KEY (id),
    CONSTRAINT chk_z2_plan_dir CHECK (direction IN ('LONG', 'SHORT')),
    CONSTRAINT chk_z2_plan_st CHECK (status IN ('ACTIVE','TRIGGERED','EXPIRED','CANCELLED','FAILED'))
);

CREATE INDEX idx_z2_plan_active ON z2_execution_plan (status, symbol);

-- ========== Zone 3: Execution ==========

-- Z3-1. 포지션 논리 검증 로그
CREATE TABLE z3_logic_checks (
    id              NUMBER GENERATED ALWAYS AS IDENTITY,
    position_id     NUMBER        NOT NULL,
    ts              TIMESTAMP     DEFAULT SYSTIMESTAMP,
    check_result    JSON          NOT NULL,   -- 각 근거별 유효/무효 판정
    valid_count     NUMBER,
    invalid_count   NUMBER,
    recommendation  VARCHAR2(20),             -- 'HOLD','PARTIAL_EXIT','FULL_EXIT'
    CONSTRAINT pk_z3_logic PRIMARY KEY (id)
);

CREATE INDEX idx_z3_logic_pos ON z3_logic_checks (position_id, ts);

-- ========== Zone 4: Results ==========

-- Z4-1. 포지션
CREATE TABLE z4_positions (
    id               NUMBER GENERATED BY DEFAULT AS IDENTITY,
    symbol           VARCHAR2(20)  NOT NULL,
    direction        VARCHAR2(5)   NOT NULL,  -- 'LONG','SHORT'
    entry_price      NUMBER        NOT NULL,
    qty              NUMBER,                  -- 진입 수량
    target_price     NUMBER,                  -- 목표가
    safety_stop      NUMBER,                  -- 안전 손절가
    time_stop_min    NUMBER        DEFAULT 480, -- 시간 손절 (분, 기본 8시간)
    entry_time       TIMESTAMP     NOT NULL,
    entry_reasoning  JSON,                    -- 진입 시 근거
    exit_price       NUMBER,
    exit_time        TIMESTAMP,
    exit_reason      VARCHAR2(20),            -- 'TARGET','INVALIDATION','TIME_STOP','MANUAL','SAFETY_STOP'
    exit_details     JSON,                    -- 청산 상세 (무효화된 근거 목록 등)
    pnl_pct          NUMBER,
    pnl_amount       NUMBER,                  -- USDT 기준 손익
    plan_id          NUMBER,                  -- z2_execution_plan 참조
    status           VARCHAR2(20)  DEFAULT 'OPEN',
                                              -- 'OPEN','CLOSED','ERROR','MANUAL_REVIEW'
    candle_data      CLOB,                    -- 거래 1초봉 데이터 (JSON)
    candle_post_exit NUMBER(1)     DEFAULT 0, -- 후행 캡처 완료 플래그
    CONSTRAINT pk_z4_pos PRIMARY KEY (id),
    CONSTRAINT chk_z4_pos_dir CHECK (direction IN ('LONG', 'SHORT'))
);

CREATE INDEX idx_z4_pos_open ON z4_positions (status, symbol);

-- Z4-2. 거래 상세 로그
CREATE TABLE z4_trade_log (
    id               NUMBER GENERATED BY DEFAULT AS IDENTITY,
    position_id      NUMBER        NOT NULL,
    ts               TIMESTAMP     DEFAULT SYSTIMESTAMP,
    action           VARCHAR2(10)  NOT NULL,  -- 'ENTRY','EXIT','PARTIAL_EXIT'
    symbol           VARCHAR2(20)  NOT NULL,
    side             VARCHAR2(5)   NOT NULL,  -- 'BUY','SELL'
    price            NUMBER        NOT NULL,
    qty              NUMBER        NOT NULL,
    fee_amount       NUMBER        DEFAULT 0,
    fee_rate         NUMBER        DEFAULT 0.04, -- %
    slippage_bps     NUMBER        DEFAULT 0,
    order_id         VARCHAR2(50),            -- 거래소 주문 ID
    CONSTRAINT pk_z4_trade PRIMARY KEY (id)
);

CREATE INDEX idx_z4_trade_pos ON z4_trade_log (position_id);

-- Z4-3. 성과 집계
CREATE TABLE z4_performance (
    period_type      VARCHAR2(10)  NOT NULL,  -- 'DAILY','WEEKLY','MONTHLY'
    period_start     DATE          NOT NULL,
    total_trades     NUMBER        DEFAULT 0,
    winning_trades   NUMBER        DEFAULT 0,
    losing_trades    NUMBER        DEFAULT 0,
    win_rate         NUMBER,                  -- %
    total_pnl        NUMBER        DEFAULT 0, -- USDT
    total_pnl_pct    NUMBER        DEFAULT 0, -- %
    avg_win_pct      NUMBER,
    avg_loss_pct     NUMBER,
    max_drawdown_pct NUMBER,
    profit_factor    NUMBER,                  -- 총이익/총손실
    sharpe_ratio     NUMBER,
    CONSTRAINT pk_z4_perf PRIMARY KEY (period_type, period_start)
);

-- ========== System Config ==========
CREATE TABLE sys_config (
    key              VARCHAR2(50)  NOT NULL,
    value            VARCHAR2(500),
    description      VARCHAR2(200),
    updated_at       TIMESTAMP     DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_sys_config PRIMARY KEY (key)
);

-- 초기 설정값 삽입
INSERT INTO sys_config (key, value, description) VALUES ('MAX_POSITION_PCT', '2', '1회 투자 최대 자본비율 (%)');
INSERT INTO sys_config (key, value, description) VALUES ('MAX_DAILY_LOSS_PCT', '5', '일일 최대 손실 한도 (%)');
INSERT INTO sys_config (key, value, description) VALUES ('MAX_LEVERAGE', '3', '최대 레버리지');
INSERT INTO sys_config (key, value, description) VALUES ('MAX_CONCURRENT_POSITIONS', '3', '동시 포지션 제한');
INSERT INTO sys_config (key, value, description) VALUES ('CONFIDENCE_THRESHOLD', '0.6', 'LLM 최소 확신도');
INSERT INTO sys_config (key, value, description) VALUES ('SAFETY_STOP_PCT', '2', '고정 안전망 손절 (%)');
INSERT INTO sys_config (key, value, description) VALUES ('FEE_RATE_TAKER', '0.04', '테이커 수수료 (%)');
INSERT INTO sys_config (key, value, description) VALUES ('INITIAL_CAPITAL', '10000', '초기 자본 (USDT)');

COMMIT;
