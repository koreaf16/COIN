# 06. Zone 3 (Smart Exit)

Smart Exit는 `진입 이후`를 책임지는 계층이다.
가격 기반 청산과 LLM 기반 논리 무효화 검증을 함께 운영한다.

## 가격 기반 청산

핵심 파일:

- `src/z3-exec/smart-exit.js`

현재 사용하는 주요 가격 기반 청산 사유:

- `SAFETY_STOP`: 보호 손절 도달
- `ATR_TARGET`: ATR 기반 목표 도달
- `TARGET`: 플랜 목표가 도달
- `TRAILING_STOP`: 최고 수익 대비 되돌림 발생
- `MOMENTUM_REVERSAL`: 보유 방향과 반대 캔들 흐름 누적
- `TIME_STOP`: 보유 시간이 동적 한도를 초과
- `EMERGENCY_EXIT`: 시간이 많이 지났고 손실 상태에서 모멘텀까지 꺾임

## LLM 기반 논리 검증

`validate-position` 경로는 진입 당시 reasoning과 현재 스냅샷을 비교해 다음을 돌려준다.

- `HOLD`
- `PARTIAL_EXIT`
- `FULL_EXIT`

이 결과는 `z3_logic_checks`에 기록된다.

## 부분 청산

현재 부분 청산은 실제 운영 흐름에 반영된다.

- LLM이 `PARTIAL_EXIT`를 권고하면 절반 청산을 시도한다.
- 부분 청산 후 남은 물량의 `safetyStop`은 보통 `entryPrice`로 올린다.
- 부분 청산 실현 손익과 수수료는 누적된다.
- 최종 `EXIT`는 마지막 leg만이 아니라 전체 트레이드 누적 손익으로 닫힌다.

## 복구와 일관성

재시작 후 포지션 복구 시 다음 상태를 함께 복원한다.

- 초기 수량
- 누적 실현 손익
- 누적 수수료
- 부분 청산 여부
- 진입 당시 entryConditions

즉, Smart Exit는 단순한 가격 알람이 아니라 `지속 상태를 가진 청산 엔진`으로 동작한다.
