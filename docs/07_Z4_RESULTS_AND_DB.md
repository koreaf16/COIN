# 07. Zone 4 (Results) & 기록 체계

Zone 4는 거래 결과를 남기고, 성과를 계산하며, 이후 분석에 필요한 데이터를 축적한다.

## 핵심 파일

- `src/z4-results/trade-recorder.js`
- `src/z4-results/performance-tracker.js`

## 기록되는 이벤트

현재 시스템은 최소 다음 이벤트를 기록한다.

- `ENTRY`
- `PARTIAL_EXIT`
- `EXIT`

## 현재 기록 방식

### `z4_positions`

포지션 단위의 최종 상태를 유지한다.

주요 내용:

- 진입 가격 / 진입 시각
- 목표가 / safety stop / time stop
- plan_id
- entry_reasoning JSON
- 최종 손익
- 최종 청산 사유

`entry_reasoning`에는 reasoning뿐 아니라 `entryConditions`도 포함될 수 있다.

### `z4_trade_log`

체결 이벤트를 leg 단위로 기록한다.

현재 action 값:

- `ENTRY`
- `PARTIAL_EXIT`
- `EXIT`

## 부분 청산 반영

이전과 달리 현재는 부분 청산이 성과 집계에서 누락되지 않는다.

- `PARTIAL_EXIT`가 `z4_trade_log`에 기록된다.
- `z4_positions`의 누적 손익과 safety stop이 갱신된다.
- 최종 `EXIT`는 누적 실현 손익을 포함한 값으로 닫힌다.
- 서버 재기동 후에도 누적 손익을 복구한다.

## 운영상 의미

이제 다음 질문에 DB 기준으로 답할 수 있다.

- 부분 청산 후 최종 결과가 어땠는가
- 어느 지점에서 safety stop이 끌어올려졌는가
- 진입 당시 어떤 조건으로 들어갔는가
- LLM 무효화 검증이 몇 번 발생했는가
