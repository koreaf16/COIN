# 01. 5-Zone 아키텍처 개요

## 설계 원칙

시스템의 핵심 원칙은 세 가지다.

1. `LLM은 계획을 만든다`
2. `실행 엔진은 계획을 기계적으로 집행한다`
3. `청산과 기록은 별도 계층에서 관리한다`

이 분리를 통해 느린 LLM 호출과 빠른 실시간 매매 루프를 직접 결합하지 않는다.

## 5-Zone 흐름

### Zone 0: Raw Data

- Binance WS/REST, 뉴스, 매크로 데이터를 수집한다.
- `RingBuffer`에 실시간 가격, 체결, Kline, 파생 데이터를 유지한다.
- 현재 스윙 구조 계산에 필요한 `1h`, `4h`, `1d` Kline을 메모리에 유지한다.

### Zone 1: Processed Data

- ATR, OI Matrix, 변동성 구간, 상태 벡터를 만든다.
- Oracle Vector Search를 이용해 유사 시장 상태를 찾는다.

### Zone 2: Intelligence

- Python LLM 서비스가 시장 스냅샷을 만들고 Unified Plan을 생성한다.
- 스냅샷에는 파생 데이터뿐 아니라 `daily_bias`, `trend_bias_4h`, `trigger_bias_1h`, `pullback/breakout/retest` 계열 구조 필드가 포함된다.
- 저장 전 검증 단계에서 최소 신뢰도, 최소 손절 거리, 최소 손익비, 구조 필드 포함 여부를 강제한다.

### Zone 3: Execution

- Rule Engine이 활성 플랜과 현재 시장 데이터를 비교해 진입 시그널을 만든다.
- 현재 데이터에는 파생 지표와 함께 스윙 구조 피처가 포함된다.
- Risk Gate가 `손절폭 기반 사이징`을 계산한다.
- 진입 성공 시 플랜은 즉시 `TRIGGERED` 처리된다.
- Smart Exit가 ATR, 모멘텀, 시간 손절, LLM 무효화, 부분 청산을 관리한다.

### Zone 4: Results

- `ENTRY`, `PARTIAL_EXIT`, `EXIT`를 DB에 기록한다.
- 부분 청산 누적 손익과 수수료가 최종 성과에 반영된다.
- 진입 당시 `entryConditions`와 reasoning이 `entry_reasoning` JSON에 저장된다.

## 현재 운영상 중요한 구현 포인트

- `1d -> 4h -> 1h` 구조 계층이 실제 런타임 의사결정에 반영된다.
- `stop distance`가 포지션 크기에 직접 반영된다.
- 플랜 중복 재사용 문제가 제거되었다.
- 부분 청산이 로그와 성과 집계에 반영된다.
- 운영 API가 플랜 구조와 현재 구조를 함께 보여준다.

## 현재 남아 있는 큰 제약

- 진입 주문은 아직 `시장가` 중심이다.
- `planned scale-in` 모델은 아직 없다.
- 지지/저항 + 거래량 조합을 별도 강제 규칙으로 묶지는 않았다.

## 주요 디렉토리

```text
src/
  shared/         공통 설정, DB, 로거, query-loader
  z0-raw/         원천 데이터 수집, RingBuffer
  z1-processed/   상태 벡터, 가공 지표
  z2-intel/       LLM 스케줄러, Oracle 연동
  z3-exec/        Rule Engine, Risk Gate, Executor, Smart Exit
  z4-results/     거래 기록, 성과 추적
  api/            REST API
  schema/         Oracle SQL, 테이블 정의

python-llm/       FastAPI 기반 LLM 서비스
dashboard/        운영 대시보드
docs/             운영 문서
scripts/          테스트/점검/분석 스크립트
```
