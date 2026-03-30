# 05. Zone 3 (Execution)

Zone 3는 `빠른 집행 계층`이다.
활성 플랜을 읽고, 현재 시장 상태와 비교해 진입/청산을 수행한다.

## 1. Rule Engine

핵심 파일:

- `src/z3-exec/rule-engine.js`
- `src/z3-exec/condition-evaluator.js`

### 현재 입력 데이터

Rule Engine은 단순 가격만 보지 않는다.

- 가격
- 펀딩비
- OI 변화
- 청산량
- CVD 방향
- 거래량 급증
- `daily_bias`
- `trend_bias_4h`
- `trigger_bias_1h`
- support/resistance 거리
- breakout / pullback / retest setup

### 구조 가드

시그널이 발생해도 다음 경우는 차단한다.

- LONG인데 `daily_bias=BEARISH`
- LONG인데 `trend_bias_4h=BEARISH`
- SHORT인데 `daily_bias=BULLISH`
- SHORT인데 `trend_bias_4h=BULLISH`

예외는 `confidence >= 0.9`의 공격적 counter-trend 플랜뿐이다.

## 2. Risk Gate

핵심 파일:

- `src/z3-exec/risk-gate-fixed.js`

현재 포지션 금액은 `고정 비율`이 아니라 `손절폭 기반`으로 계산한다.

기본 개념:

`허용 손실금 / 손절폭 = 포지션 금액`

추가 제약:

- `MAX_POSITION_PCT` 상한
- `MAX_RISK_PCT`
- 일일 손실 제한
- 동시 포지션 수 제한
- 레버리지 상한

## 3. Executor

핵심 파일:

- `src/z3-exec/executor.js`
- `src/z3-exec/executor-trade.js`
- `src/z3-exec/executor-sync.js`

현재 진입 플로우:

1. Risk Gate 검증
2. 슬리피지 체크
3. 전략에 맞는 진입 주문 타입 결정
4. 진입 주문 실행
4. 보호성 `stop market` 주문 배치
5. 목표가가 있으면 `take profit` 주문 배치
6. 메모리와 DB에 포지션 기록
7. 플랜을 `TRIGGERED` 처리

현재 지원 방식:

- `LIMIT`: 눌림/리테스트 성격의 가격 조건
- `MARKET`: 즉시 진입 또는 breakout trigger 충족 시
- live limit 주문은 일정 시간 대기 후 미체결 시 `market fallback`

현재 제약:

- `planned scale-in`은 지원하지 않는다.
- 사전 배치형 `stop-entry` 주문을 플랜 단계에서 미리 걸어두진 않는다.

## 4. 복구

재시작 시:

- DB의 `OPEN` 포지션을 읽는다.
- 거래소 포지션과 동기화한다.
- `entry_reasoning`에서 진입 당시 `entryConditions`를 복원한다.
- Smart Exit를 다시 붙인다.

## 5. 운영 API / 모니터링

현재 구조 요약은 다음 API에서 노출된다.

- `/api/plans`
- `/api/plans/:id`
- `/api/plans/status`
- `/api/positions/live`
- `/api/dashboard`

응답의 `structure` 필드는 보통 다음을 포함한다.

- `current`: 현재 상위/트리거 구조
- `plan`: 플랜이 요구한 구조 조건
- `hasHigherTimeframePlan`
- `hasTriggerPlan`
- `aligned`
- `blockReason`

이로 인해 운영자는 `플랜은 무엇을 요구했고`, `지금 구조는 어떤지`를 API 응답만으로 볼 수 있다.
