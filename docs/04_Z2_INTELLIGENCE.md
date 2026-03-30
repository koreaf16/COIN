# 04. Zone 2 (Intelligence)

Zone 2는 `느린 판단 계층`이다.
실시간 체결 루프에 직접 개입하지 않고, 일정 주기로 시장을 요약해 실행 가능한 계획을 만든다.

## 역할

- 뉴스/매크로/시장 스냅샷 수집
- Unified Plan 생성
- 스윙 구조 필드 계산
- 계획 저장 전 검증
- 최근 손실, 유사 상태, 브리핑을 프롬프트에 반영

## 핵심 구성

### `scheduler.js`

- 심볼 배치별로 Unified Plan 생성을 호출한다.
- 유의미한 변화가 적으면 기존 플랜의 `valid_until`만 연장한다.
- 결과는 `z2_execution_plan`에 저장한다.

### `oracle_reader.py`

- 단순 가격/펀딩/OI만 읽지 않는다.
- `1h`, `4h`, `1d` 캔들과 BTC 기준 캔들을 함께 읽어서 구조 스냅샷을 만든다.

현재 스냅샷에 포함되는 대표 필드:

- `daily_bias`
- `trend_bias_4h`
- `trigger_bias_1h`
- `btc_daily_bias`
- `support_distance_pct`
- `resistance_distance_pct`
- `range_position_20`
- `donchian_break_20`
- `pullback_long_setup`
- `pullback_short_setup`
- `breakout_long_setup`
- `breakout_short_setup`
- `retest_support_ready`
- `retest_resistance_ready`

### `market_structure.py`

- EMA 정렬
- bias 분류
- support/resistance 거리
- breakout / retest / pullback setup
- BTC 상대 강도

를 계산한다.

## Unified Plan 프롬프트 규칙

Unified Plan 프롬프트는 현재 다음을 명시적으로 요구한다.

- `4h ~ 48h` 보유 기준
- `daily_bias -> trend_bias_4h -> trigger_bias_1h` 정렬
- 구조 필드 사용
- 최소 손절 거리
- 최소 손익비
- 비어 있지 않은 `stop_conditions`

예시 스키마도 구조 필드가 포함된 형태로 제공한다.

## 저장 전 검증

### Python 검증기

`validator_fixed.py`는 Unified Plan에 대해 다음을 본다.

- 방향 유효성
- entry/stop 조건 구조
- 신뢰도
- 손절 거리
- 손익비
- 구조 필드 포함 여부
- 현재 상위 시간대와의 정합성

### Node 스케줄러 검증

`scheduler.js`는 저장 직전에 다시 한 번 검증한다.

- `entry_conditions` 정상화
- 구조 필드 존재 여부
- counter-trend 여부
- 최소 손절 거리
- 최소 손익비

즉, 프롬프트가 잘못 생성해도 저장 단계에서 한 번 더 걸러진다.

## 현재 상태 평가

현재 Z2는 단순 파생지표 기반 계획 생성 단계를 넘어서, `스윙 구조를 반영하는 계획 생성 계층`으로 동작한다.

남아 있는 제약:

- 계획이 `pullback`인지 `breakout`인지에 따라 서로 다른 주문 방식까지 분기하진 않는다.
- RSI는 아직 주로 프롬프트 레벨 제약이다.
