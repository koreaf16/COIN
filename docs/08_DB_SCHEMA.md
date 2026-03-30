# 08. 데이터베이스 스키마 요약

현재 시스템은 Oracle 23c를 기준으로 동작한다.
JSON과 Vector 타입을 함께 사용한다.

## Zone 0: Raw Data

- `z0_price_ohlcv`: Kline, 거래량, CVD 관련 원천 데이터
- `z0_derivatives`: OI, 펀딩비, 롱/숏 비율
- `z0_liquidation_raw`: 청산 체결
- `z0_macro_data`: DXY, VIX 등 매크로 지표
- `z0_news_raw`: 뉴스 원문

## Zone 1: Processed Data

- `z1_market_states`: 상태 벡터와 향후 수익률 백필 값
- `z1_liquidation_map`: 가격대별 청산 맵
- `z1_volatility_regime`: ATR, BB width 기반 변동성 상태
- `z1_oi_matrix`: 가격/OI 조합 해석

## Zone 2: Intelligence

### `z2_llm_analysis`

- 브리핑, 시나리오, 감성 분석 결과 저장
- `result JSON`
- `embedding VECTOR(1024, FLOAT64)` 사용 가능

### `z2_execution_plan`

- 실행 계획 저장
- 핵심 컬럼:
  - `entry_conditions JSON`
  - `stop_conditions JSON`
  - `target_price`
  - `stop_price`
  - `time_stop_min`
  - `confidence`
  - `status`
  - `triggered_at`

현재 `entry_conditions`에는 구조 필드가 실제로 들어갈 수 있다.

## Zone 3: Execution

### `z3_logic_checks`

- 보유 중 LLM 논리 검증 결과 저장
- `recommendation`은 `HOLD`, `PARTIAL_EXIT`, `FULL_EXIT`

## Zone 4: Results

### `z4_positions`

포지션 단위 테이블.

핵심 컬럼:

- `status`
- `entry_price`, `exit_price`
- `qty`
- `target_price`, `safety_stop`, `time_stop_min`
- `plan_id`
- `entry_reasoning JSON`
- `pnl_pct`, `pnl_amount`
- `exit_reason`, `exit_details`

### `z4_trade_log`

체결 단위 로그.

핵심 컬럼:

- `position_id`
- `action`
- `side`
- `price`
- `qty`
- `fee_amount`
- `fee_rate`

현재 `action`에는 `PARTIAL_EXIT`가 포함된다.

## 현재 스키마 관점의 특징

- `계획`과 `실행 결과`가 분리돼 있다.
- `entry_reasoning JSON`으로 진입 근거를 복구할 수 있다.
- 부분 청산이 포지션 테이블과 체결 로그 양쪽에 반영된다.
- Vector Search와 JSON 조건식을 함께 사용하는 구조다.
